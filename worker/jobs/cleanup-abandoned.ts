// Pembersih harian (§7.1): checkout yang tidak selesai. HANYA menyentuh
// langganan yang TIDAK PERNAH punya charge sukses — yang pernah menarik uang
// tidak boleh dihapus (retensi catatan keuangan §10.3).
import type pg from "pg";

export async function cleanupAbandoned(db: pg.Pool): Promise<void> {
  // Charge pending menganggur > 1 jam → abandoned.
  await db.query(
    `update charges set status = 'abandoned'
      where status = 'pending' and created_at < now() - interval '1 hour'`,
  );

  // Langganan tanpa token dan tanpa charge sukses setelah 1 jam = checkout batal.
  // Urutan: charges dulu (FK restrict), lalu subscriptions (portal_tokens cascade).
  const { rows } = await db.query(
    `select s.id from subscriptions s
      where s.xendit_token_id is null
        and s.created_at < now() - interval '1 hour'
        and not exists (select 1 from charges c where c.subscription_id = s.id and c.status = 'succeeded')`,
  );
  if (rows.length) {
    const ids = rows.map((r) => r.id);
    await db.query("delete from charges where subscription_id = any($1::uuid[])", [ids]);
    await db.query("delete from subscriptions where id = any($1::uuid[])", [ids]);
    console.log(`[cleanup-abandoned] hapus ${ids.length} langganan yang tidak pernah dibayar`);
  }

  // Token portal kedaluwarsa/terpakai > 1 hari.
  await db.query(
    "delete from portal_tokens where expires_at < now() - interval '1 day' or used_at < now() - interval '1 day'",
  );
}
