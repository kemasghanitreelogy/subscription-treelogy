// Cron yang mati diam-diam tidak mengirim error apa pun (§11.1). Worker menulis
// ke sini tiap tick; alerting berbunyi kalau basi > 15 menit.
import type pg from "pg";

export async function writeHeartbeat(db: pg.Pool, claimedCount: number): Promise<void> {
  await db.query(
    `insert into worker_heartbeat (worker_name, last_tick_at, claimed_count)
     values ('worker', now(), $1)
     on conflict (worker_name) do update
       set last_tick_at = now(), claimed_count = excluded.claimed_count`,
    [claimedCount],
  );
}

/** Klaim eksekusi job harian per tanggal WIB — true kalau kita yang pertama. */
export async function claimDailyRun(db: pg.Pool, dateWIB: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into worker_heartbeat (worker_name, last_tick_at, claimed_count)
     values ('daily-' || $1, now(), 0)
     on conflict (worker_name) do nothing`,
    [dateWIB],
  );
  return rowCount === 1;
}
