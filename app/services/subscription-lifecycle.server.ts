// Transisi state langganan (state machine §3.1) + pemrosesan hasil charge.
// Dipakai oleh worker (webhook & charge-due) DAN route portal. Semua jalur uang
// bersandar pada unique constraint di database, bukan pada logika di sini —
// kalau logika bocor, constraint yang menahan (prinsip §0.2).
import type pg from "pg";
import { isUniqueViolation } from "../db/client.server";
import {
  addDaysWIB,
  assertH3Safe,
  atHourWIB,
  nextChargeDate,
  nextDunningAttemptAt,
  todayWIB,
} from "./schedule.server";
import { classifyFailure } from "./xendit.server";
import { getSettings, notificationEnabled } from "./settings.server";
import { createSubscriptionOrder } from "./shopify-order.server";
import { emitKlaviyoEvent } from "./klaviyo.server";

export interface SubscriptionRow {
  id: string;
  shopify_customer_gid: string;
  email: string;
  phone_e164: string | null;
  variant_gid: string;
  quantity: number;
  unit_amount_idr: number;
  shipping_amount_idr: number;
  frequency_days: number;
  status: "active" | "paused" | "dunning" | "cancelled";
  cycle_count: number;
  payment_method: string;
  xendit_token_id: string | null;
  next_charge_date: string | null;
  next_attempt_at: Date | null;
}

export async function logEvent(
  db: pg.Pool | pg.PoolClient,
  subscriptionId: string | null,
  type: string,
  actor: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await db.query("insert into events (subscription_id, type, actor, data) values ($1, $2, $3, $4)", [
    subscriptionId,
    type,
    actor,
    JSON.stringify(data),
  ]);
}

/**
 * Charge sukses TERKONFIRMASI (webhook payment.capture, atau respons sinkron
 * SUCCEEDED). Urutan: tandai charge → order → majukan jadwal → event.
 * Idempoten: charges_one_success_per_cycle + charges_order_uniq menahan dobel.
 */
export async function applyChargeSuccess(
  db: pg.Pool,
  charge: { id: string; subscription_id: string; scheduled_for: string; xendit_charge_id: string },
): Promise<void> {
  try {
    const { rowCount } = await db.query(
      `update charges set status = 'succeeded', settled_at = coalesce(settled_at, now())
        where id = $1 and status <> 'succeeded'`,
      [charge.id],
    );
    if (!rowCount) return; // sudah diproses — webhook dobel
  } catch (err) {
    if (isUniqueViolation(err)) return; // siklus ini sudah punya charge sukses lain
    throw err;
  }

  const { rows } = await db.query("select * from subscriptions where id = $1", [charge.subscription_id]);
  const sub = rows[0] as SubscriptionRow;
  const isFirstCycle = sub.cycle_count === 0;

  // Order dulu, jadwal kemudian. Kalau mati di antaranya: charges_orphaned_idx +
  // job rekonsiliasi menyelesaikan order; charges_one_success_per_cycle mencegah
  // tagihan ulang meski jadwal belum maju.
  let orderGid: string | null = null;
  try {
    orderGid = await createSubscriptionOrder({
      variantGid: sub.variant_gid,
      quantity: sub.quantity,
      email: sub.email,
      isFirstCycle,
      xenditChargeId: charge.xendit_charge_id,
      subscriptionId: sub.id,
      cycle: charge.scheduled_for,
    });
    await db.query("update charges set shopify_order_gid = $1 where id = $2 and shopify_order_gid is null", [
      orderGid,
      charge.id,
    ]);
  } catch (err) {
    // Charge tetap succeeded; rekonsiliasi §9.3 yang menuntaskan. JANGAN lempar —
    // jadwal tetap harus maju supaya pelanggan tidak tertagih ulang.
    console.error("[lifecycle] orderCreate gagal — masuk antrian rekonsiliasi", err);
  }

  const newNextCharge = nextChargeDate(charge.scheduled_for, sub.frequency_days);
  await db.query(
    `update subscriptions
        set status = 'active',
            cycle_count = cycle_count + 1,
            next_charge_date = $1,
            next_attempt_at = $2
      where id = $3`,
    [newNextCharge, atHourWIB(newNextCharge), sub.id],
  );

  await logEvent(db, sub.id, "charged", "system", {
    cycle: charge.scheduled_for,
    xendit_charge_id: charge.xendit_charge_id,
    order_gid: orderGid,
  });
  await notifySafe(db, sub, charge.scheduled_for, "charge_succeeded", () =>
    emitKlaviyoEvent(isFirstCycle ? "Subscription Created" : "Charge Succeeded", sub.email, {
      subscription_id: sub.id,
      cycle: charge.scheduled_for,
      next_charge_date: newNextCharge,
    }, sub.phone_e164),
  );
}

