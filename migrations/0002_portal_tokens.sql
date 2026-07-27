-- Token portal self-service (magic link + deep-link 1-tap dari WA).
-- Umur 15 menit, sekali pakai, scope terbatas per aksi (IMPLEMENTATION.md §7.6).
-- Yang disimpan HASH-nya (sha256 hex), bukan token mentah — bocornya tabel ini
-- tidak boleh berarti bocornya akses portal.

create table portal_tokens (
  token_hash        text primary key,
  subscription_id   uuid        not null references subscriptions(id) on delete cascade,
  -- 'full'   : portal lengkap (magic link)
  -- 'skip' | 'pause' | 'relink' : deep-link 1-tap dari WA, hanya aksi itu
  scope             text        not null check (scope in ('full', 'skip', 'pause', 'relink')),
  expires_at        timestamptz not null,
  used_at           timestamptz,
  created_at        timestamptz not null default now()
);

create index portal_tokens_subscription_idx on portal_tokens (subscription_id);

-- Job pembersih boleh menghapus token kedaluwarsa/terpakai lebih dari sehari.
create index portal_tokens_cleanup_idx on portal_tokens (expires_at);
