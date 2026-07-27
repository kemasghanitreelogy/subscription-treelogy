# Kronik Build: Treelogy Subscriptions — dari Spec sampai Live

**27 Juli 2026 · satu sesi build end-to-end**
Dokumen ini merekam SEMUA yang terjadi: keputusan, perintah kunci, setiap kegagalan
beserta root cause dan buktinya, sampai state akhir yang berjalan. Pasangan dari:
`subscription-app/IMPLEMENTATION.md` (spec) · `CLAUDE.md` (aturan maintainer) ·
`claudedocs/workflow_*.md` (planning per fase).

---

## Daftar isi

1. [Hasil akhir](#1-hasil-akhir)
2. [Titik berangkat: spec & prinsip](#2-titik-berangkat)
3. [Fase Planning — SuperClaude + verifikasi API live](#3-fase-planning)
4. [Scaffold app](#4-scaffold)
5. [Database Neon — provisioning via API + smoke test](#5-neon)
6. [Build inti: services, routes, worker](#6-build-inti)
7. [Integrasi Shopify: link, credentials, deploy](#7-integrasi-shopify)
8. [Deploy Fly.io — saga 3 kegagalan build](#8-deploy-fly)
9. [Instalasi & testing dengan admin token](#9-instalasi-server-side)
10. [Launch gate — aman dari customer](#10-launch-gate)
11. [Kloning app Subscriptions native (admin UI v2)](#11-admin-ui-v2)
12. [Widget PDP & Management URL](#12-widget--management-url)
13. [Saga terbesar: halaman customer account blank](#13-saga-blank)
14. [Pengerasan jadi best practice](#14-best-practice)
15. [Pelajaran & checklist anti-ulang](#15-pelajaran)
16. [State akhir & yang tersisa](#16-state-akhir)

---

## 1. Hasil akhir

| Komponen | Status | Bukti |
|---|---|---|
| App Shopify "Treelogy Subscriptions" | Ter-install di store produksi, versi rilis ke-13 | Dev Dashboard app 402708725761 |
| Web (Fly.io `sin`) | 2 machine, HTTP 200 | `https://treelogy-subscriptions.fly.dev` |
| Worker penagihan | Always-on, heartbeat ke Neon tiap tick | tabel `worker_heartbeat` |
| Neon Postgres | Project `treelogy-subscriptions` (ap-southeast-1), 9 tabel + 3 migrasi | smoke test 8/8 lulus |
| Admin UI | Dashboard · Langganan (list+detail+aksi) · Plans (diskon+produk) · Pengaturan (annotated) | tampil dengan data demo |
| Customer account page | "Langganan" full-page, aksi inline berfungsi | screenshot user + log fetch 200 |
| Theme widget PDP | App block "Kotak Langganan Treelogy", belum dipasang (disengaja) | rilis versi 4+ |
| Launch gate | Publik = 404; preview key = 200 | uji curl produksi |
| Kualitas | 22 unit test, typecheck, GraphQL tervalidasi schema live, validator per-surface | semua hijau |
| Repo | github.com/kemasghanitreelogy/subscription-treelogy | 10+ commit terdokumentasi |

Belum aktif (menunggu kredensial): Xendit test mode, Klaviyo — tanpa Klaviyo sistem
SENGAJA menunda charge (reminder H-3 = janji legal).

---

## 2. Titik berangkat

Input: folder `subscription-app/` berisi tiga dokumen matang:

- **IMPLEMENTATION.md** — spec end-to-end dengan status verifikasi per klaim
  (✅ terverifikasi / ⚠️ wajib konfirmasi / 🔒 komitmen legal), state machine langganan,
  kontrak Xendit & Shopify, jadwal dunning, runbook insiden.
- **STRUCTURE.md** — struktur repo, fly.toml, aturan koneksi Neon.
- **schema.sql** — DDL dengan pertahanan uang di level database.

Keputusan arsitektur kunci yang mengikat seluruh build:

1. **ADR-01**: TIDAK pakai Subscription Contract native Shopify — `customerPaymentMethodRemoteCreate`
   hanya menerima Stripe/Authorize.Net/Braintree; Xendit tidak ada jalurnya. Langganan
   hidup di database sendiri; Shopify hanya menerima order jadi.
2. **ADR-02**: Fly.io + Neon (bukan Vercel — cron Hobby 1×/hari, fair-use melarang
   "requesting payments").
3. **ADR-03**: frekuensi dalam HARI (30/60/90), bukan bulan — copy wajib "tiap 30 hari".
4. **Prinsip #4**: gagal ke arah TIDAK-menagih. Semua jalur uang dijaga unique
   constraint database, bukan cuma logika aplikasi.

---

## 3. Fase Planning

Perintah user: *"pakai superclaude untuk planning best practice, research best practice
latest feature"*. Alur: `/sc:workflow` → riset → dokumen plan → implementasi.

### 3.1 Verifikasi API Xendit lawan docs live (butir ⚠️ §5.5 spec)

Ini langkah paling berharga di fase planning — **6 dari 10 dugaan spec ternyata salah**:

| Spec menduga | Hasil verifikasi docs live | Dampak kalau tidak dicek |
|---|---|---|
| `POST /v1/payments` | **`POST /v3/payment_requests`**, amount = `request_amount` (number) | Semua charge berulang 404 |
| `allow_save_payment_method: REQUIRED` | **`FORCED`** \| `OPTIONAL` + `card_on_file_type: RECURRING` | Tokenisasi gagal |
| `capture_method: AUTO`? | **`AUTOMATIC`** | Request ditolak |
| event `payment.succeeded/.failed` | **`payment.capture`** / **`payment.failure`** | Webhook tidak pernah match |
| token event `payment_token.success` | **`payment_token.activation`** (+ `payment_session.completed`) | Token tidak pernah tersimpan |
| verifikasi webhook HMAC+timestamp? | **header `x-callback-token`** (constant-time compare) | Handler salah desain |
| header idempotency terpisah | **tidak ada** → andalkan `reference_id` deterministik + unique DB | — |
| sesi simpan-tanpa-tagih | `session_type: "SAVE"`, amount 0 | Alur re-link tidak mungkin |

Metode: `docs.xendit.co/llms.txt` sebagai indeks → WebFetch halaman API spesifik.
Pelajaran: **jangan pernah menulis integrasi pembayaran dari ingatan/PDF** — spec-nya
sendiri sudah memperingatkan ini dan tetap setengah dugaannya meleset.

### 3.2 Verifikasi sisi Shopify

- Template resmi: React Router (`shopify app init --template reactRouter`).
- Session storage: `@shopify/shopify-app-session-storage-postgresql`.
- Target extension: `customer-account.page.render` (full page + bisa ditautkan ke menu).
- `orderCreate`/`metafieldsSet` divalidasi lawan schema Admin live (lihat §6.4).

Output fase: `claudedocs/workflow_treelogy-subscriptions_implementation.md` (fase A–E,
checkpoint per fase, daftar keputusan mengikat).

---

## 4. Scaffold

### 4.1 Kegagalan #1: CLI butuh login interaktif

`shopify app init` di lingkungan non-interaktif → *"Authorization is required…"*.
**Solusi**: clone template resmi langsung (hasil identik):

```bash
git clone --depth 1 https://github.com/Shopify/shopify-app-template-react-router treelogy-subscriptions
```

### 4.2 Operasi template → arsitektur spec

- **Prisma + SQLite DIBUANG** (STRUCTURE.md melarang SQLite di Fly — machine pindah
  host = session hilang). Diganti: `pg` + `PostgreSQLSessionStorage(DATABASE_URL)`.
- `pg.types.setTypeParser`: BIGINT → number dengan guard `Number.isSafeInteger`
  (kolom uang), DATE → **string** `YYYY-MM-DD` (default pg mengubah ke Date di zona
  lokal proses = tanggal WIB bisa bergeser — bug sunyi yang dicegat sejak desain).
- Dua pool: `pooledDb()` (PgBouncer → web) / `directDb()` (worker + migrasi).
- Migrasi: runner SQL murni idempoten (`scripts/migrate.mjs`, tabel `_migrations`);
  `migrations/0001_init.sql` = salinan verbatim `schema.sql`.

---

## 5. Neon

User memberi `API_KEY_NEONDB` (API key platform, bukan connection string) → provisioning
penuh via REST API:

```
GET  /api/v2/projects                      → 1 project lain (punya app berbeda)
POST /api/v2/projects {name, region_id: aws-ap-southeast-1, pg 17}
                                           → long-hat-81712358 (BARU, terpisah)
```

Region `ap-southeast-1` = butir terbuka #5 spec (**tidak bisa diubah setelah dibuat**) — tertutup.
Connection string pooled+direct ditulis ke `.env`, `npm run setup` → migrasi masuk.

### 5.1 Kegagalan #2: session storage menolak koneksi ("connection is insecure")

Smoke test integrasi menemukan `PostgreSQLSessionStorage` gagal padahal URL sudah
`sslmode=require`. **Root cause** (dibaca dari source package): konstruktor membangun
`pg.Pool` hanya dari host/user/password URL dan **membuang seluruh query param** —
sslmode ikut hilang. **Solusi**: `PGSSLMODE=require` di env (fallback resmi yang dibaca
`pg` saat config `ssl` kosong). Tanpa ini OAuth install akan gagal sunyi di produksi.

### 5.2 Smoke test integrasi (scripts/integration-smoke.ts) — 8/8 lulus

Bukan cuma "bisa connect" — **membuktikan pertahanan uang bekerja di DB sungguhan**:

```
✓ pooled & direct pool terhubung (Postgres 17)
✓ shopify_sessions terbentuk otomatis
✓ subscriptions_running_needs_schedule MENOLAK langganan aktif tanpa jadwal
✓ charges_one_success_per_cycle MENOLAK double-charge satu siklus
✓ notifications_once_idx MENOLAK reminder H-3 ganda
✓ webhook_events dedup: kiriman kedua diabaikan
✓ worker_heartbeat tertulis
```

---

## 6. Build inti

### 6.1 Services (app/services/)

| File | Tanggung jawab | Poin desain |
|---|---|---|
| `schedule.server.ts` | Aritmetika kalender WIB | `assertH3Safe` 🔒 (melempar `PolicyViolation`), `paydayAwareDate` (tgl 20–24 → 25), `idempotencyKey` deterministik |
| `xendit.server.ts` | Klien API (bentuk terverifikasi §3.1) | `verifyCallbackToken` constant-time; `classifyFailure` konservatif (kode mentah selalu disimpan) |
| `shopify-order.server.ts` | `orderCreate` PAID + metafield `treelogy_sub` | Order HANYA setelah webhook konfirmasi uang masuk |
| `subscription-lifecycle.server.ts` | State machine + aksi | `applyChargeSuccess` idempoten; dunning stage dihitung dari **jumlah charge failed riil** (retry infra 5xx tidak memakan jatah pelanggan); AUTO-PAUSE bukan cancel 🔒 |
| `webhook-queue.server.ts` | Antrian webhook | klaim-by-UPDATE (aman PgBouncer), balas 200 dulu proses kemudian |
| `portal-token.server.ts` | Magic link / deep-link | hash sha256 di DB, sekali pakai, scope terbatas, TTL variatif |
| `settings.server.ts` | Plans/diskon/produk/notifikasi | harga & kelayakan SELALU diputuskan server |

### 6.2 Worker (worker/)

```
tick 5 menit : heartbeat → [harian 09:00 WIB: precharge-h3 🔒 → nudge token → cleanup]
             → charge-due → reconcile-orphaned → process-webhooks
```

Urutan sakral `charge-due` (§7.2 spec): klaim `FOR UPDATE SKIP LOCKED` batch 20 →
**majukan `next_attempt_at` SEBELUM panggil Xendit** (crash saat network call tidak
membuat baris diklaim ulang membabi buta) → insert `charges` (unique = sudah ada yang
proses, mundur) → panggil API → simpan hasil. Gate H-3: percobaan pertama siklus tanpa
reminder terkirim → **charge DITUNDA +3 hari**, bukan dipaksakan.

### 6.3 Unit test (22, semua lulus)

Aritmetika yang menyentuh uang/janji legal: H-3 tolak H+0/1/2 terima H+3; payday
19/20/24/25/26; lintas akhir bulan & kabisat; 10:00 WIB = 03:00 UTC; jadwal dunning
+6j/+24j(14:00)/+72j/final; total integer menolak float/negatif.

### 6.4 Validasi GraphQL lawan schema live

Semua operasi divalidasi dengan validator skill `shopify-admin` (schema Admin 2026-04):
`orderCreate` ✓ · `metafieldsSet` ✓ · `productVariant` ✓ · `customers` ✓ ·
`productByHandle` → **terdeteksi deprecated** → diganti `productByIdentifier` ✓.

---

## 7. Integrasi Shopify

1. `shopify auth login` — device code flow (dijalankan user via `!`).
2. `shopify app config link` — **butuh TTY sungguhan**; prompt `!` pun gagal → user
   menjalankan di terminal VS Code. Pilih org "Treelogy Premium Organic Moringa" →
   create new app "Treelogy Subscriptions".
3. **Kegagalan #3**: `config link` MENIMPA `shopify.app.toml` — `scopes` jadi kosong.
   Dikembalikan manual: `write_customers,write_orders,write_draft_orders,read_products`
   (TANPA `write_own_subscription_contracts` — ADR-01).
4. Kredensial via `shopify app env show` → `.env`.
5. `shopify app deploy` → **Kegagalan #4**: bundling extension gagal
   `Could not resolve "@preact/signals"` → tambah dependency → rilis versi 2.

---

## 8. Deploy Fly

`fly launch --no-deploy --copy-config --yes` → app `treelogy-subscriptions` region `sin`,
secrets di-stage dari `.env` (hanya non-kosong), lalu `fly deploy` — **gagal 3×**:

### Kegagalan #5–#7: `npm ci` EUSAGE di Docker

| Percobaan | Error | Diagnosis |
|---|---|---|
| 1 | `npm ci` exit 1, pesan terpotong | log ter-tail, info hilang → **pelajaran: simpan output penuh** |
| 2 (pin `npm@11`) | `Missing: @emnapi/core@… from lock file` | lockfile tidak sinkron |
| 3 (regenerasi lock) | Missing @emnapi MAKIN banyak | regenerasi di macOS tidak akan pernah menyelesaikan |

**Root cause**: bug npm 11 — dependency wasm-fallback (`@emnapi/*`) milik
optional-dependency per-platform **dipangkas dari lockfile saat install di macOS**;
`npm ci` di Linux menuntut entri itu ada → selalu "out of sync".
**Solusi final**: Dockerfile memakai `npm install` (tetap menghormati lockfile, tanpa
sync-check yang kena bug). Percobaan #4 sukses; web+worker hidup; heartbeat worker
terverifikasi tertulis ke Neon dari Fly (umur 39 detik).

Lalu: `application_url` + redirect → URL Fly, `shopify app deploy` versi 3.

---

## 9. Instalasi server-side

User memberi `ADMIN_API_KEY` (token custom app dari admin, 165 scope).

### 9.1 Temuan penting: domain kanonik

Query `shop { myshopifyDomain }` → **`prkdg7-jt.myshopify.com`** — `treelogymoringa`
hanya alias redirect! `STORE_NAME` dikoreksi; tanpa ini `unauthenticated.admin()` tidak
akan menemukan session dan worker gagal membuat order.

### 9.2 Seed session offline

Baris `shopify_sessions` (`id=offline_prkdg7-jt.myshopify.com`, token = ADMIN_API_KEY)
ditanam langsung → seluruh jalur backend hidup tanpa OAuth:
`scripts/smoke-shopify.ts` → produk & varian nyata terbaca, lookup customer by email OK.
(Instalasi OAuth sungguhan tetap dilakukan user belakangan agar app muncul di admin —
dua hal ini komplementer, tidak bentrok.)

---

## 10. Launch gate

Kebutuhan user: *"walaupun terinstall dan live, customer tetap gabisa liat dan gabisa make."*

Dua lapis:
1. **Widget theme = app block** — tidak pernah tampil sampai merchant menambahkannya
   sendiri di theme editor (default platform).
2. **Gate server** (`launch-gate.server.ts`): `/subscribe/*` dan API create →
   **404 untuk publik** (bukan 403 — keberadaan halaman pun tidak bocor) sampai
   `STOREFRONT_SUBSCRIBE_ENABLED=true`; akses internal via `?preview=<key>`
   (dibandingkan constant-time).

Terverifikasi di produksi: tanpa key 404 · key salah 404 · key benar 200 (harga+diskon
tampil) · API tanpa key 404.

---

## 11. Admin UI v2

Kloningan app Subscriptions native, planning via `/sc:workflow`
(`claudedocs/workflow_subscriptions-parity_20260727.md`), semua halaman dengan Polaris
web components (`s-*`) dan **divalidasi validator app-home**:

- **Langganan** (list: filter status, cari email; detail: ringkasan, riwayat charge +
  error code, audit trail `actor`, aksi skip/pause/resume/cancel/reschedule/frekuensi —
  semua lewat `assertH3Safe`, tercatat sebagai `admin:<shop>`).
- **Plans**: frekuensi 30/60/90 + diskon% + ongkir; **scoping produk** via
  `shopify.resourcePicker` (kosong = semua produk) — ditegakkan server-side.
- **Pengaturan** (annotated layout ala native): widget (deep link
  `addAppBlockId={uid}/{handle}` — pasang block SEKALI KLIK, lebih baik dari snippet
  manual native), status launch gate, management URL (simpan + Copy + toast),
  toggle notifikasi per event — **H-3 terkunci selalu aktif** 🔒 (sengaja beda dari
  native), status sistem (heartbeat/Xendit/Klaviyo/antrian webhook).
- Data demo (`npm run seed:demo`): 3 langganan (active/dunning/paused) dengan riwayat,
  aman-by-design: tanpa token (worker skip), order `demo:` (rekonsiliasi skip), punya
  charge sukses (cleanup skip). Hapus: `-- --clean`.

Fitur native yang **sengaja tidak ditiru**: retry attempts yang bisa diubah + "cancel
subscription after retries" — bertentangan dengan kebijakan dunning & auto-pause yang
terikat halaman policy.

---

## 12. Widget & Management URL

- **Widget PDP**: theme app extension Liquid (`blocks/subscription_box.liquid`) dengan
  schema settings (judul, badge, plan+diskon, benefit, warna, CTA); CSS via asset;
  **lolos theme-check** (validator skill liquid, `--context app`).
  Kegagalan kecil #8: setting type `url` tidak boleh punya `default` → ganti `text`.
- **Management URL**: halaman full-page otomatis linkable; URL dibuat Shopify saat
  ditambahkan ke menu akun pelanggan → disimpan sekali di Pengaturan (app_settings),
  tampil dengan tombol Copy.
- Kegagalan pemahaman #9: menu "Subscription" pertama user ternyata menunjuk URL
  `/pages/6971b1a1-…` **milik app Subscriptions NATIVE** (masih terpasang) — halaman
  itulah yang error, bukan milik kita. Solusi: hapus item, tambah ulang dengan memilih
  halaman "Treelogy Subscriptions" dari picker. (Sekaligus bukti nyata peringatan spec
  soal "dua permukaan langganan" — app native harus dimatikan sebelum go-live.)

---

## 13. Saga blank

Bagian paling berharga untuk dipelajari: halaman customer account **blank total tanpa
error apa pun**, empat lapis penyebab, diurai sistematis.

### 13.1 Kronologi hipotesis → bukti

| # | Langkah | Temuan | Status |
|---|---|---|---|
| 1 | Hardening guard `shopify.sessionToken` + fallback UI | tetap blank | bukan itu |
| 2 | **Forge session token HS256** (ditandatangani `SHOPIFY_API_SECRET`) → curl API backend | **HTTP 200 + data langganan benar** | backend SEHAT — masalah murni frontend |
| 3 | Validator generik & typecheck | lulus semua | alat yang salah |
| 4 | **Validator target-aware** (`--target customer-account.page.render --version 2025-10`) | `s-badge tone success/warning ILEGAL` (hanya critical\|auto\|neutral) | bug riil #1: props ilegal → remote-DOM melempar saat re-render (di luar try/catch) → surface mati |
| 5 | Fix tone + naikkan `api_version` 2026-01 | masih blank, **tanpa breadcrumb** | modul tidak dieksekusi? |
| 6 | Probe v10: log level modul + target | `modul dievaluasi` + `target dipanggil` muncul, render tidak | modul JALAN, render yang gagal sunyi |
| 7 | Probe v11: log bedah di sekeliling SETIAP langkah | **`fase1 render SELESAI — body children: 0`** | render "sukses" tapi menghasilkan NOL node |
| 8 | Baca **metafile esbuild** bundle | berisi `react/cjs/react-jsx-runtime.production.min.js` | **ROOT CAUSE FINAL** |

### 13.2 Root cause: dua dunia JSX dalam satu monorepo

Root repo memuat **React 18** (admin app React Router). Bundler CLI meng-compile JSX
extension dengan automatic runtime yang ter-resolve ke `react/jsx-runtime` dari root
`node_modules`. Elemen React lalu disodorkan ke `render()` **Preact** → dianggap objek
asing → **dirender kosong tanpa exception**. Template resmi Shopify tidak pernah kena
karena repo mereka tidak punya React.

### 13.3 Fix + verifikasi

```jsx
/** @jsxImportSource preact */   // baris PERTAMA file extension
```
plus `jsconfig.json` per-extension (`"jsx":"react-jsx","jsxImportSource":"preact"`).
Verifikasi objektif: metafile bundle baru → **nol modul React**, `preact/jsx-runtime`
masuk. Halaman langsung tampil; aksi inline (Jeda) terbukti bekerja dari log user;
tombol resume-tanpa-token yang ditolak 400 kemudian diganti alur
"Hubungkan ulang pembayaran" (relink) yang benar.

### 13.4 Kenapa empat lapis ini instruktif

Lapisan 1 (badge tone) adalah bug NYATA yang pasti akan meledak — tapi bukan penyebab
gejala saat itu. Debugging yang jujur menuntut terus menggali setelah menemukan bug
pertama: *"apakah ini menjelaskan SEMUA gejala?"* Body children: 0 tidak dijelaskan
oleh badge tone → lanjut. Probe berbiaya-rendah (log bedah) + bukti forensik
(metafile) > tebakan.

---

## 14. Best practice

Pengerasan akhir (versi rilis 13):

1. `jsconfig.json` per-extension (kanonik) + pragma per-file (lapis kedua) + komentar
   yang menjelaskan KENAPA — bug sunyi layak dijaga ganda.
2. Scaffolding debug dibuang; yang tinggal memang best practice: timeout 10 detik
   (tak pernah menggantung bisu), error state selalu terlihat, satu `console.error`.
3. UX paused-tanpa-token → tombol relink (bukan resume yang pasti gagal).
4. **`CLAUDE.md` di root repo**: peta arsitektur, 5 jebakan yang sudah menggigit,
   aturan spec mengikat, perintah rutin — onboarding maintainer (manusia/AI) berikutnya.
5. **Memory lintas sesi**: jebakan JSX runtime; validator per-surface = gerbang rilis.
6. Semua perubahan selalu melewati gerbang: typecheck + vitest + validator surface +
   (untuk GraphQL) validasi schema live → baru deploy → commit dengan pesan yang
   menjelaskan root cause, bukan cuma "fix".

---

## 15. Pelajaran

### Daftar lengkap kegagalan & akar masalah

| # | Gejala | Root cause | Pencegahan |
|---|---|---|---|
| 1 | `shopify app init` gagal | CLI butuh TTY | clone template resmi |
| 2 | Session storage "connection is insecure" | package membuang query param URL (sslmode) | `PGSSLMODE=require` |
| 3 | Scopes hilang | `config link` menimpa toml | diff toml setelah link |
| 4 | Bundling extension gagal | peer dep `@preact/signals` tidak dideklarasi | baca peer deps |
| 5–7 | `npm ci` EUSAGE di Docker | bug npm 11: `@emnapi/*` dipangkas dari lockfile di macOS | `npm install` di Dockerfile |
| 8 | Deploy tolak schema widget | setting `url` tak boleh `default` | validator + baca error persis |
| 9 | "Problem loading this page" | menu menunjuk halaman app NATIVE | jangan tempel URL — pilih dari picker |
| 10 | Surface mati saat data tampil | badge tone ilegal per-surface | **validator `--target --version`** |
| 11 | Blank total, render "sukses", children: 0 | JSX ter-compile ke react/jsx-runtime (monorepo campuran) | pragma + jsconfig + **cek metafile** |

### Prinsip yang terbukti sepanjang build

1. **Verifikasi lawan sumber live sebelum menulis kode** — 6/10 dugaan spec soal Xendit
   salah; `productByHandle` deprecated; badge tone beda per surface. Toolkit + docs
   terbaru bukan formalitas.
2. **Bukti > tebakan.** Forge token untuk membuktikan backend sehat; log bedah untuk
   menemukan `children: 0`; metafile untuk membuktikan React di bundle. Tiap klaim
   root cause harus menjelaskan SEMUA gejala.
3. **Output perintah jangan dipotong saat debugging** — kegagalan #5 membuang informasi
   dan menambah satu siklus penuh.
4. **Pertahanan berlapis di database menyelamatkan dari bug aplikasi** — smoke test
   membuktikan constraint menolak double-charge/reminder ganda bahkan kalau semua
   logika aplikasi bocor.
5. **Fail toward not-charging.** Klaviyo kosong → charge ditunda (bukan dilewati
   diam-diam); resume tanpa token → ditolak; 5xx → bukan jatah dunning pelanggan.
6. **Dokumentasikan jebakan di tempat yang akan dibaca** (CLAUDE.md + memory), bukan
   di kepala.

---

## 16. State akhir

**Live:** app ter-install di store produksi; admin UI lengkap dengan data demo;
halaman "Langganan" akun pelanggan berfungsi dengan aksi inline; worker menagih-siap
(tapi tidak akan pernah menagih data demo — by design); launch gate menutup storefront
dari publik; semua kode di GitHub dengan riwayat commit yang menjelaskan setiap fix.

**Langkah menuju uang sungguhan (urut):**
1. Isi `XENDIT_SECRET_KEY` + `XENDIT_WEBHOOK_TOKEN` (test mode) di `.env` dan
   `fly secrets set`; daftarkan webhook `https://treelogy-subscriptions.fly.dev/webhooks/xendit`.
2. Isi `KLAVIYO_PRIVATE_KEY` + bangun flow untuk event yang tercantum di Pengaturan.
3. Uji end-to-end di test mode via URL preview (checklist §12.2 spec: sukses, saldo
   kurang, token mati, webhook dobel, dsb).
4. `npm run seed:demo -- --clean`; uninstall app Subscriptions NATIVE (dua permukaan
   langganan = bentrok yang sudah terbukti di §12).
5. Go-live: `fly secrets set STOREFRONT_SUBSCRIBE_ENABLED=true` + pasang block widget
   di theme editor + tambahkan halaman Langganan ke menu akun pelanggan.
6. Rollout sesuai spec §15: alpha internal 5 langganan → soft launch 1 produk → wallet
   lain → produk lain.