/**
 * Charge gagal. Masuk dunning / auto-pause sesuai §7.4; kegagalan infra (5xx)
 * TIDAK memakan attempt dunning (§7.5) dan ditangani pemanggil.
 */
export async function applyChargeFailure(
  db: pg.Pool,
  charge: { id: string; subscription_id: string; scheduled_for: string },
  failureCode: string | undefined,
): Promise<void> {
  const { rowCount } = await db.query(
    `update charges set status = 'failed', error_code = $1, settled_at = coalesce(settled_at, now())
      where id = $2 and status = 'pending'`,
    [failureCode ?? null, charge.id],
  );
  if (!rowCount) return; // sudah diproses

  const { rows } = await db.query("select * from subscriptions where id = $1", [charge.subscription_id]);
  const sub = rows[0] as SubscriptionRow;
  if (sub.status === "cancelled") return; // 🔒 retry berhenti total setelah cancel

  const action = classifyFailure(failureCode);

  if (action === "token_dead" || action === "change_method") {
    // Retry percuma — token mati / kartu ditolak permanen. Langsung pause.
    await autoPause(db, sub, charge.scheduled_for, action);
    return;
  }

  // Tahap dunning = jumlah kegagalan RIIL siklus ini. Baris 'abandoned' (retry
  // infra 5xx) tidak dihitung — kegagalan kita tidak memakan jatah pelanggan (§7.5).
  const { rows: failedRows } = await db.query(
    `select count(*)::int as n from charges
      where subscription_id = $1 and scheduled_for = $2 and status = 'failed'`,
    [charge.subscription_id, charge.scheduled_for],
  );
  const failedCount: number = failedRows[0].n;

  const nextAttempt = nextDunningAttemptAt(failedCount, charge.scheduled_for);
  if (nextAttempt === null) {
    await autoPause(db, sub, charge.scheduled_for, "retries_exhausted");
    return;
  }

  // next_charge_date TIDAK berubah — siklusnya masih siklus yang sama (§3.3).
  await db.query(
    "update subscriptions set status = 'dunning', next_attempt_at = $1 where id = $2",
    [nextAttempt, sub.id],
  );
  await logEvent(db, sub.id, "charge_failed", "system", {
    cycle: charge.scheduled_for,
    failed_count: failedCount,
    error_code: failureCode ?? null,
    next_attempt_at: nextAttempt.toISOString(),
  });

  // Kanal dunning §7.4: WA H0 setelah gagal pertama, WA H2, email H4.
  const dunningKind = failedCount === 1 ? "dunning_h0" : failedCount === 2 ? "dunning_h2" : "dunning_h4";
  await notifySafe(db, sub, charge.scheduled_for, dunningKind, () =>
    emitKlaviyoEvent("Charge Failed", sub.email, {
      subscription_id: sub.id,
      cycle: charge.scheduled_for,
      failed_count: failedCount,
      failure_action: action,
    }, sub.phone_e164),
  );
}

/** 🔒 AUTO-PAUSE, bukan cancel (§7.4) — paused bisa kembali dengan satu ketukan. */
async function autoPause(
  db: pg.Pool,
  sub: SubscriptionRow,
  cycle: string,
  reason: string,
): Promise<void> {
  await db.query(
    `update subscriptions
        set status = 'paused', paused_at = now(), next_charge_date = null, next_attempt_at = null
      where id = $1 and status <> 'cancelled'`,
    [sub.id],
  );
  await logEvent(db, sub.id, "auto_paused", "system", { cycle, reason });
  await notifySafe(db, sub, cycle, "auto_paused", () =>
    emitKlaviyoEvent("Subscription Paused", sub.email, {
      subscription_id: sub.id,
      cycle,
      reason,
      auto: true,
    }, sub.phone_e164),
  );
}

/**
 * Kirim notifikasi tepat-sekali: klaim baris notifications dulu (unique index),
 * baru emit. Kalau emit gagal, klaim dilepas supaya dicoba lagi.
 * Menghormati toggle merchant — KECUALI precharge_h3 yang selalu terkirim 🔒.
 */
export async function notifySafe(
  db: pg.Pool,
  sub: { id: string },
  cycle: string | null,
  kind: string,
  send: () => Promise<void>,
  channel: string = "both",
): Promise<boolean> {
  const settings = await getSettings(db);
  if (!notificationEnabled(settings, kind)) return false;
  const { rows } = await db.query(
    `insert into notifications (subscription_id, charge_cycle, kind, channel)
     values ($1, $2, $3, $4)
     on conflict do nothing
     returning id`,
    [sub.id, cycle, kind, channel],
  );
  if (!rows.length) return false; // sudah pernah terkirim
  try {
    await send();
    return true;
  } catch (err) {
    await db.query("delete from notifications where id = $1", [rows[0].id]);
    throw err;
  }
}

// ── Aksi portal (§7.6) — semua mutasi jadwal lewat assertH3Safe ──────────────

