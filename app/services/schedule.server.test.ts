// §12.1 — aritmetika yang harus benar. assertH3Safe adalah penegakan janji
// legal; test ini bagian dari kontraknya.
import { describe, expect, it } from "vitest";
import {
  addDaysWIB,
  assertH3Safe,
  atHourWIB,
  idempotencyKey,
  nextChargeDate,
  nextDunningAttemptAt,
  paydayAwareDate,
  PolicyViolation,
  todayWIB,
  totalAmountIdr,
} from "./schedule.server";

// 2026-07-27 15:00 WIB = 08:00 UTC
const NOW = new Date("2026-07-27T08:00:00Z");

describe("todayWIB", () => {
  it("mengembalikan tanggal WIB, bukan UTC", () => {
    // 2026-07-27 23:30 WIB = 16:30 UTC → masih 27 Jul WIB
    expect(todayWIB(new Date("2026-07-27T16:30:00Z"))).toBe("2026-07-27");
    // 2026-07-28 01:00 WIB = 27 Jul 18:00 UTC → sudah 28 Jul WIB
    expect(todayWIB(new Date("2026-07-27T18:00:00Z"))).toBe("2026-07-28");
  });
});

describe("nextChargeDate (ADR-03: hari, bukan bulan)", () => {
  it("melewati akhir bulan tanpa kasus tepi", () => {
    expect(nextChargeDate("2026-01-31", 30)).toBe("2026-03-02");
  });
  it("melewati tahun kabisat", () => {
    expect(nextChargeDate("2028-01-31", 30)).toBe("2028-03-01"); // 2028 kabisat
    expect(nextChargeDate("2026-12-15", 30)).toBe("2027-01-14");
  });
  it("menolak frekuensi di luar 7–365", () => {
    expect(() => nextChargeDate("2026-07-27", 5)).toThrow();
    expect(() => nextChargeDate("2026-07-27", 400)).toThrow();
  });
});

describe("assertH3Safe 🔒", () => {
  it("menolak H+0, H+1, H+2", () => {
    expect(() => assertH3Safe("2026-07-27", NOW)).toThrow(PolicyViolation);
    expect(() => assertH3Safe("2026-07-28", NOW)).toThrow(PolicyViolation);
    expect(() => assertH3Safe("2026-07-29", NOW)).toThrow(PolicyViolation);
  });
  it("menerima H+3 dan seterusnya", () => {
    expect(() => assertH3Safe("2026-07-30", NOW)).not.toThrow();
    expect(() => assertH3Safe("2026-08-26", NOW)).not.toThrow();
  });
});

describe("paydayAwareDate (§7.4)", () => {
  it.each([
    ["2026-08-19", "2026-08-19"],
    ["2026-08-20", "2026-08-25"],
    ["2026-08-24", "2026-08-25"],
    ["2026-08-25", "2026-08-25"],
    ["2026-08-26", "2026-08-26"],
  ])("%s → %s", (input, expected) => {
    expect(paydayAwareDate(input)).toBe(expected);
  });
});

describe("atHourWIB", () => {
  it("10:00 WIB = 03:00 UTC (tidak ada DST di Indonesia)", () => {
    expect(atHourWIB("2026-07-27", 10).toISOString()).toBe("2026-07-27T03:00:00.000Z");
  });
  it("benar di sekitar pergantian tahun", () => {
    expect(atHourWIB("2027-01-01", 10).toISOString()).toBe("2027-01-01T03:00:00.000Z");
    expect(atHourWIB("2026-12-31", 10).toISOString()).toBe("2026-12-31T03:00:00.000Z");
  });
});

describe("nextDunningAttemptAt (§7.4)", () => {
  it("gagal ke-1 → +6 jam", () => {
    const next = nextDunningAttemptAt(1, "2026-07-27", NOW)!;
    expect(next.toISOString()).toBe("2026-07-27T14:00:00.000Z"); // 15:00+6=21:00 WIB
  });
  it("gagal ke-2 → +24 jam di 14:00 WIB", () => {
    const next = nextDunningAttemptAt(2, "2026-07-27", NOW)!;
    expect(next.toISOString()).toBe("2026-07-28T07:00:00.000Z"); // 14:00 WIB
  });
  it("gagal ke-4 → final payday-aware (siklus 27 Jul + 6 hari = 2 Agu, bukan 20–24)", () => {
    const next = nextDunningAttemptAt(4, "2026-07-27", NOW)!;
    expect(next.toISOString()).toBe("2026-08-02T03:00:00.000Z"); // 10:00 WIB
  });
  it("final digeser ke tgl 25 kalau jatuh 20–24", () => {
    // siklus 15 Agu + 6 = 21 Agu → geser ke 25 Agu
    const next = nextDunningAttemptAt(4, "2026-08-15", NOW)!;
    expect(next.toISOString()).toBe("2026-08-25T03:00:00.000Z");
  });
  it("gagal ke-5 → null (AUTO-PAUSE)", () => {
    expect(nextDunningAttemptAt(5, "2026-07-27", NOW)).toBeNull();
  });
});

describe("totalAmountIdr", () => {
  it("(unit × qty) + shipping, integer penuh", () => {
    expect(totalAmountIdr(586500, 1, 15000)).toBe(601500);
    expect(totalAmountIdr(586500, 2, 0)).toBe(1173000);
  });
  it("menolak float dan negatif", () => {
    expect(() => totalAmountIdr(586500.5, 1, 0)).toThrow();
    expect(() => totalAmountIdr(586500, -1, 0)).toThrow();
    expect(() => totalAmountIdr(0, 1, 0)).toThrow();
  });
});

describe("idempotencyKey (§9.1)", () => {
  it("deterministik dari (sub, siklus, attempt)", () => {
    expect(idempotencyKey("abc", "2026-08-26", 1)).toBe("sub_abc_cycle_2026-08-26_att_1");
    expect(idempotencyKey("abc", "2026-08-26", 1)).toBe(idempotencyKey("abc", "2026-08-26", 1));
  });
});

describe("addDaysWIB", () => {
  it("aritmetika tanggal murni", () => {
    expect(addDaysWIB("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDaysWIB("2028-02-28", 1)).toBe("2028-02-29"); // kabisat
  });
});
