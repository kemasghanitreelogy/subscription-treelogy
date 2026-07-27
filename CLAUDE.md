# treelogy-subscriptions — panduan proyek

Custom subscription app untuk store `prkdg7-jt.myshopify.com` (alias treelogymoringa).
Dokumen induk: `subscription-app/IMPLEMENTATION.md` (spec mengikat) · `STRUCTURE.md` · `schema.sql`.

## Peta arsitektur

- **app/** — React Router 7 (React 18) embedded admin + storefront subscribe + webhook + API.
- **worker/** — proses always-on Fly: tick 5 menit (charge due, rekonsiliasi, webhook queue), harian 09:00 WIB (reminder H-3 🔒, nudge token, cleanup).
- **extensions/customer-account-portal/** — **Preact**, halaman "Langganan" akun pelanggan.
- **extensions/subscription-widget/** — Liquid theme app block untuk PDP.
- **migrations/** — SQL murni, dijalankan `npm run setup` (idempoten, tabel `_migrations`).
- DB Neon: `DATABASE_URL` (pooled→web), `DATABASE_URL_DIRECT` (worker+migrasi). `PGSSLMODE=require` wajib (session storage membuang query param URL).

## ⚠️ Jebakan yang SUDAH pernah menggigit — jangan diulang

1. **Dua dunia JSX dalam satu repo.** Admin = React, extension = Preact. Setiap file
   `.jsx` extension WAJIB `/** @jsxImportSource preact */` di baris pertama + ada
   `jsconfig.json` per-extension. Tanpanya bundler memakai react/jsx-runtime dari root
   dan Preact merender KOSONG tanpa error. Verifikasi: metafile di `extensions/*/dist/`
   tidak boleh memuat modul `react/`.
2. **Validasi per-surface, bukan hanya typecheck.** Komponen `s-*` punya subset props
   BERBEDA per surface (contoh: badge `tone="success"` sah di app home, TIDAK sah di
   customer account → crash re-render → blank). Selalu jalankan validator skill toolkit
   dengan `--target` + `--version` sebelum deploy extension.
3. **`shopify app config link` menimpa `shopify.app.toml`** (scopes bisa jadi kosong).
   Cek diff setelah menjalankannya.
4. **`npm ci` gagal di Docker** — bug npm 11 macOS memangkas dep `@emnapi/*` dari
   lockfile. Dockerfile memakai `npm install`; jangan "dirapikan" kembali ke `npm ci`.
5. **Domain kanonik store = `prkdg7-jt.myshopify.com`** — `treelogymoringa` hanya alias
   redirect; session storage dan STORE_NAME harus memakai yang kanonik.

## Aturan spec yang tidak boleh dilanggar (dari IMPLEMENTATION.md)

- Uang `BIGINT` IDR penuh; semua jalur uang dijaga unique constraint
  (`charges_one_success_per_cycle` jangan pernah di-drop).
- Reminder H-3 = janji legal 🔒: tidak bisa dimatikan; charge DITUNDA jika reminder gagal.
- Dunning: +6j → +24j (14:00) → +72j → hari 5–7 payday-aware → AUTO-PAUSE (bukan cancel).
- Semua mutasi jadwal lewat `assertH3Safe`. Harga selalu dihitung server.
- Scope `write_own_subscription_contracts` sengaja TIDAK dipakai (ADR-01).
- Launch gate: storefront subscribe 404 untuk publik sampai
  `STOREFRONT_SUBSCRIBE_ENABLED=true` (fly secrets).

## Perintah rutin

```bash
npm run typecheck && npm test        # gerbang minimal sebelum commit
npm run setup                        # migrasi DB
npx tsx --env-file=.env scripts/integration-smoke.ts   # smoke Neon + constraint
npx tsx --env-file=.env scripts/smoke-shopify.ts       # smoke Admin API
npm run seed:demo [-- --clean]       # data demo UI
shopify app deploy --allow-updates   # rilis config + extensions
fly deploy --app treelogy-subscriptions
```

Validator extension (contoh customer account):
```bash
node <skill-customer-account>/scripts/validate.mjs --code "$(cat extensions/customer-account-portal/src/SubscriptionsPage.jsx)" \
  --target customer-account.page.render --version 2026-01 ...
```

## Status integrasi

Terisi & jalan: Shopify (OAuth + offline token), Neon (migrasi 0001–0003), Fly (web×2 + worker), GitHub.
Belum: `XENDIT_SECRET_KEY`/`XENDIT_WEBHOOK_TOKEN` (test mode) + webhook URL di dashboard Xendit, `KLAVIYO_PRIVATE_KEY` (tanpa ini charge sengaja tertunda), MID recurring kartu.
