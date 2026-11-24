import { describe, expect, it } from "vitest";
import { fuelFlags, readingText } from "@/lib/fuel-checks";

type Input = Parameters<typeof fuelFlags>[0];

const t0 = new Date("2026-11-01T08:00:00+07:00");
const after = (h: number) => new Date(t0.getTime() + h * 3_600_000);

// A normal day: 24 h after the last fill, +10 engine hours, +100 km, 100 L at 30 baht
// (10 L/h against a standard of 12), the driver clocked 10 h.
const normal: Input = {
  liters: 100,
  pricePerLiter: 30,
  amount: 3000,
  engineHours: 1010,
  odometer: 5100,
  at: after(24),
  vehicle: { litersPerHour: 12, tankLiters: 230 },
  prev: { engineHours: 1000, odometer: 5000, at: t0 },
  workedHours: 10,
  asked: null,
};
const codes = (o: Partial<Input> = {}) => fuelFlags({ ...normal, ...o }).map((f) => f.code);

describe("fuelFlags", () => {
  it("passes a clean fill", () => {
    expect(fuelFlags(normal)).toEqual([]);
  });

  it("flags an amount that does not match litres x price", () => {
    expect(codes({ amount: 3002 })).toEqual(["amount_mismatch"]);
    expect(codes({ amount: 3000.9 })).toEqual([]);
    expect(fuelFlags({ ...normal, amount: 3002 })[0].text).toContain("3,000.00");
  });

  it("flags more litres than the tank holds", () => {
    expect(codes({ liters: 245, amount: 7350, engineHours: 1020, workedHours: 20 })).toEqual(["over_tank"]);
    expect(codes({ liters: 240, amount: 7200, engineHours: 1020, workedHours: 20 })).toEqual([]);
  });

  it("flags engine hours going back or growing faster than the clock", () => {
    expect(codes({ engineHours: 990 })).toEqual(["hours_back"]);
    expect(codes({ engineHours: 1030, workedHours: 30 })).toEqual(["hours_jump"]);
  });

  it("flags the odometer going back or jumping", () => {
    expect(codes({ odometer: 4990 })).toEqual(["odo_back"]);
    expect(codes({ odometer: 5000 + 120 * 24 + 1 })).toEqual(["odo_jump"]);
  });

  it("flags litres per engine hour above the standard", () => {
    const f = fuelFlags({ ...normal, liters: 150, amount: 4500 });
    expect(f.map((x) => x.code)).toEqual(["lph_high"]);
    expect(f[0].text).toBe("ใช้น้ำมัน 15 ลิตร/ชม. เกินมาตรฐาน 12 ลิตร/ชม.");
    expect(codes({ liters: 140, amount: 4200 })).toEqual([]);
  });

  it("flags engine hours above the hours clocked in", () => {
    expect(codes({ workedHours: 5 })).toEqual(["hours_over_work"]);
    expect(codes({ workedHours: 9 })).toEqual([]);
    expect(codes({ workedHours: null })).toEqual([]);
  });

  it("flags litres put in with no change in engine hours", () => {
    expect(codes({ engineHours: 1000, workedHours: 10 })).toEqual(["hours_same"]);
  });

  it("flags fills too close together", () => {
    expect(codes({ at: after(5), engineHours: 1004, liters: 40, amount: 1200, odometer: 5050 })).toEqual(["too_frequent"]);
  });

  it("without a previous fill runs only the self-contained checks", () => {
    expect(codes({ prev: null, workedHours: null, engineHours: 1 })).toEqual([]);
    expect(codes({ prev: null, workedHours: null, liters: 300, amount: 1 })).toEqual(["amount_mismatch", "over_tank"]);
  });

  it("flags a pump reading the driver's could not have become (meters only go up, as fast as the clock)", () => {
    // asked 30 min before the fill: up to 0.5 h + 0.5 h slack, up to 120 km/h x 0.5 h + 5 km
    const asked = (engineHours: number | null, odometer: number | null) => ({ asked: { engineHours, odometer, at: after(23.5) } });
    expect(codes(asked(1009.6, 5090))).toEqual([]);
    expect(codes(asked(1009, 5100 - 65))).toEqual([]);
    expect(codes(asked(1010.5, 5100))).toEqual(["hours_driver"]);
    expect(codes(asked(1008.9, 5100))).toEqual(["hours_driver"]);
    expect(codes(asked(1010, 5101))).toEqual(["odo_driver"]);
    expect(codes(asked(1010, 5100 - 65.1))).toEqual(["odo_driver"]);
    // no odometer on either side, or the driver typed none (an old request: no hours either)
    expect(codes({ ...asked(1010, 5000), odometer: null })).toEqual([]);
    expect(codes(asked(null, null))).toEqual([]);
    expect(fuelFlags({ ...normal, ...asked(1012, null) })[0].text).toBe("ชั่วโมงเครื่องตอนเติม 1,010 ต่างจากที่คนขับแจ้ง 1,012 (-2 ชม. ห่างกัน 0.5 ชม.)");
  });

  it("shows the pump reading with its difference from the driver's", () => {
    expect(readingText(1236.5, 1235)).toBe("1,236.5 (คนขับแจ้ง 1,235 ต่าง +1.5)");
    expect(readingText(1100.3, 1100.1)).toBe("1,100.3 (คนขับแจ้ง 1,100.1 ต่าง +0.2)");
    expect(readingText(5000, 5000)).toBe("5,000 (คนขับแจ้ง 5,000 ต่าง 0)");
    expect(readingText(5000, null)).toBe("5,000");
    expect(readingText(null, 5000)).toBe("-");
  });

  it("skips checks whose inputs are missing", () => {
    const tank = { pricePerLiter: null, amount: null, odometer: null, vehicle: { litersPerHour: null, tankLiters: null } };
    expect(codes({ ...tank, liters: 400 })).toEqual([]);
  });
});
