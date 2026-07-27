// F3 · Reminder H-3 (§7.3) 🔒 KOMITMEN LEGAL — jalan sebelum charge apa pun.
// Exactly-once via notifications_once_idx: klaim dulu, kirim kemudian; kirim
// gagal → klaim dilepas (notifySafe). Kalau job ini gagal, F2 MENUNDA charge.
import type pg from "pg";
import { notifySafe } from "../../app/services/subscription-lifecycle.server";
import { emitKlaviyoEvent } from "../../app/services/klaviyo.server";
import { issuePortalToken } from "../../app/services/portal-token.server";

// Deep-link WA harus tetap hidup sampai melewati tanggal charge (janji 1-klik §7.6).
const DEEPLINK_TTL_MINUTES = 5 * 24 * 60;

export async function prechargeH3(db: pg.Pool): Promise<number> {
  const { rows } = await db.query(
    `select s.id, s.email, s.phone_e164, s.next_charge_date, s.payment_method,
            (s.unit_amount_idr * s.quantity) + s.shipping_amount_idr as amount_idr
       from subscriptions s
      where s.status = 'active'
        and s.next_charge_date = ((now() at time zone 'Asia/Jakarta')::date + 3)
        and not exists (
          select 1 from notifications n
           where n.subscription_id = s.id
             and n.charge_cycle = s.next_charge_date
             and n.kind = 'precharge_h3'
        )`,
  );

  let sent = 0;
  for (const sub of rows) {
    try {
      const appUrl = process.env.SHOPIFY_APP_URL || "";
      const ok = await notifySafe(db, sub, sub.next_charge_date, "precharge_h3", async () => {
        const [skipToken, pauseToken] = await Promise.all([
          issuePortalToken(db, sub.id, "skip", DEEPLINK_TTL_MINUTES),
          issuePortalToken(db, sub.id, "pause", DEEPLINK_TTL_MINUTES),
        ]);
        await emitKlaviyoEvent("Upcoming Charge", sub.email, {
          subscription_id: sub.id,
          charge_date: sub.next_charge_date,
          amount_idr: sub.amount_idr,
          payment_method: sub.payment_method,
          skip_url: `${appUrl}/portal/${skipToken}`,
          pause_url: `${appUrl}/portal/${pauseToken}`,
        }, sub.phone_e164);
      });
      if (ok) sent++;
    } catch (err) {
      // 🔒 JANGAN telan diam-diam: reminder gagal = charge akan ditunda oleh gate F2.
      console.error(`[ALERT][precharge-h3] gagal kirim untuk sub ${sub.id}`, err);
    }
  }
  return sent;
}
