// Plan & pengaturan merchant. Default di kode; tabel app_settings menyimpan
// override. Diskon diterapkan SERVER-SIDE saat subscribe — client tidak pernah
// menentukan harga.
import type pg from "pg";

export interface PlanConfig {
  days: 30 | 60 | 90;
  enabled: boolean;
  discountPct: number; // 0–50, diskon dari harga varian per unit
  label: string;
}

export interface PlanProduct {
  gid: string;
  title: string;
  handle: string;
  imageUrl: string | null;
}

/** Toggle notifikasi per event. precharge_h3 TIDAK ada di sini — selalu terkirim 🔒. */
export interface NotificationToggles {
  welcome: boolean;
  charge_succeeded: boolean;
  dunning: boolean; // h0/h2/h4 sekaligus
  auto_paused: boolean;
  token_expiring: boolean;
}

export interface AppSettings {
  plans: PlanConfig[];
  shippingAmountIdr: number;
  /** Kosong = SEMUA produk bisa dilanggan; terisi = hanya produk terpilih. */
  products: PlanProduct[];
  notifications: NotificationToggles;
}

// ADR-03 🔒: label memakai "tiap N hari", bukan "bulanan".
export const DEFAULT_SETTINGS: AppSettings = {
  plans: [
    { days: 30, enabled: true, discountPct: 10, label: "Tiap 30 hari" },
    { days: 60, enabled: true, discountPct: 12, label: "Tiap 60 hari" },
    { days: 90, enabled: true, discountPct: 15, label: "Tiap 90 hari" },
  ],
  shippingAmountIdr: Number(process.env.SHIPPING_AMOUNT_IDR || 0),
  products: [],
  notifications: {
    welcome: true,
    charge_succeeded: true,
    dunning: true,
    auto_paused: true,
    token_expiring: true,
  },
};

export async function getSettings(db: pg.Pool): Promise<AppSettings> {
  const { rows } = await db.query("select value from app_settings where key = 'app'");
  if (!rows.length) return DEFAULT_SETTINGS;
  const stored = rows[0].value as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    plans: stored.plans?.length ? (stored.plans as PlanConfig[]) : DEFAULT_SETTINGS.plans,
    products: stored.products ?? [],
    notifications: { ...DEFAULT_SETTINGS.notifications, ...(stored.notifications ?? {}) },
  };
}

/** true kalau produk boleh dilanggan (daftar kosong = semua boleh). */
export function productSubscribable(settings: AppSettings, productGid: string | null | undefined): boolean {
  if (!settings.products.length) return true;
  return Boolean(productGid && settings.products.some((p) => p.gid === productGid));
}

/** Pemetaan notification kind → toggle. precharge_h3 selalu true 🔒. */
export function notificationEnabled(settings: AppSettings, kind: string): boolean {
  if (kind === "precharge_h3") return true; // janji legal — tidak bisa dimatikan
  const map: Record<string, keyof NotificationToggles> = {
    welcome: "welcome",
    charge_succeeded: "charge_succeeded",
    dunning_h0: "dunning",
    dunning_h2: "dunning",
    dunning_h4: "dunning",
    auto_paused: "auto_paused",
    token_expiring: "token_expiring",
  };
  const key = map[kind];
  return key ? settings.notifications[key] : true;
}

/** Patch sebagian setting — field yang tidak dikirim tetap seperti semula. */
export async function saveSettings(db: pg.Pool, patch: Partial<AppSettings>): Promise<void> {
  const current = await getSettings(db);
  const settings: AppSettings = {
    ...current,
    ...patch,
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
  };
  for (const p of settings.plans) {
    if (![30, 60, 90].includes(p.days)) throw new Error(`Frekuensi tidak sah: ${p.days}`);
    if (!Number.isFinite(p.discountPct) || p.discountPct < 0 || p.discountPct > 50) {
      throw new Error(`Diskon harus 0–50%: ${p.discountPct}`);
    }
  }
  if (!settings.plans.some((p) => p.enabled)) {
    throw new Error("Minimal satu frekuensi harus aktif");
  }
  if (!Number.isSafeInteger(settings.shippingAmountIdr) || settings.shippingAmountIdr < 0) {
    throw new Error("Ongkir harus integer ≥ 0");
  }
  for (const p of settings.products) {
    if (!p.gid?.startsWith("gid://shopify/Product/")) throw new Error(`Produk tidak sah: ${p.gid}`);
  }
  await db.query(
    `insert into app_settings (key, value) values ('app', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(settings)],
  );
}

/** URL halaman manajemen langganan di akun pelanggan (disalin dari editor). */
export async function getManagementUrl(db: pg.Pool): Promise<string | null> {
  const { rows } = await db.query("select value from app_settings where key = 'management_url'");
  return rows.length ? (rows[0].value as { url: string }).url : null;
}

export async function saveManagementUrl(db: pg.Pool, url: string): Promise<void> {
  if (!/^https:\/\/[^\s]+$/.test(url)) throw new Error("URL harus diawali https://");
  await db.query(
    `insert into app_settings (key, value) values ('management_url', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify({ url })],
  );
}

/** Harga unit setelah diskon plan — integer rupiah, dibulatkan ke bawah. */
export function discountedUnitIdr(baseUnitIdr: number, plan: PlanConfig): number {
  const v = Math.floor((baseUnitIdr * (100 - plan.discountPct)) / 100);
  if (!Number.isSafeInteger(v) || v <= 0) {
    throw new Error(`Harga setelah diskon tidak sah: ${v}`);
  }
  return v;
}
