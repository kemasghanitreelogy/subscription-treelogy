# treelogy-subscriptions

Custom Shopify subscription app untuk `treelogymoringa.myshopify.com`.
Langganan hidup sepenuhnya di database (Neon Postgres); Shopify hanya menerima
order jadi via Admin GraphQL; penagihan lewat Xendit (session pertama hosted,
charge berulang off-session/MIT).

Dokumen induk: `subscription-app/IMPLEMENTATION.md` · `subscription-app/STRUCTURE.md`
Plan build: `claudedocs/workflow_treelogy-subscriptions_implementation.md`

## Arsitektur singkat

- **web** (Fly): React Router 7 — halaman subscribe, portal magic-link/deep-link,
  webhook Xendit & Shopify, dashboard admin embedded, API extension akun pelanggan.
- **worker** (Fly, always-on): tick 5 menit — charge jatuh tempo (`FOR UPDATE
  SKIP LOCKED`), rekonsiliasi order yatim, antrian webhook; harian 09:00 WIB —
  reminder H-3 (🔒 legal), nudge token, pembersih checkout batal.
- **Neon**: `DATABASE_URL` (pooled → web), `DATABASE_URL_DIRECT` (worker + migrasi).
- Semua invariant uang ditegakkan unique constraint (lihat `migrations/0001_init.sql`).

## Setup

```bash
cp .env.example .env       # isi kredensial (STORE_NAME sudah terisi)
npm install
npm run setup              # jalankan migrasi ke DATABASE_URL_DIRECT
shopify auth login
npm run config:link        # tautkan ke app di Dev Dashboard (mengisi client_id)
npm run dev                # shopify app dev
npm run worker             # proses worker (terminal terpisah; tsx)
npm test                   # unit test aritmetika jadwal (H-3, payday, dunning)
```

## Deploy (Fly.io)

```bash
fly launch --no-deploy     # sekali, region sin
fly secrets set SHOPIFY_API_KEY=… SHOPIFY_API_SECRET=… SHOPIFY_APP_URL=… \
  PGSSLMODE=require \
  STORE_NAME=treelogymoringa.myshopify.com \
  DATABASE_URL=… DATABASE_URL_DIRECT=… \
  XENDIT_SECRET_KEY=… XENDIT_WEBHOOK_TOKEN=… XENDIT_MID_LABEL=… \
  KLAVIYO_PRIVATE_KEY=… SENTRY_DSN=…
fly deploy
fly scale count web=1 worker=1   # worker JANGAN >1 sebelum teruji di staging
```

Set webhook Xendit di dashboard mereka ke `https://<app>/webhooks/xendit`
(verifikasi: header `x-callback-token`).

## Yang masih menunggu pemilik (di luar kode)

1. Buat app di Partner/Dev Dashboard → `client_id`, API key/secret.
2. Provision Neon (region `ap-southeast-1`) + jalankan `npm run setup`.
3. Akun Xendit: aktivasi MIT per wallet, MID recurring kartu, webhook token,
   dan konfirmasi daftar `failure_code` resmi (pemetaan konservatif ada di
   `app/services/xendit.server.ts::classifyFailure`).
4. Alur end-to-end di Xendit test mode (checklist §12.2 dokumen induk).
5. Copy legal "tiap 30 hari" di PDP + halaman policy (ADR-03).
