// Data DEMO untuk melihat UI terisi sebelum ada langganan sungguhan.
// AMAN: xendit_token_id NULL → worker tidak pernah menagih; charge sukses
// diberi order_gid palsu "demo:*" → job rekonsiliasi tidak membuat order.
//   isi   : npx tsx --env-file=.env scripts/seed-demo.ts
//   hapus : npx tsx --env-file=.env scripts/seed-demo.ts --clean
import { directDb } from "../app/db/client.server";
import { addDaysWIB, atHourWIB, todayWIB } from "../app/services/schedule.server";

const DEMO_MARK = "DEMO — data contoh untuk pratinjau UI; hapus: npm run seed:demo -- --clean";
const db = directDb();

if (process.argv.includes("--clean")) {
  const { rows } = await db.query("select id from subscriptions where consent_text = $1", [DEMO_MARK]);
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await db.query("delete from notifications where subscription_id = any($1::uuid[])", [ids]);
    await db.query("delete from events where subscription_id = any($1::uuid[])", [ids]);
    await db.query("delete from charges where subscription_id = any($1::uuid[])", [ids]);
    await db.query("delete from subscriptions where id = any($1::uuid[])", [ids]);
  }
  console.log(`✓ ${ids.length} langganan demo dihapus`);
  process.exit(0);
}

const VARIANT_90 = "gid://shopify/ProductVariant/44527085617340"; // Rp390.000
const VARIANT_180 = "gid://shopify/ProductVariant/44527085650108"; // Rp690.000
const KEMAS_GID = "gid://shopify/Customer/9511530037436";
const today = todayWIB();

interface DemoSub {
  email: string;
  customerGid: string;
  variant: string;
  unit: number;
  status: string;
  method: string;
  cycles: Array<{ offsetDays: number; status: string; attempts?: Array<string> }>;
  nextChargeOffset: number | null;
  frequency: number;
  pausedAt?: boolean;
}

const demos: DemoSub[] = [
  {
    // Pelanggan setia — 2 siklus sukses, siklus berikutnya 12 hari lagi
    email: "kemas@treelogy.com",
    customerGid: KEMAS_GID,
    variant: VARIANT_90,
    unit: 351000, // 390rb - 10%
    status: "active",
    method: "dana",
    frequency: 30,
    cycles: [
      { offsetDays: -60, status: "succeeded" },
      { offsetDays: -30, status: "succeeded" },
    ],
    nextChargeOffset: 12,
  },
  {
    // Sedang dunning — gagal saldo kurang, retry terjadwal
    email: "demo.dunning@treelogy.test",
    customerGid: "pending:demo.dunning@treelogy.test",
    variant: VARIANT_180,
    unit: 607200, // 690rb - 12%
    status: "dunning",
    method: "ovo",
    frequency: 60,
    cycles: [
      { offsetDays: -62, status: "succeeded" },
      { offsetDays: -2, status: "failed_pending_retry" },
    ],
    nextChargeOffset: -2,
  },
  {
    // Dijeda oleh pelanggan
    email: "demo.paused@treelogy.test",
    customerGid: "pending:demo.paused@treelogy.test",
    variant: VARIANT_90,
    unit: 331500, // 390rb - 15%
    status: "paused",
    method: "card",
    frequency: 90,
    cycles: [{ offsetDays: -45, status: "succeeded" }],
    nextChargeOffset: null,
    pausedAt: true,
  },
];

for (const d of demos) {
  const nextCharge = d.nextChargeOffset !== null ? addDaysWIB(today, d.nextChargeOffset) : null;
  const { rows } = await db.query(
    `insert into subscriptions
       (shopify_customer_gid, email, phone_e164, variant_gid, quantity, unit_amount_idr,
        shipping_amount_idr, frequency_days, status, cycle_count, payment_method,
        next_charge_date, next_attempt_at, consent_text, consent_at, paused_at)
     values ($1,$2,$3,$4,1,$5,0,$6,$7::subscription_status,$8,$9::payment_method,$10,$11,$12,now() - interval '60 days',$13)
     returning id`,
    [
      d.customerGid, d.email, "+628123456789", d.variant, d.unit, d.frequency,
      d.status, d.cycles.filter((c) => c.status === "succeeded").length, d.method,
      nextCharge,
      // dunning: retry beberapa hari lagi supaya tidak diklaim (dan token null → tetap dilewati)
      nextCharge ? atHourWIB(addDaysWIB(today, Math.max(d.nextChargeOffset ?? 2, 2))) : null,
      DEMO_MARK, d.pausedAt ? new Date() : null,
    ],
  );
  const subId = rows[0].id;

  for (const c of d.cycles) {
    const cycleDate = addDaysWIB(today, c.offsetDays);
    if (c.status === "succeeded") {
      await db.query(
        `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr,
                              idempotency_key, xendit_charge_id, shopify_order_gid, settled_at)
         values ($1,$2,1,'succeeded',$3,$4,$5,$6, $7)`,
        [subId, cycleDate, d.unit, `demo_${subId}_${cycleDate}_1`, `demo-pr-${subId.slice(0, 8)}-${cycleDate}`,
         `demo:order:${subId.slice(0, 8)}:${cycleDate}`, atHourWIB(cycleDate)],
      );
      await db.query(
        `insert into notifications (subscription_id, charge_cycle, kind, channel, sent_at)
         values ($1,$2,'precharge_h3','both',$3)`,
        [subId, cycleDate, atHourWIB(addDaysWIB(cycleDate, -3), 9)],
      );
      await db.query(
        "insert into events (subscription_id, type, actor, data, created_at) values ($1,'charged','system',$2,$3)",
        [subId, JSON.stringify({ cycle: cycleDate, demo: true }), atHourWIB(cycleDate)],
      );
    } else {
      await db.query(
        `insert into charges (subscription_id, scheduled_for, attempt_n, status, amount_idr,
                              idempotency_key, error_code, settled_at)
         values ($1,$2,1,'failed',$3,$4,'INSUFFICIENT_BALANCE',$5)`,
        [subId, cycleDate, d.unit, `demo_${subId}_${cycleDate}_1`, atHourWIB(cycleDate)],
      );
      await db.query(
        "insert into events (subscription_id, type, actor, data, created_at) values ($1,'charge_failed','system',$2,$3)",
        [subId, JSON.stringify({ cycle: cycleDate, error_code: "INSUFFICIENT_BALANCE", demo: true }), atHourWIB(cycleDate)],
      );
    }
  }
  await db.query(
    "insert into events (subscription_id, type, actor, data, created_at) values ($1,'created','customer',$2, now() - interval '60 days')",
    [subId, JSON.stringify({ demo: true })],
  );
  if (d.pausedAt) {
    await db.query(
      "insert into events (subscription_id, type, actor, data) values ($1,'paused','customer',$2)",
      [subId, JSON.stringify({ months: 1, demo: true })],
    );
  }
  console.log(`✓ ${d.status.padEnd(8)} ${d.email} (${subId})`);
}

console.log("\nSelesai — refresh dashboard app untuk melihat data.");
process.exit(0);
