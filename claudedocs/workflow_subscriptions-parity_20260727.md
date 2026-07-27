# Workflow — Paritas App Subscriptions Native (dengan arsitektur kita)

**27 Jul 2026 · output `/sc:workflow` · strategi: systematic**
Basis: app berjalan (dashboard, langganan, plans global, pengaturan beranotasi, widget PDP,
management UI akun pelanggan). Dokumen ini merencanakan fitur yang app native punya tapi kita
belum — diadaptasi ke aturan spec (`subscription-app/IMPLEMENTATION.md`).

---

## 0 · Analisis gap vs app Subscriptions native

| Fitur native | Status kita | Keputusan |
|---|---|---|
| Plans terikat ke PRODUK terpilih (product picker) | Plans kita global (semua produk) | **BANGUN** — scoping produk + resource picker |
| Edit notifications (pilih email mana yang terkirim) | Semua event selalu terkirim | **BANGUN** — toggle per event; **kecuali reminder H-3 yang tidak bisa dimatikan** 🔒 (janji legal — di sinilah kita sengaja beda dari native) |
| Retry attempts & action bisa diubah merchant | Terkunci by design | **TIDAK dibangun** — §7.4 terikat policy; native "Cancel subscription after retries" justru bertentangan dengan auto-pause 🔒 |
| Ubah tanggal/frekuensi kontrak dari admin | Detail admin baru bisa skip/pause/cancel | **BANGUN** — reschedule (date picker) + ubah frekuensi, wajib `assertH3Safe` |
| Widget snippet manual `<div>` | Sudah lebih baik (app block + deep link) | selesai |
| Management URL | selesai (simpan + copy) | selesai |

## 1 · Fase implementasi

### Fase A — Scoping produk untuk Plans
1. `settings.server.ts`: `AppSettings.products: {gid,title,handle,imageUrl}[]` — **kosong = semua produk bisa dilanggan** (kompatibel mundur); terisi = hanya produk terpilih.
2. `app.plans.tsx`: tombol "Pilih produk" → `shopify.resourcePicker({type:'product', multiple:true})` → simpan; daftar produk terpilih dengan thumbnail + hapus.
3. Penegakan SERVER-SIDE: `api.sub.create` tolak varian di luar daftar; `subscribe.$handle` → 404.

### Fase B — Toggle notifikasi per event
1. `AppSettings.notifications: Record<kind, boolean>` — kind: `welcome, charge_succeeded, dunning (h0/h2/h4 sekaligus), auto_paused, token_expiring`.
2. `notifySafe` menghormati toggle **kecuali `precharge_h3`** (selalu terkirim — gate F2 bergantung padanya).
3. UI switch di Pengaturan → kartu "Kustomisasi notifikasi"; H-3 ditampilkan terkunci dengan alasannya.

### Fase C — Aksi admin lanjutan di detail langganan
1. `subscription-lifecycle.server.ts`: `rescheduleSubscription(date)` — `assertH3Safe` + `atHourWIB`.
2. `app.subscriptions.$id.tsx`: s-date-field (reschedule) + s-select frekuensi (pakai `changeFrequency`), keduanya tercatat di events dengan actor admin.

### Fase D — Validasi & rilis
Typecheck + vitest + validator Polaris untuk halaman yang berubah → `fly deploy` → commit/push.
(Shopify `app deploy` tidak perlu — tidak ada perubahan extension.)

## 2 · Aturan yang menjaga

- Harga & kelayakan produk selalu diputuskan server (client tidak dipercaya).
- Semua mutasi jadwal lewat `assertH3Safe` 🔒.
- Toggle notifikasi tidak boleh bisa mematikan `precharge_h3` — bukan preferensi, penegakan janji legal.
