import { describe, expect, it } from "vitest";
import { isDateKey } from "@/lib/time";

describe("isDateKey (every date filter and report)", () => {
  it("accepts real dates", () => {
    for (const d of ["2026-11-24", "2026-11-30", "2026-12-31", "2026-01-01", "2024-02-29", "2000-01-01", "2099-12-31"]) expect(isDateKey(d), d).toBe(true);
  });
  it("refuses dates that do not exist (Date.parse rolls them into the next month)", () => {
    for (const d of ["2026-11-31", "2026-02-29", "2026-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-11-00", "2026-11-32"]) expect(isDateKey(d), d).toBe(false);
  });
  it("refuses other shapes, years outside 2000-2099 (a Buddhist-era year) and non-strings", () => {
    for (const d of ["0000-01-01", "1999-12-31", "2100-01-01", "2569-11-24", "2026-11-1", "2026/11/24", " 2026-11-24", "2026-11-24T00:00", "", null, undefined, 20261124, ["2026-11-24"], {}])
      expect(isDateKey(d), String(d)).toBe(false);
  });
  it("checks a ?month of /office/costs as its first day", () => {
    expect(isDateKey(`${"2026-11"}-01`)).toBe(true);
    for (const m of ["2026-13", "2026-00", "2026-1", "", "2026-11-01"]) expect(isDateKey(`${m}-01`), m).toBe(false);
  });
});
