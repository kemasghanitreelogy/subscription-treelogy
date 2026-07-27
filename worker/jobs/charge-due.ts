// F2 · Charge berulang (§7.2). Urutan per baris SAKRAL:
//   klaim (SKIP LOCKED) → majukan next_attempt_at DULU → insert charges →
//   panggil Xendit → simpan hasil. Kebenaran dijaga charges_one_success_per_cycle.
import type pg from "pg";
import { withTransaction, isUniqueViolation } from "../../app/db/client.server";
import {
  addDaysWIB,
  atHourWIB,
  idempotencyKey,
  todayWIB,
  totalAmountIdr,
} from "../../app/services/schedule.server";
import { createOffSessionCharge, XenditError } from "../../app/services/xendit.server";
import {
  applyChargeFailure,
  applyChargeSuccess,
  logEvent,
  type SubscriptionRow,
} from "../../app/services/subscription-lifecycle.server";

const BATCH = 20;
const RECLAIM_MINUTES = 15;

export async function chargeDue(db: pg.Pool): Promise<number> {
  // 1+2 · Klaim batch dan majukan next_attempt_at SEBELUM panggilan jaringan —
  // proses yang mati di tengah tidak membuat baris diklaim ulang tiap 5 menit.
  const claimed = await withTransaction(db, async (tx) => {
    const { rows } = await tx.query(
      `select * from subscriptions
        where status in ('active', 'dunning')
          and next_attempt_at <= now()
          and xendit_token_id is not null
        order by next_attempt_at
        limit $1
        for update skip locked`,
      [BATCH],
    );
    if (rows.length) {
      await tx.query(
        `update subscriptions set next_attempt_at = now() + interval '${RECLAIM_MINUTES} minutes'
          where id = any($1::uuid[])`,
        [rows.map((r) => r.id)],
      );
    }
    return rows as SubscriptionRow[];
  });

  for (const sub of claimed) {
    try {
      await chargeOne(db, sub);
    } catch (err) {
      console.error(`[charge-due] ${sub.id} gagal tak terduga`, err);
    }
  }
  return claimed.length;
}

async function chargeOne(db: pg.Pool, sub: SubscriptionRow): Promise<void> {
  const cycle = sub.next_charge_date!;

  // Sudah ada charge sukses siklus ini? (worker overlap / webhook lebih cepat)
  const { rows: succeeded } = await db.query(
    `select 1 from charges where subscription_id = $1 and scheduled_for = $2 and status = 'succeeded'`,
    [sub.id, cycle],
  );
  if (succeeded.length) return;

  const { rows: attempts } = await db.query(
    `select coalesce(max(attempt_n), 0)::int as max_n,
            count(*) filter (where status = 'pending')::int as pending_n
       from charges where subscription_id = $1 and scheduled_for = $2`,
    [sub.id, cycle],
  );
  if (attempts[0].pending_n > 0) return; // charge in-flight (menunggu webhook e-wallet)
  const attemptN: number = attempts[0].max_n + 1;

  // 3 · Gate H-3 🔒 (§7.3): percobaan pertama siklus tanpa reminder → TUNDA, jangan tagih.
  if (attemptN === 1) {
    const { rows: notified } = await db.query(
      `select 1 from notifications
        where subscription_id = $1 and charge_cycle = $2 and kind = 'precharge_h3'`,
      [sub.id, cycle],
    );
    if (!notified.length) {
      const pushedTo = addDaysWIB(todayWIB(), 3);
      await db.query(
        `update subscriptions set next_charge_date = $1, next_attempt_at = $2 where id = $3`,
        [pushedTo, atHourWIB(pushedTo), sub.id],
      );
      await logEvent(db, sub.id, "charge_deferred_h3", "system", { from: cycle, to: pushedTo });
      console.error(`[ALERT] Charge ditunda: reminder H-3 belum terkirim — sub ${sub.id}`);
      return;
    }
  }

  const amountIdr = totalAmountIdr(sub.unit_amount_idr, sub.quantity, sub.shipping_amount_idr);
  const referenceId = idempotencyKey(sub.id, cycle, attemptN);

  let insertedRows: Array<{ id: string }>;
  try {
    const result = await db.query(
      `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr, idempotency_key)
       values ($1, $2, $3, 'pending', $4, $5)
       on conflict do nothing
       returning id`,
      [sub.id, cycle, attemptN, amountIdr, referenceId],
    );
    insertedRows = result.rows;
  } catch (err) {
    if (isUniqueViolation(err)) return; // sudah ada yang memproses — lewati
    throw err;
  }
  if (!insertedRows.length) return; // sudah ada yang memproses — lewati
  const chargeId: string = insertedRows[0].id;

  try {
    const result = await createOffSessionCharge({
      referenceId,
      paymentTokenId: sub.xendit_token_id!,
      amountIdr,
      metadata: { subscription_id: sub.id, cycle, attempt: String(attemptN) },
    });

    await db.query(
      `update charges set xendit_charge_id = coalesce(xendit_charge_id, $1) where id = $2`,
      [result.payment_request_id, chargeId],
    );

    if (result.status === "SUCCEEDED") {
      await applyChargeSuccess(db, {
        id: chargeId,
        subscription_id: sub.id,
        scheduled_for: cycle,
        xendit_charge_id: result.payment_request_id,
      });
    } else if (result.status === "FAILED") {
      await applyChargeFailure(db, { id: chargeId, subscription_id: sub.id, scheduled_for: cycle }, result.failure_code);
    }
    // PENDING dsb. (e-wallet asinkron): biarkan 'pending' — webhook yang menyelesaikan (§5.3).
  } catch (err) {
    if (err instanceof XenditError && err.status < 500) {
      // 4xx deterministik (mis. token tidak sah) — kegagalan riil.
      const code =
        (err.body as { failure_code?: string; error_code?: string } | null)?.failure_code ??
        (err.body as { error_code?: string } | null)?.error_code;
      await applyChargeFailure(db, { id: chargeId, subscription_id: sub.id, scheduled_for: cycle }, code);
      return;
    }
    // 5xx / jaringan (§7.5): BUKAN attempt dunning. Tandai abandoned, retry
    // +15 menit sudah terpasang dari klaim. Diam ke pelanggan — ini masalah kita.
    await db.query(
      `update charges set status = 'abandoned', error_code = 'infra', error_message = $1 where id = $2 and status = 'pending'`,
      [(err instanceof Error ? err.message : String(err)).slice(0, 500), chargeId],
    );
    console.error(`[charge-due] infra error sub ${sub.id} — retry 15 menit`, err);
  }
}
