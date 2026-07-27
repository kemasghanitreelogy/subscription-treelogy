-- Konfigurasi app yang bisa diubah merchant dari admin (halaman Plans/Settings).
-- Key-value JSONB: fleksibel tanpa churn schema. Default hidup di kode
-- (app/services/settings.server.ts) — tabel hanya menyimpan override.

create table app_settings (
  key         text        primary key,
  value       jsonb       not null,
  updated_at  timestamptz not null default now()
);
