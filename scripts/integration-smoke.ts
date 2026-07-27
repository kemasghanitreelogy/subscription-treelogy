// Smoke test integrasi Neon (jalankan: npx tsx --env-file=.env scripts/integration-smoke.ts)
// 1. Konektivitas dua pool (pooled → web, direct → worker)
// 2. shopify_sessions terbentuk via PostgreSQLSessionStorage
// 3. Invariant uang: constraint harus MENOLAK pelanggaran (§12.2)
// Semua data uji dibersihkan di akhir.
import { PostgreSQLSessionStorage } from "@shopify/shopify-app-session-storage-postgresql";
import { pooledDb, directDb, isUniqueViolation } from "../app/db/client.server";
import { writeHeartbeat } from "../worker/heartbeat";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const pooled = pooledDb();
const direct = directDb();

// 1 · konektivitas
const [p, d] = await Promise.all([
  pooled.query("select current_setting('server_version') v, inet_server_addr() is not null up"),
  direct.query("select now() t"),
]);
check("pooled pool (web) terhubung", true, `Postgres ${p.rows[0].v}`);
check("direct pool (worker) terhubung", true, String(d.rows[0].t));

// 2 · session storage Shopify — konstruktor lazy; ready memicu pembuatan tabel
const storage = new PostgreSQLSessionStorage(new URL(process.env.DATABASE_URL!));
await storage.findSessionsByShop("smoke-test.myshopify.com"); // memaksa init
const { rows: sess } = await direct.query(
  "select 1 from pg_tables where schemaname='public' and tablename='shopify_sessions'",
);
check("tabel shopify_sessions terbentuk", sess.length === 1);

// 3 · invariant uang
const { rows: subRows } = await direct.query(
  `insert into subscriptions
     (shopify_customer_gid, email, variant_gid, quantity, unit_amount_idr,
      shipping_amount_idr, frequency_days, status, payment_method,
      next_charge_date, next_attempt_at, consent_text, consent_at)
   values ('gid://shopify/Customer/0', 'smoke@test.invalid',
           'gid://shopify/ProductVariant/0', 1, 586500, 15000, 30, 'active',
           'dana', current_date, now(), 'smoke consent', now())
   returning id`,
);
const subId = subRows[0].id;

try {
  // 3a · langganan aktif tanpa jadwal harus DITOLAK
  let rejected = false;
  try {
    await direct.query(
      "update subscriptions set next_charge_date = null where id = $1",
      [subId],
    );
  } catch (err) {
    rejected = true;
  }
  check("subscriptions_running_needs_schedule menolak active tanpa jadwal", rejected);

  // 3b · dua charge sukses satu siklus harus DITOLAK
  await direct.query(
    `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr, idempotency_key)
     values ($1, current_date, 1, 'succeeded', 601500, 'smoke_att_1')`,
    [subId],
  );
  let doubleRejected = false;
  try {
    await direct.query(
      `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr, idempotency_key)
       values ($1, current_date, 2, 'succeeded', 601500, 'smoke_att_2')`,
      [subId],
    );
  } catch (err) {
    doubleRejected = isUniqueViolation(err);
  }
  check("charges_one_success_per_cycle menolak double-charge", doubleRejected);

  // 3c · notifikasi H-3 kedua untuk siklus sama harus DITOLAK
  await direct.query(
    `insert into notifications (subscription_id, charge_cycle, kind, channel)
     values ($1, current_date, 'precharge_h3', 'both')`,
    [subId],
  );
  let notifRejected = false;
  try {
    await direct.query(
      `insert into notifications (subscription_id, charge_cycle, kind, channel)
       values ($1, current_date, 'precharge_h3', 'email')`,
      [subId],
    );
  } catch (err) {
    notifRejected = isUniqueViolation(err);
  }
  check("notifications_once_idx menolak reminder H-3 ganda", notifRejected);

  // 3d · webhook dobel harus DITOLAK diam-diam (on conflict)
  const ins1 = await direct.query(
    `insert into webhook_events (source, external_id, event_type, payload)
     values ('xendit', 'smoke:1', 'payment.capture', '{}') on conflict do nothing`,
  );
  const ins2 = await direct.query(
    `insert into webhook_events (source, external_id, event_type, payload)
     values ('xendit', 'smoke:1', 'payment.capture', '{}') on conflict do nothing`,
  );
  check("webhook_events dedup (kiriman kedua diabaikan)", ins1.rowCount === 1 && ins2.rowCount === 0);

  // 4 · heartbeat worker
  await writeHeartbeat(direct, 0);
  const { rows: hb } = await direct.query(
    "select 1 from worker_heartbeat where worker_name = 'worker' and last_tick_at > now() - interval '1 minute'",
  );
  check("worker_heartbeat tertulis", hb.length === 1);
} finally {
  // bersihkan data uji
  await direct.query("delete from webhook_events where external_id like 'smoke:%'");
  await direct.query("delete from charges where subscription_id = $1", [subId]);
  await direct.query("delete from subscriptions where id = $1", [subId]);
}

console.log(failures ? `\n${failures} kegagalan` : "\nSemua smoke test integrasi lulus.");
await Promise.all([pooled.end(), direct.end()]);
process.exit(failures ? 1 : 0);
