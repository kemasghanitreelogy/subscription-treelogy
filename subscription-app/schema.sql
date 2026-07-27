-- ============================================================================
-- Treelogy Subscription Engine — schema Neon Postgres
-- 27 Jul 2026 · pasangan dari claudedocs/workflow_subscription-final-flow_20260723.md
--
-- ATURAN YANG TIDAK BOLEH DILANGGAR
--   1. Uang = BIGINT rupiah penuh. IDR tidak berdesimal. Tidak ada float/numeric
--      di kolom uang — pembulatan float pada penagihan berulang = selisih riil.
--   2. Semua waktu = timestamptz (UTC di storage). Logika kalender (H-3,
--      payday-aware, "hari ini") dihitung di aplikasi dengan zona Asia/Jakarta.
--      Kolom bertipe date (`scheduled_for`, `next_charge_date`) adalah tanggal WIB.
--   3. Jadwal hidup di kolom, bukan di cron. Worker hanya bertanya
--      "apa yang next_attempt_at <= now()".
--   4. Setiap jalur yang menyentuh uang punya unique constraint. Lihat
--      charges_one_success_per_cycle — itu pertahanan terakhir terhadap
--      double-charge kalau logika aplikasi bocor.
--
-- Tabel `shopify_sessions` TIDAK ditulis di sini — dibuat otomatis oleh
-- @shopify/shopify-app-session-storage-postgresql. Jangan tangani manual.
-- ============================================================================

create extension if not exists pgcrypto;  -- gen_random_uuid()

-- ── enums ───────────────────────────────────────────────────────────────────

create type subscription_status as enum ('active', 'paused', 'dunning', 'cancelled');
create type payment_method      as enum ('card', 'ovo', 'dana', 'gopay', 'shopeepay');
create type charge_status       as enum ('pending', 'succeeded', 'failed', 'abandoned');
create type notification_kind   as enum (
  'welcome',            -- Subscription Created
  'precharge_h3',       -- KOMITMEN LEGAL: /policies/subscription-policy
  'charge_succeeded',
  'charge_failed',
  'dunning_h0',
  'dunning_h2',
  'dunning_h4',
  'auto_paused',
  'token_expiring'      -- banner/WA re-link wallet (Fase 3)
);

-- ── subscriptions ───────────────────────────────────────────────────────────
-- Source of truth. Shopify tidak tahu apa-apa soal langganan; ia hanya
-- menerima order yang sudah jadi.

create table subscriptions (
  id                    uuid primary key default gen_random_uuid(),

  -- identitas pelanggan
  shopify_customer_gid  text        not null,
  email                 text        not null,
  phone_e164            text,       -- wajib terisi kalau kanal WA dipakai (dan WA wajib minimal 1 kanal — legal)

  -- isi langganan
  variant_gid           text        not null,
  quantity              int         not null default 1 check (quantity > 0),
  unit_amount_idr       bigint      not null check (unit_amount_idr > 0),
  shipping_amount_idr   bigint      not null default 0 check (shipping_amount_idr >= 0),
  currency              char(3)     not null default 'IDR',
  frequency_days        int         not null check (frequency_days between 7 and 365),

  -- state
  status                subscription_status not null default 'active',
  cycle_count           int         not null default 0 check (cycle_count >= 0),

  -- pembayaran (token, BUKAN data kartu — PAN tidak pernah menyentuh sistem kita)
  payment_method        payment_method not null,
  xendit_customer_id    text,
  xendit_token_id       text,        -- token kartu / linked-account id
  token_expires_at      timestamptz, -- untuk nudge re-link proaktif sebelum gagal

  -- penjadwalan
  next_charge_date      date,        -- tanggal siklus berikutnya (WIB)
  next_attempt_at       timestamptz, -- kapan worker boleh menyentuh baris ini

  -- consent (bukti untuk OJK / sengketa — simpan literal, jangan referensi)
  consent_text          text        not null,
  consent_at            timestamptz not null,
  consent_ip            inet,

  -- lifecycle
  paused_at             timestamptz,
  cancelled_at          timestamptz,
  cancel_reason         text,        -- dari survey deflection; jadi tag win-back

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- langganan yang berjalan WAJIB punya jadwal. Tanpa ini, satu bug menulis
  -- NULL dan langganan berhenti menagih diam-diam tanpa ada yang sadar.
  constraint subscriptions_running_needs_schedule check (
    status not in ('active', 'dunning')
    or (next_charge_date is not null and next_attempt_at is not null)
  )
);

