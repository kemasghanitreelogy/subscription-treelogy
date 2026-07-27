# Treelogy Subscription App — struktur repo & deploy Fly

27 Jul 2026 · pasangan dari `workflow_subscription-final-flow_20260723.md` dan `schema.sql`

> **Repo terpisah.** Source app TIDAK masuk repo tema ini — repo tema tersinkron dua arah
> dengan Shopify (`Update from Shopify for theme Treelogy/staging`), jadi apa pun yang
> ditaruh di sini berisiko tertimpa. Dokumen ini adalah cetak biru; buat repo baru
> `treelogy-subscriptions` saat mulai implementasi.

---

## 1 · Batas tanggung jawab

| Yang HIDUP di app ini | Yang TETAP di Shopify |
|---|---|
| Kontrak langganan, jadwal, token, dunning state | Katalog, harga dasar, PDP, inventory |
| Eksekusi penagihan (Xendit) | Order, fulfillment, shipping, pajak |
| Portal self-service + customer account extension | Autentikasi pelanggan (new customer accounts) |
| Emit event Klaviyo | — |

Shopify tidak pernah tahu ini "langganan". Ia hanya menerima order jadi lewat Admin GraphQL,
ditandai tag `subscription` / `subscription-renewal` untuk rekonsiliasi.

**Scope Shopify yang dibutuhkan** — perhatikan yang TIDAK ada di sini:
`write_customers`, `write_orders`, `write_draft_orders`, `read_products`.
`write_own_subscription_contracts` **tidak dipakai** — kita tidak memakai subscription
contract native Shopify, karena billing attempt-nya hanya bisa menagih vaulted payment
method dari gateway yang didukung Shopify, dan Xendit bukan salah satunya.

---

## 2 · Struktur direktori

```
treelogy-subscriptions/
├── app/                          # React Router 7 (template app Shopify terbaru)
│   ├── routes/
│   │   ├── subscribe.$handle.tsx      # Fase 2b — halaman subscribe 3 langkah
│   │   ├── portal.$token.tsx          # Fase 3 — deep-link 1-tap tanpa login
│   │   ├── api.sub.create.ts          # POST — tokenisasi + charge pertama
│   │   ├── api.sub.$id.skip.ts        # aksi portal: skip
│   │   ├── api.sub.$id.pause.ts       #               pause
│   │   ├── api.sub.$id.frequency.ts   #               ubah frekuensi
│   │   ├── api.sub.$id.relink.ts      #               re-link wallet
│   │   ├── api.sub.$id.cancel.ts      #               cancel + survey deflection
│   │   ├── webhooks.xendit.ts         # hasil charge asinkron e-wallet
│   │   ├── webhooks.shopify.$topic.ts # app/uninstalled, customers/redact (GDPR)
│   │   └── admin._index.tsx           # dashboard internal (embedded di Shopify admin)
│   ├── db/
│   │   ├── client.server.ts           # dua pool: pooled (web) & direct (worker)
│   │   └── queries/
│   ├── services/
│   │   ├── xendit.server.ts           # tokenize, charge off-session, verifikasi webhook
│   │   ├── shopify-order.server.ts    # orderCreate + tag + metafield xendit_charge_id
│   │   ├── klaviyo.server.ts          # emit event lifecycle
│   │   └── schedule.server.ts         # aritmetika tanggal WIB: H-3, payday-aware, next cycle
│   └── shopify.server.ts              # PostgreSQLSessionStorage → Neon
│
├── worker/
│   ├── index.ts                       # loop tick 5 menit + heartbeat
│   ├── jobs/
│   │   ├── charge-due.ts              # klaim FOR UPDATE SKIP LOCKED → charge
│   │   ├── precharge-h3.ts            # KOMITMEN LEGAL — jalan sebelum charge apa pun
│   │   ├── dunning.ts                 # +6j → +24j → +72j → h5-7 → auto-pause
│   │   └── token-expiry-nudge.ts      # re-link proaktif sebelum gagal
│   └── heartbeat.ts
│
├── extensions/
│   └── customer-account/              # target customer-account.page.render
│       ├── shopify.extension.toml
│       └── src/                       # komponen Polaris s-* (bukan HTML bebas)
│
├── migrations/
│   └── 0001_init.sql                  # = claudedocs/subscription-app/schema.sql
│
├── Dockerfile
└── fly.toml
```

