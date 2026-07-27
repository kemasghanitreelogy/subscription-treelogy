# Workflow — Implementasi `treelogy-subscriptions`

**27 Jul 2026 · output `/sc:workflow` · strategi: systematic**
Sumber: `subscription-app/IMPLEMENTATION.md` · `subscription-app/STRUCTURE.md` · `subscription-app/schema.sql`
Store: `treelogymoringa.myshopify.com` (dari `.env` `STORE_NAME`)

---

## 0 · Hasil riset — konfirmasi Fase 0.4 (diverifikasi lawan docs live 27 Jul 2026)

Butir ⚠️ dari IMPLEMENTATION.md §5.5 yang kini **terjawab**:

| # | Butir | Jawaban terverifikasi | Sumber |
|---|---|---|---|
| 1 | `/v1` vs `/v3` payment tokens | **`POST /v3/payment_tokens`** | docs.xendit.co/apidocs/create-payment-token |
| 2 | Nilai `allow_save_payment_method` | **`FORCED` \| `OPTIONAL`** (bukan REQUIRED/DISALLOWED). Kartu: tambah `channel_properties.cards.card_on_file_type: "RECURRING"` | docs.xendit.co/docs/pay-and-save-2 |
| 3 | Nilai `capture_method` | **`AUTOMATIC`** (default) \| `MANUAL` — bukan `AUTO` | docs.xendit.co/apidocs/create-payment-request |
| 4 | Event webhook pembayaran | **`payment.capture`** (sukses) · **`payment.failure`** (gagal) · `payment.authorization` | docs.xendit.co/apidocs/payment-webhook-notification |
| 5 | Verifikasi webhook Payments v3 | **Header `x-callback-token`** (shared token) — bandingkan konstan-waktu | docs.xendit.co/docs/handling-webhooks |
| 6 | Header idempotency terpisah | **Tidak ada** di OpenAPI spec → andalkan `reference_id` deterministik + unique constraint DB | docs.xendit.co/apidocs/create-payment-request |
| — | Endpoint charge berulang | **`POST /v3/payment_requests`** (bukan `/v1/payments`) · `payment_token_id` top-level · `type: "PAY"` · status: `SUCCEEDED/FAILED/REQUIRES_ACTION/…` | idem |
| — | Payment Session | **`POST /sessions`** · respons **`payment_session_id`** + **`payment_link_url`** (bukan `session_id`/`payment_url`) · `amount` number | docs.xendit.co/docs/pay-and-save-2 |
| — | Event token | **`payment_token.activation`** (bukan `.success`) · `payment_token.failure` · `payment_token.expiry` | docs.xendit.co/apidocs/payment-token-webhook-notification |

Masih terbuka (butuh akun/tim Xendit, bukan docs): daftar lengkap `failure_code` (§7.5), umur token per wallet, perilaku MIT saat saldo kurang, rate-limit per token, underwriting MIT, MID recurring. → kode memakai pemetaan konservatif + kolom `error_code` disimpan mentah.

Shopify (diverifikasi via Shopify AI Toolkit):
- Template resmi: **React Router** (`shopify app init`), package `@shopify/shopify-app-react-router`, `ApiVersion` terbaru.
- Session storage: `@shopify/shopify-app-session-storage-postgresql` (`PostgreSQLSessionStorage`) → Neon pooled.
- Customer account extension target **`customer-account.page.render`** tersedia (API 2026-07), komponen `s-*`.
- `orderCreate` + `metafieldsSet` sudah ✅ tervalidasi di IMPLEMENTATION.md lawan schema 2026-04; validasi ulang lawan schema live saat implementasi.

---

## 1 · Fase implementasi

### Fase A — Scaffold & fondasi (blocking semua)
1. `shopify app init` template React Router → direktori `treelogy-subscriptions/`
2. Konfigurasi `shopify.app.toml`: scopes `write_customers,write_orders,write_draft_orders,read_products` (TANPA `write_own_subscription_contracts` — ADR-01), webhook GDPR
3. `shopify.server.ts` → `PostgreSQLSessionStorage(DATABASE_URL)`
4. `.env` app: `STORE_NAME=treelogymoringa.myshopify.com` + variabel §17.1
5. `migrations/0001_init.sql` = salinan `schema.sql`

**Checkpoint A:** `npm run build` hijau; struktur = STRUCTURE.md §2.

