import { describe, expect, it } from "vitest";
import { vehicleChanges } from "@/app/api/vehicles/[id]/fields";
import { plateKey, pmState } from "@/lib/summary";

describe("vehicleChanges (the vehicle form writes only what the user changed, guarded on what it loaded)", () => {
  // what the page loaded (Decimals as numbers, as dec() gives them) and what an untouched form posts
  const loaded = { code: "SY140-01", model: "PC200", litersPerHour: 8.3, tankLiters: 0.07, pmEveryHours: 500, pmLastHours: 8456.7, expressItem: "D01", expressDep: "", note: "a\nb", active: "1" };
  const form: Record<string, string | null> = { code: "SY140-01", model: "PC200", litersPerHour: "8.30", tankLiters: "0.07", pmEveryHours: "500", pmLastHours: "8456.7", expressItem: "D01", expressDep: "", note: "a\r\nb", active: "1" };
  const changes = (x: Record<string, string | null>) => vehicleChanges((k) => ({ ...form, ...x })[k] ?? null, loaded);

  it("writes nothing for an untouched form (8.30 = 8.3, \\r\\n = \\n)", () => {
    expect(changes({})).toEqual({ data: {}, where: {} });
  });
  it("sends Decimal columns as exact text, never a float Prisma would make 8456.700000000001", () => {
    expect(changes({ pmLastHours: "8500" })).toEqual({ data: { pmLastHours: "8500" }, where: { pmLastHours: "8456.7" } });
    expect(changes({ litersPerHour: "", tankLiters: "1,200.5" })).toEqual({
      data: { litersPerHour: null, tankLiters: "1200.5" },
      where: { litersPerHour: "8.3", tankLiters: "0.07" },
    });
  });
  it("keeps whole numbers and the rest as they are", () => {
    expect(changes({ pmEveryHours: "600", active: null, expressItem: " D02 " })).toEqual({
      data: { pmEveryHours: 600, active: false, expressItem: "D02" },
      where: { pmEveryHours: 500, active: true, expressItem: "D01" },
    });
  });
  it("refuses invalid numbers", () => {
    const bad: Record<string, string>[] = [{ pmEveryHours: "1.5" }, { litersPerHour: "-1" }, { tankLiters: "abc" }, { pmLastHours: "2000000" }];
    for (const x of bad) expect(changes(x), JSON.stringify(x)).toBeNull();
  });
});

describe("pmState (service due)", () => {
  it("is unknown, not due, without a reading of the last service", () => {
    // a fleet-wide interval with blank "เช็คล่าสุดที่" must not flag every older vehicle over LINE
    expect(pmState({ pmEveryHours: 500, pmLastHours: null }, 4200)).toBeNull();
    expect(pmState({ pmEveryHours: null, pmLastHours: "1000" }, 4200)).toBeNull();
    expect(pmState({ pmEveryHours: 500, pmLastHours: "1000" }, undefined)).toBeNull();
  });
  it("counts from the last service when it is known (0 included)", () => {
    expect(pmState({ pmEveryHours: 300, pmLastHours: "0" }, 300)).toEqual({ due: 300, state: "over" });
    expect(pmState({ pmEveryHours: 500, pmLastHours: "1000" }, 1460)).toEqual({ due: 1500, state: "near" });
    expect(pmState({ pmEveryHours: 500, pmLastHours: "1000" }, 1200)).toEqual({ due: 1500, state: "ok" });
  });
});

describe("plateKey (one truck, one record)", () => {
  it("ignores case, spaces, dots and dashes like the drivers' plate match", () => {
    expect(plateKey("ผบ 1234")).toBe(plateKey("ผบ-1234"));
    expect(plateKey("sy140-01")).toBe(plateKey("SY 140.01"));
    expect(plateKey("70-1826")).not.toBe(plateKey("70-1827"));
  });
});
