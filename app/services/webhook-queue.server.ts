// Antrian webhook: klaim-by-update (bukan transaksi panjang) supaya aman di
// PgBouncer transaction mode dan tidak menahan lock selama panggilan eksternal.
// Dipakai dua tempat: route webhook (proses segera setelah balas 200) dan
// worker (jaring pengaman untuk baris yang gagal/tercecer).
import type pg from "pg";
import type { XenditWebhookPayload } from "./xendit.server";
import { processXenditWebhook } from "./xendit-webhook.server";

export async function enqueueWebhookEvent(
  db: pg.Pool,
  source: "xendit" | "shopify",
  externalId: string,
  eventType: string | null,
  payload: unknown,
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into webhook_events (source, external_id, event_type, payload)
     values ($1, $2, $3, $4)
     on conflict (source, external_id) do nothing`,
    [source, externalId, eventType, JSON.stringify(payload)],
  );
  return rowCount === 1; // false = duplikat, sudah pernah diterima
}

/**
 * Klaim lalu proses baris xendit yang belum selesai. Klaim atomik lewat UPDATE
 * … WHERE processed_at IS NULL; kalau proses gagal, klaim dilepas + error
 * dicatat supaya tick berikutnya mencoba lagi.
 */
export async function claimAndProcessXenditEvents(db: pg.Pool, limit = 20): Promise<number> {
  const { rows } = await db.query(
    `update webhook_events
        set processed_at = now()
      where id in (
        select id from webhook_events
         where source = 'xendit' and processed_at is null
         order by received_at
         limit $1
         for update skip locked
      )
      returning id, payload`,
    [limit],
  );

  let ok = 0;
  for (const row of rows) {
    try {
      await processXenditWebhook(db, row.payload as XenditWebhookPayload);
      await db.query("update webhook_events set error = null where id = $1", [row.id]);
      ok++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[webhook-queue] gagal memproses ${row.id}:`, message);
      await db.query(
        "update webhook_events set processed_at = null, error = $1 where id = $2",
        [message.slice(0, 1000), row.id],
      );
    }
  }
  return ok;
}