### Fase B — Lapisan data & services (dependensi: A)
1. `app/db/client.server.ts` — dua pool (pooled web / direct worker)
2. `app/services/schedule.server.ts` — aritmetika WIB: `nextChargeDate`, `assertH3Safe` 🔒, `paydayAwareDate`, jam charge 10:00 / reminder 09:00
3. `app/services/xendit.server.ts` — bentuk API terverifikasi §0: session, payment request v3, verifikasi `x-callback-token` `timingSafeEqual`
4. `app/services/shopify-order.server.ts` — `orderCreate` PAID + tags + `metafieldsSet` (namespace `treelogy_sub`)
5. `app/services/klaviyo.server.ts` — emit event lifecycle

**Checkpoint B:** unit test schedule lulus (H-3 tolak H+0/1/2 terima H+3; payday 19/20/24/25/26; integer money).

### Fase C — Routes web (dependensi: B)
1. `api.sub.create.ts` — consent wajib (bukan pre-ticked) → INSERT subscriptions+charges → session Xendit → redirect
2. `webhooks.xendit.ts` — verifikasi token → INSERT `webhook_events` (dedup) → 200 cepat → proses async: `payment.capture`/`payment.failure`/`payment_token.*`
3. `webhooks.shopify.$topic.ts` — `app/uninstalled`, `customers/data_request`, `customers/redact` (anonimkan, JANGAN hapus charges), `shop/redact`
4. Aksi portal: skip / pause / frequency / relink / cancel (semua mutasi jadwal lewat `assertH3Safe`)
5. `portal.$token.tsx` — magic link + deep-link token sekali pakai scope terbatas
6. `subscribe.$handle.tsx`, `admin._index.tsx` (dashboard embedded)

**Checkpoint C:** alur F1 jalan di test mode; webhook dobel → satu order (constraint).

### Fase D — Worker (dependensi: B; paralel dengan C)
1. `worker/index.ts` — tick 5 menit + heartbeat; jam harian 09:00 WIB
2. `jobs/charge-due.ts` — `FOR UPDATE SKIP LOCKED` batch 20; majukan `next_attempt_at` SEBELUM panggil Xendit; gate H-3 🔒 (belum ternotifikasi → tunda +3 hari, jangan tagih)
3. `jobs/precharge-h3.ts` — exactly-once via `notifications_once_idx`
4. `jobs/dunning.ts` — +6j → +24j (14:00) → +72j → h5-7 payday-aware → AUTO-PAUSE (bukan cancel); 5xx ≠ attempt dunning
5. `jobs/reconcile-orphaned.ts` + `jobs/token-expiry-nudge.ts` + `cleanup-abandoned`

**Checkpoint D:** simulasi crash di tiap titik §9.2 tidak menghasilkan double charge.

### Fase E — Extension & deploy (dependensi: C, D)
1. `extensions/customer-account/` — target `customer-account.page.render`, komponen `s-*`, urutan deflect: Skip → Pause → Frekuensi → … → Cancel
2. `Dockerfile` + `fly.toml` (web+worker split, `auto_stop_machines = "off"`, region `sin`)
3. Validasi GraphQL lawan schema Admin live (`validate_graphql_codeblocks`)
4. Test suite penuh + review

**Checkpoint E:** build + test hijau; GraphQL tervalidasi; siap `fly deploy` (deploy manual oleh pemilik — butuh secrets produksi).

---

## 2 · Keputusan yang mengikat selama implementasi

- Uang `BIGINT` IDR penuh; waktu `timestamptz` UTC; kalender via `Asia/Jakarta` (pakai library timezone, bukan offset hardcode)
- Setiap jalur uang punya unique constraint; `charges_one_success_per_cycle` tidak boleh di-drop
- Gagal → ke arah tidak-menagih; 🔒 H-3, auto-pause, consent literal, refund tanpa debat
- Secrets hanya via env/`fly secrets`; tidak ada di repo; `.env` untracked

## 3 · Di luar scope build ini (butuh akses pemilik)

Buat app di Partner Dashboard + `SHOPIFY_API_KEY/SECRET` riil · provision Neon & jalankan migrasi · akun Xendit (test & live) + webhook token · deploy Fly + secrets · konfirmasi non-docs Xendit (failure codes, MID, underwriting) · copy legal "tiap 30 hari" di PDP/policy.
