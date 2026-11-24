import { describe, expect, it } from "vitest";
import { parseSlip, slipFlags, type SlipRead } from "@/lib/fuel-checks";

// the replacement slip of the sample photos (Bangchak, 17/11/2026)
const answer = {
  invoice: "ต26102811017169",
  replaces: "ต26102811017168",
  date: "2026-11-17",
  plate: "81-2102 ภูเก็ต",
  liters: "72.674",
  pricePerLiter: "41.28",
  amount: "3,000.00",
  station: "บางจากกรีนเนท 10281-บายพาสภูเก็ต กม.4",
  buyerTaxId: "0835560010211",
};
const read = parseSlip(JSON.stringify(answer)) as SlipRead;
const typed = { liters: 72.674, pricePerLiter: 41.28, amount: 3000, invoice: "ต26102811017169", vehicleCode: "81-2102", date: "2026-11-17" };

describe("parseSlip", () => {
  it("reads numbers with commas and keeps every decimal", () => {
    expect(read).toMatchObject({ liters: 72.674, pricePerLiter: 41.28, amount: 3000, invoice: "ต26102811017169", buyerTaxId: "0835560010211" });
  });
  it("turns a Buddhist-era year into a Gregorian one", () => {
    expect(parseSlip(JSON.stringify({ ...answer, date: "2569-11-17" }))?.date).toBe("2026-11-17");
  });
  it("drops what is not a number or a date", () => {
    expect(parseSlip(JSON.stringify({ ...answer, liters: "", amount: "abc", date: "17/11/2026" }))).toMatchObject({ liters: null, amount: null, date: "" });
  });
  it("is null for non-JSON, an array or an answer with nothing a slip holds", () => {
    expect(parseSlip("not json")).toBeNull();
    expect(parseSlip("[]")).toBeNull();
    expect(parseSlip(JSON.stringify({ station: "x" }))).toBeNull();
  });
});

describe("slipFlags", () => {
  const codes = (x: Partial<typeof typed>, r: SlipRead | null = read) => slipFlags(r, { ...typed, ...x }).map((f) => f.code);

  it("only notes the replacement when everything matches", () => {
    expect(codes({})).toEqual(["slip_replaces"]);
  });
  it("matches a plate with its province and an invoice typed without the Thai prefix", () => {
    expect(codes({ vehicleCode: "81 2102", invoice: "26102811017169" })).toEqual(["slip_replaces"]);
  });
  it("tolerates litres rounded to 2 decimals", () => {
    expect(codes({ liters: 72.67 })).toEqual(["slip_replaces"]);
  });
  it("flags each number, the invoice, the plate and the date that differ", () => {
    expect(codes({ liters: 80, pricePerLiter: 40, amount: 3300, invoice: "ต26102811017168", vehicleCode: "81-2991", date: "2026-11-18" })).toEqual([
      "slip_liters",
      "slip_price",
      "slip_amount",
      "slip_invoice",
      "slip_plate",
      "slip_date",
      "slip_replaces",
    ]);
  });
  it("checks nothing without a reading", () => {
    expect(codes({ liters: 999 }, null)).toEqual([]);
  });
});