---

## 3 · fly.toml

```toml
app            = "treelogy-subscriptions"
primary_region = "sin"                  # dekat Xendit & pelanggan ID

[build]
  dockerfile = "Dockerfile"

[processes]
  web    = "npm run start"
  worker = "npm run worker"

[http_service]
  internal_port        = 3000
  force_https          = true
  processes            = ["web"]        # worker tidak menerima traffic
  auto_start_machines  = true
  auto_stop_machines   = "off"          # webhook Shopify & Xendit tidak sabar cold start
  min_machines_running = 1

  [http_service.concurrency]
    type       = "requests"
    soft_limit = 200

[[vm]]
  processes = ["web"]
  size      = "shared-cpu-1x"
  memory    = "512mb"

[[vm]]
  processes = ["worker"]
  size      = "shared-cpu-1x"
  memory    = "512mb"
```

**Kenapa `"off"` dan bukan `"suspend"`:** dokumentasi Fly menyebut suspend punya masalah
*clock-skew* pada aplikasi yang sensitif waktu. Mesin yang jamnya meleset setelah resume
adalah hal terakhir yang kamu mau di penjadwal penagihan.

Worker sengaja **tidak** dipasang di `http_service` — dengan begitu autostop tidak pernah
menyentuhnya, sesuai pola web/worker split di blueprint Fly.

Skala: `fly scale count web=2 worker=1`. **Worker jangan lebih dari 1 sampai
`FOR UPDATE SKIP LOCKED` terbukti jalan di staging** — meski secara desain aman untuk
beberapa worker sekaligus.

---

## 4 · Koneksi Neon

Dua connection string, jangan tertukar:

```bash
fly secrets set \
  DATABASE_URL="postgres://…-pooler.ap-southeast-1.aws.neon.tech/…?sslmode=require" \
  DATABASE_URL_DIRECT="postgres://…ap-southeast-1.aws.neon.tech/…?sslmode=require"
```

- `DATABASE_URL` (pooled, PgBouncer) → process `web`
- `DATABASE_URL_DIRECT` → process `worker` dan migrasi

Konsekuensi yang perlu diterima: worker always-on membuat compute Neon tidak pernah
autosuspend. Pilih compute terkecil (0.25 CU) dan anggap ini biaya tetap.

Session storage Shopify:

```ts
import { shopifyApp } from '@shopify/shopify-app-react-router/server';
import { PostgreSQLSessionStorage } from '@shopify/shopify-app-session-storage-postgresql';

const shopify = shopifyApp({
  sessionStorage: new PostgreSQLSessionStorage(process.env.DATABASE_URL!),
  // …
});
```

Tabel session dibuat otomatis. **Jangan** pakai SQLite di volume Fly seperti template
bawaan — machine bisa pindah host dan session hilang.

---

## 5 · Secrets

```bash
fly secrets set \
  SHOPIFY_API_KEY=… SHOPIFY_API_SECRET=… SHOPIFY_APP_URL=https://… \
  XENDIT_SECRET_KEY=… XENDIT_WEBHOOK_TOKEN=… \
  KLAVIYO_PRIVATE_KEY=… \
  SENTRY_DSN=…
```

Tidak ada satu pun di repo. `.env` lokal tetap untracked.

---

## 6 · Urutan build

1. `migrations/0001_init.sql` → branch `main` Neon, lalu buat branch `staging`
2. `shopify.server.ts` + session storage → deploy kosong ke Fly, pastikan OAuth install jalan
3. `services/xendit.server.ts` — **validasi bentuk API lawan docs live dulu** (Fase 0.4);
   jangan hardcode dari PDF playbook
4. `worker/index.ts` + heartbeat + alerting — sebelum ada charge pertama, bukan sesudah
5. `api.sub.create.ts` → charge pertama end-to-end di test mode
6. `precharge-h3.ts` — **sebelum** ada langganan produksi mana pun. Ini janji legal yang
   sudah live di `/policies/subscription-policy`; jangan sampai sistem menagih sebelum
   sanggup mengingatkan.
7. Sisanya sesuai urutan fase di dokumen final-flow