-- Query utama worker. Partial index — baris paused/cancelled tidak perlu dilihat.
create index subscriptions_due_idx
  on subscriptions (next_attempt_at)
  where status in ('active', 'dunning');

create index subscriptions_customer_idx on subscriptions (shopify_customer_gid);
create index subscriptions_email_idx    on subscriptions (lower(email));

-- Untuk banner "token wallet-mu akan kedaluwarsa" (ShopeePay tgl 5, DANA tgl 10).
create index subscriptions_token_expiry_idx
  on subscriptions (token_expires_at)
  where status = 'active' and token_expires_at is not null;

-- ── charges ─────────────────────────────────────────────────────────────────
-- Satu baris per PERCOBAAN penagihan. Retry = baris baru dengan attempt_n naik,
-- bukan update baris lama — riwayat dunning harus bisa diaudit.

create table charges (
  id                  uuid primary key default gen_random_uuid(),
  subscription_id     uuid        not null references subscriptions(id) on delete restrict,

  scheduled_for       date        not null,  -- siklus mana (WIB) — bukan waktu eksekusi
  attempt_n           int         not null default 1 check (attempt_n >= 1),
  status              charge_status not null default 'pending',
  amount_idr          bigint      not null check (amount_idr > 0),

  -- Deterministik, dihitung dari (subscription_id, scheduled_for, attempt_n).
  -- Dikirim ke Xendit sebagai idempotency key: kalau worker crash setelah
  -- request terkirim tapi sebelum commit, retry menghasilkan key yang sama
  -- dan Xendit menolak menagih dua kali.
  idempotency_key     text        not null,

  xendit_charge_id    text,
  error_code          text,
  error_message       text,
  shopify_order_gid   text,       -- diisi setelah order dibuat; null = order belum jadi

  attempted_at        timestamptz not null default now(),
  settled_at          timestamptz,  -- e-wallet asinkron: diisi saat webhook masuk
  created_at          timestamptz not null default now(),

  constraint charges_cycle_attempt_uniq unique (subscription_id, scheduled_for, attempt_n)
);

create unique index charges_idempotency_key_uniq on charges (idempotency_key);

create unique index charges_xendit_id_uniq on charges (xendit_charge_id)
  where xendit_charge_id is not null;

-- Satu charge = maksimal satu order. Mencegah order kembar saat webhook dobel.
create unique index charges_order_uniq on charges (shopify_order_gid)
  where shopify_order_gid is not null;

-- ⚠️ PERTAHANAN TERAKHIR TERHADAP DOUBLE-CHARGE.
-- Satu siklus hanya boleh punya satu charge sukses. Kalau logika aplikasi
-- bocor (worker overlap, webhook dobel, retry setelah sukses), INSERT/UPDATE
-- kedua akan ditolak database. Jangan pernah drop index ini.
create unique index charges_one_success_per_cycle
  on charges (subscription_id, scheduled_for)
  where status = 'succeeded';

create index charges_subscription_idx on charges (subscription_id, scheduled_for desc);
create index charges_pending_idx on charges (created_at) where status = 'pending';

-- ⚠️ KEADAAN PALING BERBAHAYA DI SELURUH SISTEM: uang sudah ditarik dari
-- pelanggan tetapi order belum terbentuk di Shopify. Terjadi kalau proses mati
-- di antara konfirmasi Xendit dan orderCreate. Job rekonsiliasi memindai index
-- ini tiap tick dan menyelesaikannya. Baris di sini harus selalu kosong;
-- kalau tidak kosong lebih dari 10 menit, alert berbunyi.
create index charges_orphaned_idx on charges (settled_at)
  where status = 'succeeded' and shopify_order_gid is null;

