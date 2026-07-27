// Pemrosesan baris webhook_events (source='xendit') — dipanggil worker, BUKAN
// di request cycle (§5.4: balas 200 dulu, proses kemudian).
import type pg from "pg";
import type { XenditWebhookPayload } from "./xendit.server";
import {
  applyChargeFailure,
  applyChargeSuccess,
  logEvent,
  notifySafe,
  resumeSubscription,
} from "./subscription-lifecycle.server";
import { emitKlaviyoEvent } from "./klaviyo.server";

export async function processXenditWebhook(db: pg.Pool, payload: XenditWebhookPayload): Promise<void> {
  switch (payload.event) {
    case "payment.capture": {
      const charge = await findCharge(db, payload);
      if (!charge) {
        throw new Error(`payment.capture tanpa charge yang cocok: ${JSON.stringify(payload.data)}`);
      }
      // Sesi charge pertama ikut menyimpan metode → tempelkan token ke langganan.
      const tokenId = payload.data.payment_token_id;
      if (tokenId) {
        await db.query(
          "update subscriptions set xendit_token_id = $1 where id = $2",
          [tokenId, charge.subscription_id],
        );
      }
      if (!charge.xendit_charge_id) {
        const externalId = payload.data.payment_id ?? payload.data.payment_request_id ?? null;
        if (externalId) {
          await db.query(
            "update charges set xendit_charge_id = $1 where id = $2 and xendit_charge_id is null",
            [externalId, charge.id],
          );
          charge.xendit_charge_id = externalId;
        }
      }
      await applyChargeSuccess(db, {
        id: charge.id,
        subscription_id: charge.subscription_id,
        scheduled_for: charge.scheduled_for,
        xendit_charge_id: charge.xendit_charge_id ?? "unknown",
      });
      return;
    }

    case "payment.failure": {
      const charge = await findCharge(db, payload);
      if (!charge) {
        // Kegagalan sesi checkout yang tidak pernah tercatat — biarkan job
        // cleanup-abandoned yang membereskan baris pending-nya.
        console.warn("[xendit-webhook] payment.failure tanpa charge yang cocok", payload.data);
        return;
      }
      await applyChargeFailure(
        db,
        {
          id: charge.id,
          subscription_id: charge.subscription_id,
          scheduled_for: charge.scheduled_for,
        },
        payload.data.failure_code,
      );
      return;
    }

    case "payment.authorization":
      // capture_method AUTOMATIC — payment.capture yang jadi sumber kebenaran.
      return;

    case "payment_session.completed":
    case "payment_token.activation": {
      const tokenId = payload.data.payment_token_id;
      if (!tokenId) return;
      // reference_id sesi SAVE = relink_<subscription_id>_<ts>
      const relinkMatch = /^relink_([0-9a-f-]{36})_/.exec(payload.data.reference_id ?? "");
      const sub = relinkMatch
        ? (await db.query("select * from subscriptions where id = $1", [relinkMatch[1]])).rows[0]
        : await findSubscriptionForToken(db, payload);
      if (!sub) return;

      const hadToken = sub.xendit_token_id !== null;
      await db.query("update subscriptions set xendit_token_id = $1 where id = $2", [tokenId, sub.id]);
      await logEvent(db, sub.id, "token_activated", "system", {
        payment_token_id: tokenId,
        channel_code: payload.data.channel_code ?? null,
        event: payload.event,
      });

      // §7.6: paused KARENA token mati (token null) → resume otomatis, tetap H+3.
      if (sub.status === "paused" && !hadToken) {
        const { rows } = await db.query("select * from subscriptions where id = $1", [sub.id]);
        try {
          await resumeSubscription(db, rows[0], "system");
        } catch (err) {
          console.error("[xendit-webhook] auto-resume gagal", err);
        }
      }
      return;
    }

    case "payment_token.failure": {
      // Tokenisasi gagal — jangan buat langganan setengah jadi (§5.4). Baris
      // subscriptions tanpa charge sukses akan dihapus job cleanup-abandoned.
      const sub = await findSubscriptionForToken(db, payload);
      await logEvent(db, sub?.id ?? null, "token_failure", "system", payload.data);
      return;
    }

    case "payment_token.expiry": {
      // Token mati → paused + notif re-link. JANGAN cancel (§5.4).
      const sub = await findSubscriptionForToken(db, payload);
      if (!sub) return;
      await db.query(
        `update subscriptions
            set status = 'paused', paused_at = now(),
                next_charge_date = null, next_attempt_at = null,
                xendit_token_id = null
          where id = $1 and status <> 'cancelled'`,
        [sub.id],
      );
      await logEvent(db, sub.id, "token_expired", "system", {
        payment_token_id: payload.data.payment_token_id,
      });
      await notifySafe(db, { id: sub.id }, null, "token_expiring", () =>
        emitKlaviyoEvent("Token Expiring", sub.email, {
          subscription_id: sub.id,
          expired: true,
        }, sub.phone_e164),
      );
      return;
    }

    default:
      console.warn(`[xendit-webhook] event tidak dikenal: ${(payload as { event: string }).event}`);
  }
}

interface ChargeRow {
  id: string;
  subscription_id: string;
  scheduled_for: string;
  attempt_n: number;
  xendit_charge_id: string | null;
}

/** reference_id = charges.idempotency_key (rantai idempotensi §9.1). */
async function findCharge(db: pg.Pool, payload: XenditWebhookPayload): Promise<ChargeRow | null> {
  const ref = payload.data.reference_id;
  if (ref) {
    const { rows } = await db.query("select * from charges where idempotency_key = $1", [ref]);
    if (rows.length) return rows[0];
  }
  const externalId = payload.data.payment_id ?? payload.data.payment_request_id;
  if (externalId) {
    const { rows } = await db.query("select * from charges where xendit_charge_id = $1", [externalId]);
    if (rows.length) return rows[0];
  }
  return null;
}

async function findSubscriptionForToken(db: pg.Pool, payload: XenditWebhookPayload) {
  const tokenId = payload.data.payment_token_id;
  if (tokenId) {
    const { rows } = await db.query("select * from subscriptions where xendit_token_id = $1", [tokenId]);
    if (rows.length) return rows[0];
  }
  // customer reference_id di payload token = shopify_customer_gid (§5.2)
  const custRef = (payload.data.customer as { reference_id?: string } | undefined)?.reference_id;
  if (custRef) {
    const { rows } = await db.query(
      "select * from subscriptions where shopify_customer_gid = $1 order by created_at desc limit 1",
      [custRef],
    );
    if (rows.length) return rows[0];
  }
  return null;
}
