// §9.3 · Keadaan paling berbahaya: uang sudah ditarik, order belum ada.
// Baris di charges_orphaned_idx harus selalu kosong; > 10 menit = alert P1.
import type pg from "pg";
import { createSubscriptionOrder } from "../../app/services/shopify-order.server";
import { logEvent } from "../../app/services/subscription-lifecycle.server";

export async function reconcileOrphaned(db: pg.Pool): Promise<number> {
  const { rows } = await db.query(
    `select c.id, c.subscription_id, c.scheduled_for, c.xendit_charge_id, c.settled_at,
            s.variant_gid, s.quantity, s.email, s.cycle_count
       from charges c
       join subscriptions s on s.id = c.subscription_id
      where c.status = 'succeeded'
        and c.shopify_order_gid is null
        and c.settled_at < now() - interval '2 minutes'
      order by c.settled_at
      limit 20`,
  );

  const oldest = rows[0]?.settled_at ? Date.now() - new Date(rows[0].settled_at).getTime() : 0;
  if (oldest > 10 * 60 * 1000) {
    console.error(`[ALERT P1] charge sukses tanpa order > 10 menit (${rows.length} baris) — uang diambil, barang belum diorder`);
  }

  let fixed = 0;
  for (const row of rows) {
    try {
      // Aman diulang: charges_order_uniq mencegah order kedua tercatat.
      const orderGid = await createSubscriptionOrder({
        variantGid: row.variant_gid,
        quantity: row.quantity,
        email: row.email,
        isFirstCycle: row.cycle_count <= 1,
        xenditChargeId: row.xendit_charge_id ?? "unknown",
        subscriptionId: row.subscription_id,
        cycle: row.scheduled_for,
      });
      await db.query(
        "update charges set shopify_order_gid = $1 where id = $2 and shopify_order_gid is null",
        [orderGid, row.id],
      );
      await logEvent(db, row.subscription_id, "order_reconciled", "system", {
        cycle: row.scheduled_for,
        order_gid: orderGid,
      });
      fixed++;
    } catch (err) {
      console.error(`[reconcile-orphaned] charge ${row.id} masih gagal`, err);
    }
  }
  return fixed;
}
