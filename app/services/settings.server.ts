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

export interface AppSettings {
  plans: PlanConfig[];
  shippingAmountIdr: number;
}

// ADR-03 🔒: label memakai "tiap N hari", bukan "bulanan".
export const DEFAULT_SETTINGS: AppSettings = {
  plans: [
    { days: 30, enabled: true, discountPct: 10, label: "Tiap 30 hari" },
    { days: 60, enabled: true, discountPct: 12, label: "Tiap 60 hari" },
    { days: 90, enabled: true, discountPct: 15, label: "Tiap 90 hari" },
  ],
  shippingAmountIdr: Number(process.env.SHIPPING_AMOUNT_IDR || 0),
};

export async function getSettings(db: pg.Pool): Promise<AppSettings> {
  const { rows } = await db.query("select value from app_settings where key = 'app'");
  if (!rows.length) return DEFAULT_SETTINGS;
  const stored = rows[0].value as Partial<AppSettings>;
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    plans: stored.plans?.length ? (stored.plans as PlanConfig[]) : DEFAULT_SETTINGS.plans,
  };
}

export async function saveSettings(db: pg.Pool, settings: AppSettings): Promise<void> {
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
  await db.query(
    `insert into app_settings (key, value) values ('app', $1)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [JSON.stringify(settings)],
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
