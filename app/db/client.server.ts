import pg from "pg";

// BIGINT (OID 20) — kolom uang. IDR muat jauh di bawah 2^53; tolak kalau tidak.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT di luar rentang aman JS: ${v}`);
  }
  return n;
});

// DATE (OID 1082) — kolom tanggal WIB (scheduled_for, next_charge_date).
// Biarkan sebagai string 'YYYY-MM-DD'; default pg mengubahnya jadi Date di
// zona lokal proses, yang menggeser tanggal saat server bukan WIB.
pg.types.setTypeParser(1082, (v) => v);

declare global {
  // eslint-disable-next-line no-var
  var __pgPools: { pooled?: pg.Pool; direct?: pg.Pool };
}

const globalPools = (globalThis.__pgPools ??= {});

function makePool(connectionString: string): pg.Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: true },
  });
  pool.on("error", (err) => console.error("[pg] idle client error", err));
  return pool;
}

/** Pool via PgBouncer (-pooler) — dipakai process web. */
export function pooledDb(): pg.Pool {
  if (!globalPools.pooled) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL wajib diisi");
    globalPools.pooled = makePool(url);
  }
  return globalPools.pooled;
}

/**
 * Koneksi direct — dipakai worker & migrasi. PgBouncer transaction mode tidak
 * mendukung advisory lock lintas statement dan LISTEN/NOTIFY.
 */
export function directDb(): pg.Pool {
  if (!globalPools.direct) {
    const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL_DIRECT / DATABASE_URL wajib diisi");
    globalPools.direct = makePool(url);
  }
  return globalPools.direct;
}

/** Jalankan fn dalam satu transaksi di pool yang diberikan. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** true kalau error adalah pelanggaran unique constraint (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