-- ── notifications ───────────────────────────────────────────────────────────
-- Bukti bahwa komitmen di /policies/subscription-policy ditunaikan.
-- Reminder H-3 harus terkirim TEPAT SEKALI per siklus: tidak terkirim =
-- melanggar janji legal; terkirim dua kali = pelanggan hilang kepercayaan.

create table notifications (
  id                uuid primary key default gen_random_uuid(),
  subscription_id   uuid        not null references subscriptions(id) on delete cascade,
  charge_cycle      date,       -- siklus yang diacu; null untuk notif non-siklus (welcome)
  kind              notification_kind not null,
  channel           text        not null check (channel in ('email', 'whatsapp', 'both')),
  klaviyo_event_id  text,
  sent_at           timestamptz not null default now()
);

-- Kunci exactly-once. coalesce dipakai supaya notif non-siklus tetap tercakup.
create unique index notifications_once_idx
  on notifications (subscription_id, coalesce(charge_cycle, '1970-01-01'::date), kind);

-- ── webhook_events ──────────────────────────────────────────────────────────
-- Xendit dan Shopify sama-sama mengirim ulang webhook saat ragu. Tanpa tabel
-- ini, satu retry dari Xendit bisa memicu satu order tambahan.

create table webhook_events (
  id            uuid primary key default gen_random_uuid(),
  source        text        not null check (source in ('xendit', 'shopify')),
  external_id   text        not null,   -- id event dari provider
  event_type    text,
  payload       jsonb       not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,            -- null = belum selesai diproses
  error         text,

  constraint webhook_events_source_external_uniq unique (source, external_id)
);

create index webhook_events_unprocessed_idx on webhook_events (received_at)
  where processed_at is null;

-- ── events (audit log) ──────────────────────────────────────────────────────
-- Append-only. Setiap perubahan state langganan masuk sini. Saat pelanggan
-- protes "saya tidak pernah setuju" atau "saya sudah batal minggu lalu",
-- ini satu-satunya jawaban yang bisa dipertanggungjawabkan.

create table events (
  id                bigserial primary key,
  subscription_id   uuid references subscriptions(id) on delete set null,
  type              text        not null,   -- 'created' | 'charged' | 'paused' | 'skipped' | ...
  actor             text        not null default 'system',  -- 'system' | 'customer' | 'admin:<email>'
  data              jsonb       not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

create index events_subscription_idx on events (subscription_id, created_at desc);
create index events_type_idx on events (type, created_at desc);

-- ── worker_heartbeat ────────────────────────────────────────────────────────
-- Cron yang mati diam-diam tidak mengirim error apa pun. Worker menulis ke
-- sini tiap tick; alerting berbunyi kalau baris ini basi > 15 menit.

create table worker_heartbeat (
  worker_name   text primary key,
  last_tick_at  timestamptz not null default now(),
  claimed_count int         not null default 0
);

-- ── updated_at ──────────────────────────────────────────────────────────────

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger subscriptions_set_updated_at
  before update on subscriptions
  for each row execute function set_updated_at();

-- ============================================================================
-- POLA KLAIM WORKER — pakai ini, jangan SELECT lalu UPDATE terpisah.
-- SKIP LOCKED membuat dua worker (atau dua machine Fly) tidak pernah
-- memproses langganan yang sama, tanpa perlu lock global.
--
--   begin;
--     select id, xendit_token_id, unit_amount_idr, shipping_amount_idr
--       from subscriptions
--      where status in ('active', 'dunning')
--        and next_attempt_at <= now()
--      order by next_attempt_at
--      limit 20
--        for update skip locked;
--
--     -- geser next_attempt_at DULU (sebelum panggil Xendit) supaya baris ini
--     -- tidak diklaim lagi kalau proses crash di tengah panggilan jaringan.
--     -- Kebenaran tetap dijaga charges_one_success_per_cycle.
--
--   commit;
--
-- CATATAN KONEKSI NEON:
--   web    → connection string ber-suffix `-pooler` (PgBouncer)
--   worker → connection string DIRECT. PgBouncer transaction mode tidak
--            mendukung advisory lock lintas statement, LISTEN/NOTIFY, dan
--            sebagian prepared statement yang dipakai job queue.
-- ============================================================================
