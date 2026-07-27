// F6 · Nudge token kedaluwarsa (§7.7): tangkap kegagalan SEBELUM terjadi.
// Kunci exactly-once per (sub, tanggal kedaluwarsa) — token baru = nudge baru.
import type pg from "pg";
import { notifySafe } from "../../app/services/subscription-lifecycle.server";
import { emitKlaviyoEvent } from "../../app/services/klaviyo.server";
import { issuePortalToken } from "../../app/services/portal-token.server";

const RELINK_TTL_MINUTES = 7 * 24 * 60;

export async function tokenExpiryNudge(db: pg.Pool): Promise<number> {
  const { rows } = await db.query(
    `select id, email, phone_e164, payment_method, token_expires_at,
            (token_expires_at at time zone 'Asia/Jakarta')::date as expires_wib
       from subscriptions
      where status = 'active'
        and token_expires_at is not null
        and token_expires_at < now() + interval '7 days'`,
  );

  let sent = 0;
  for (const sub of rows) {
    try {
      const appUrl = process.env.SHOPIFY_APP_URL || "";
      const ok = await notifySafe(db, sub, sub.expires_wib, "token_expiring", async () => {
        const token = await issuePortalToken(db, sub.id, "relink", RELINK_TTL_MINUTES);
        await emitKlaviyoEvent("Token Expiring", sub.email, {
          subscription_id: sub.id,
          payment_method: sub.payment_method,
          expires_at: sub.token_expires_at,
          relink_url: `${appUrl}/portal/${token}`,
        }, sub.phone_e164);
      });
      if (ok) sent++;
    } catch (err) {
      console.error(`[token-expiry-nudge] sub ${sub.id}`, err);
    }
  }
  return sent;
}
