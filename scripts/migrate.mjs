// Runner migrasi sederhana: jalankan migrations/*.sql berurutan, catat di _migrations.
// Pakai koneksi DIRECT (bukan -pooler) — lihat STRUCTURE.md §4.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const url = process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL_DIRECT / DATABASE_URL wajib diisi");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: url.includes("localhost") ? undefined : { rejectUnauthorized: true },
});
await client.connect();

try {
  await client.query(
    "create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    const { rowCount } = await client.query("select 1 from _migrations where name = $1", [file]);
    if (rowCount) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    console.log(`applying ${file}…`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into _migrations (name) values ($1)", [file]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    }
  }
  console.log("migrations up to date");
} finally {
  await client.end();
}