export async function skipCycle(db: pg.Pool, sub: SubscriptionRow, actor: string): Promise<string> {
  if (sub.status !== "active" || !sub.next_charge_date) {
    throw new Error("Skip hanya untuk langganan aktif");
  }
  const newDate = addDaysWIB(sub.next_charge_date, sub.frequency_days);
  await db.query(
    "update subscriptions set next_charge_date = $1, next_attempt_at = $2 where id = $3",
    [newDate, atHourWIB(newDate), sub.id],
  );
  await logEvent(db, sub.id, "skipped", actor, { from: sub.next_charge_date, to: newDate });
  return newDate;
}

export async function pauseSubscription(
  db: pg.Pool,
  sub: SubscriptionRow,
  months: 1 | 2 | 3,
  actor: string,
): Promise<void> {
  if (sub.status === "cancelled") throw new Error("Langganan sudah dibatalkan");
  await db.query(
    "update subscriptions set status = 'paused', paused_at = now(), next_charge_date = null, next_attempt_at = null where id = $1",
    [sub.id],
  );
  await logEvent(db, sub.id, "paused", actor, { months });
}

export async function resumeSubscription(db: pg.Pool, sub: SubscriptionRow, actor: string): Promise<string> {
  if (sub.status !== "paused") throw new Error("Hanya langganan paused yang bisa di-resume");
  if (!sub.xendit_token_id) throw new Error("Metode pembayaran belum terhubung — re-link dulu");
  // 🔒 minimal H+3 dari hari ini (§3.2)
  const newDate = addDaysWIB(todayWIB(), 3);
  assertH3Safe(newDate);
  await db.query(
    "update subscriptions set status = 'active', paused_at = null, next_charge_date = $1, next_attempt_at = $2 where id = $3",
    [newDate, atHourWIB(newDate), sub.id],
  );
  await logEvent(db, sub.id, "resumed", actor, { next_charge_date: newDate });
  return newDate;
}

export async function changeFrequency(
  db: pg.Pool,
  sub: SubscriptionRow,
  newFrequencyDays: number,
  actor: string,
): Promise<string> {
  if (sub.status !== "active") throw new Error("Ubah frekuensi hanya untuk langganan aktif");
  // Hitung ulang dari charge sukses terakhir (§7.6)
  const { rows } = await db.query(
    `select scheduled_for from charges
      where subscription_id = $1 and status = 'succeeded'
      order by scheduled_for desc limit 1`,
    [sub.id],
  );
  const base: string = rows[0]?.scheduled_for ?? todayWIB();
  let newDate = nextChargeDate(base, newFrequencyDays);
  const minimum = addDaysWIB(todayWIB(), 3);
  if (newDate < minimum) newDate = minimum; // jangan pernah melanggar H-3
  assertH3Safe(newDate);
  await db.query(
    "update subscriptions set frequency_days = $1, next_charge_date = $2, next_attempt_at = $3 where id = $4",
    [newFrequencyDays, newDate, atHourWIB(newDate), sub.id],
  );
  await logEvent(db, sub.id, "frequency_changed", actor, {
    from: sub.frequency_days,
    to: newFrequencyDays,
    next_charge_date: newDate,
  });
  return newDate;
}

/** Reschedule tanggal tagihan berikutnya — wajib lolos jaminan H-3 🔒. */
export async function rescheduleSubscription(
  db: pg.Pool,
  sub: SubscriptionRow,
  newDateWIB: string,
  actor: string,
): Promise<string> {
  if (sub.status !== "active") throw new Error("Reschedule hanya untuk langganan aktif");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(newDateWIB)) throw new Error("Format tanggal tidak sah");
  assertH3Safe(newDateWIB);
  await db.query(
    "update subscriptions set next_charge_date = $1, next_attempt_at = $2 where id = $3",
    [newDateWIB, atHourWIB(newDateWIB), sub.id],
  );
  await logEvent(db, sub.id, "rescheduled", actor, { from: sub.next_charge_date, to: newDateWIB });
  return newDateWIB;
}

export async function cancelSubscription(
  db: pg.Pool,
  sub: SubscriptionRow,
  reason: string | null,
  actor: string,
): Promise<void> {
  // 🔒 retry berhenti total — policy menjanjikan ini (§3.1)
  await db.query(
    `update subscriptions
        set status = 'cancelled', cancelled_at = now(), cancel_reason = $1,
            next_charge_date = null, next_attempt_at = null
      where id = $2`,
    [reason, sub.id],
  );
  await logEvent(db, sub.id, "cancelled", actor, { reason });
  await emitKlaviyoEvent("Subscription Cancelled", sub.email, {
    subscription_id: sub.id,
    reason,
  }, sub.phone_e164).catch((err) => console.error("[lifecycle] klaviyo cancel event", err));
}
