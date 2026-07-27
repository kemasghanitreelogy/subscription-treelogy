// Worker always-on (§8): tick tiap 5 menit + job harian 09:00 WIB.
// Jadwal hidup di kolom database, bukan di cron — worker hanya bertanya
// "apa yang jatuh tempo". Satu worker cukup (§8.2); JANGAN scale ke 2
// sebelum SKIP LOCKED terbukti di staging.
import { DateTime } from "luxon";
import { directDb } from "../app/db/client.server";
import { PRECHARGE_HOUR_WIB, todayWIB, WIB } from "../app/services/schedule.server";
import { claimAndProcessXenditEvents } from "../app/services/webhook-queue.server";
import { writeHeartbeat, claimDailyRun } from "./heartbeat";
import { chargeDue } from "./jobs/charge-due";
import { prechargeH3 } from "./jobs/precharge-h3";
import { reconcileOrphaned } from "./jobs/reconcile-orphaned";
import { tokenExpiryNudge } from "./jobs/token-expiry-nudge";
import { cleanupAbandoned } from "./jobs/cleanup-abandoned";

const TICK_MS = 5 * 60 * 1000;
let stopping = false;

async function tick(): Promise<void> {
  const db = directDb();

  // 1 · heartbeat — pertama, supaya "worker hidup tapi job error" tetap terlihat beda
  //     dari "worker mati".
  let claimed = 0;
  await writeHeartbeat(db, claimed);

  // Job harian dulu: reminder H-3 🔒 wajib jalan SEBELUM charge apa pun (§8.1).
  const hourWIB = DateTime.now().setZone(WIB).hour;
  if (hourWIB >= PRECHARGE_HOUR_WIB && (await claimDailyRun(db, todayWIB()))) {
    console.log(`[worker] job harian ${todayWIB()}`);
    await run("precharge-h3", () => prechargeH3(db));
    await run("token-expiry-nudge", () => tokenExpiryNudge(db));
    await run("cleanup-abandoned", () => cleanupAbandoned(db));
  }

  // 2 · charge yang jatuh tempo
  claimed = (await run("charge-due", () => chargeDue(db))) ?? 0;
  // 3 · charge sukses tanpa order
  await run("reconcile-orphaned", () => reconcileOrphaned(db));
  // 4 · webhook yang tercecer/gagal di web process
  await run("process-webhooks", () => claimAndProcessXenditEvents(db));

  await writeHeartbeat(db, claimed);
}

async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    console.error(`[worker] job ${name} error`, err);
    return undefined;
  }
}

async function main(): Promise<void> {
  console.log("[worker] mulai — tick tiap 5 menit");
  while (!stopping) {
    const started = Date.now();
    await tick().catch((err) => console.error("[worker] tick error", err));
    const wait = Math.max(0, TICK_MS - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log("[worker] berhenti dengan rapi");
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    // Selesaikan tick berjalan, jangan potong di tengah panggilan Xendit.
    console.log(`[worker] ${sig} — menunggu tick selesai…`);
    stopping = true;
  });
}

main();
