// Aritmetika kalender WIB. SEMUA mutasi jadwal langganan lewat fungsi di file
// ini — terutama assertH3Safe, yang menegakkan janji legal reminder H-3 di
// /policies/subscription-policy (IMPLEMENTATION.md §3.2).
import { DateTime } from "luxon";

export const WIB = process.env.APP_TIMEZONE || "Asia/Jakarta";
export const CHARGE_HOUR_WIB = Number(process.env.CHARGE_HOUR_WIB || 10);
export const PRECHARGE_HOUR_WIB = Number(process.env.PRECHARGE_HOUR_WIB || 9);

export class PolicyViolation extends Error {}

/** Tanggal WIB 'YYYY-MM-DD' dari sebuah instan. */
export function todayWIB(now: Date = new Date()): string {
  return DateTime.fromJSDate(now, { zone: WIB }).toISODate()!;
}

/** Tambah n hari ke tanggal WIB 'YYYY-MM-DD'. */
export function addDaysWIB(dateWIB: string, days: number): string {
  const d = DateTime.fromISO(dateWIB, { zone: WIB });
  if (!d.isValid) throw new Error(`Tanggal tidak sah: ${dateWIB}`);
  return d.plus({ days }).toISODate()!;
}

/**
 * Siklus berikutnya = tanggal siklus terakhir + frequency_days (ADR-03:
 * aritmetika HARI, bukan bulan — tidak ada kasus tepi tanggal 31).
 */
export function nextChargeDate(lastCycleWIB: string, frequencyDays: number): string {
  if (!Number.isInteger(frequencyDays) || frequencyDays < 7 || frequencyDays > 365) {
    throw new Error(`frequency_days di luar rentang: ${frequencyDays}`);
  }
  return addDaysWIB(lastCycleWIB, frequencyDays);
}

/**
 * 🔒 Penegakan janji H-3: setiap next_charge_date baru (resume, reschedule,
 * ubah frekuensi) minimal H+3 dari hari ini WIB. Ini janji legal, bukan UX.
 */
export function assertH3Safe(nextChargeDateWIB: string, now: Date = new Date()): void {
  const minimum = addDaysWIB(todayWIB(now), 3);
  if (nextChargeDateWIB < minimum) {
    throw new PolicyViolation(
      `next_charge_date ${nextChargeDateWIB} melanggar jaminan reminder H-3 (minimum ${minimum})`,
    );
  }
}

/**
 * Payday-aware (§7.4): percobaan final yang jatuh tanggal 20–24 digeser ke 25 —
 * mayoritas gajian Indonesia turun tanggal 25 / akhir bulan.
 */
export function paydayAwareDate(candidateWIB: string): string {
  const d = DateTime.fromISO(candidateWIB, { zone: WIB });
  if (!d.isValid) throw new Error(`Tanggal tidak sah: ${candidateWIB}`);
  if (d.day >= 20 && d.day <= 24) return d.set({ day: 25 }).toISODate()!;
  return candidateWIB;
}

/** Instan UTC untuk jam tertentu WIB pada tanggal WIB. Default jam charge 10:00. */
export function atHourWIB(dateWIB: string, hour: number = CHARGE_HOUR_WIB): Date {
  const d = DateTime.fromISO(dateWIB, { zone: WIB }).set({
    hour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  if (!d.isValid) throw new Error(`Tanggal tidak sah: ${dateWIB}`);
  return d.toJSDate();
}

/**
 * Jadwal retry dunning (§7.4). attempt_n adalah percobaan yang BARU SAJA gagal;
 * hasil = kapan percobaan berikutnya. null = jatah habis → AUTO-PAUSE.
 */
export function nextDunningAttemptAt(
  failedAttemptN: number,
  cycleDateWIB: string,
  now: Date = new Date(),
): Date | null {
  const nowDt = DateTime.fromJSDate(now, { zone: WIB });
  switch (failedAttemptN) {
    case 1: // retry +6 jam
      return nowDt.plus({ hours: 6 }).toJSDate();
    case 2: // +24 jam, jam berbeda: 14:00 WIB
      return nowDt.plus({ hours: 24 }).set({ hour: 14, minute: 0, second: 0, millisecond: 0 }).toJSDate();
    case 3: // +72 jam
      return nowDt.plus({ hours: 72 }).toJSDate();
    case 4: {
      // final: hari ke-5–7 dari siklus, payday-aware
      const candidate = paydayAwareDate(addDaysWIB(cycleDateWIB, 6));
      return atHourWIB(candidate);
    }
    default:
      return null; // semua retry habis
  }
}

/** Total tagihan = (unit × qty) + shipping. Integer rupiah penuh, tanpa pembulatan. */
export function totalAmountIdr(unitAmountIdr: number, quantity: number, shippingAmountIdr: number): number {
  for (const [name, v] of Object.entries({ unitAmountIdr, quantity, shippingAmountIdr })) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${name} bukan integer aman: ${v}`);
  }
  const total = unitAmountIdr * quantity + shippingAmountIdr;
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error(`Total tidak sah: ${total}`);
  return total;
}

/** Kunci idempotensi rantai §9.1 — deterministik, dipakai juga sebagai reference_id Xendit. */
export function idempotencyKey(subscriptionId: string, scheduledForWIB: string, attemptN: number): string {
  return `sub_${subscriptionId}_cycle_${scheduledForWIB}_att_${attemptN}`;
}
