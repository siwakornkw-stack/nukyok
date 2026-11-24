import { describe, expect, it } from "vitest";
import { compareSuppliers, findLines, productKey, productOf, unitPrice, type PriceLine } from "@/lib/prices";

const l = (o: Partial<PriceLine>): PriceLine => ({
  date: "2026-11-01",
  doc: "RR691101-01",
  sup: "ย001",
  item: "TY-11R",
  desc: "",
  qty: 2,
  unit: "เส้น",
  price: 0,
  net: 16000,
  vat: "1",
  ...o,
});

const data = {
  items: { "TY-11R": "ยางรถบรรทุก 11R22.5", "5360-02": "ค่าซ่อมแซม-เครื่องจักร", "OIL-15W": "น้ำมันเครื่อง 15W-40" },
  lines: [
    l({}),
    l({ date: "2026-10-01", doc: "RR691001-01", net: 15000 }),
    l({ date: "2026-11-02", doc: "RR691102-01", sup: "ย002", net: 15800 }),
    l({ date: "2026-09-01", doc: "RR690901-01", sup: "ย003", net: 4100, qty: 1 }),
    l({ date: "2026-11-03", doc: "RR691103-01", sup: "อ001", item: "5360-02", desc: "เปลี่ยนยางใหม่ 2 เส้น 81-2147", qty: 1, unit: "งาน", net: 9000 }),
    l({ date: "2026-11-04", doc: "RR691104-01", sup: "ย001", item: "OIL-15W", desc: "", qty: 4, unit: "ลิตร", net: 520 }),
  ],
};

describe("เทียบราคา", () => {
  it("prices a unit before VAT", () => {
    expect(unitPrice(l({ net: 16000, qty: 2 }))).toBe(8000);
    expect(unitPrice(l({ net: 100, qty: 3 }))).toBe(33.33);
  });

  it("finds lines by item code, item name or line description, every word, newest first", () => {
    expect(findLines(data, "11r22.5").map((x) => x.doc)).toEqual(["RR691102-01", "RR691101-01", "RR691001-01", "RR690901-01"]);
    expect(findLines(data, "ยาง").map((x) => x.doc)).toEqual(["RR691103-01", "RR691102-01", "RR691101-01", "RR691001-01", "RR690901-01"]);
    expect(findLines(data, "ยาง 81-2147").map((x) => x.doc)).toEqual(["RR691103-01"]);
    expect(findLines(data, "oil-15w").map((x) => x.doc)).toEqual(["RR691104-01"]);
    expect(findLines(data, "  ")).toEqual([]);
    expect(findLines(data, "ไม่มีแน่นอน")).toEqual([]);
  });

  it("compares suppliers per product and unit: latest, lowest, highest, how often; cheapest latest price first", () => {
    const tyre = { product: "ยางรถบรรทุก 11R22.5", key: "ยางรถบรรทุก11r22.5", unit: "เส้น" }; // no line text: the item name
    expect(compareSuppliers(findLines(data, "TY-11R"), data.items)).toEqual([
      { ...tyre, sup: "ย003", count: 1, qty: 1, min: 4100, max: 4100, last: 4100, lastDate: "2026-09-01", lastDoc: "RR690901-01", cheapest: true },
      { ...tyre, sup: "ย002", count: 1, qty: 2, min: 7900, max: 7900, last: 7900, lastDate: "2026-11-02", lastDoc: "RR691102-01", cheapest: false },
      { ...tyre, sup: "ย001", count: 2, qty: 4, min: 7500, max: 8000, last: 8000, lastDate: "2026-11-01", lastDoc: "RR691101-01", cheapest: false },
    ]);
  });

  it("takes the product from the bill line, not the account-like item code", () => {
    // one service item (5360-10) for two different things from one shop: an inner tube and a new tyre
    const lines = [
      l({ doc: "RR691110-01", sup: "ภ017", item: "5360-10", desc: "ยางใน 215/70/15", qty: 1, net: 150 }),
      l({ doc: "RR691111-01", sup: "ภ017", item: "5360-10", desc: "ยางใหม่ 215/70/15", qty: 1, net: 7476.64 }),
      l({ doc: "RR691112-01", sup: "ภ012", item: "5360-10", desc: "ยางใหม่  215/70/15 ", qty: 2, net: 14000 }), // other spacing: the same product
    ];
    expect(compareSuppliers(lines, data.items).map((r) => [r.product, r.sup, r.min, r.max, r.cheapest])).toEqual([
      ["ยางใหม่  215/70/15 ", "ภ012", 7000, 7000, true],
      ["ยางใหม่ 215/70/15", "ภ017", 7476.64, 7476.64, false],
      ["ยางใน 215/70/15", "ภ017", 150, 150, false], // the only seller of it: nothing to be cheaper than
    ]);
    expect(productKey(productOf(lines[1], data.items))).toBe(productKey(productOf(lines[2], data.items)));
  });

  it("does not rank prices of different units against each other", () => {
    const rows = compareSuppliers([l({ sup: "ก001", unit: "กล่อง", net: 1200, qty: 1 }), l({ sup: "ก002", unit: "ชิ้น", net: 50, qty: 1 })], data.items);
    expect(rows.map((r) => [r.unit, r.sup, r.cheapest])).toEqual([
      ["กล่อง", "ก001", false],
      ["ชิ้น", "ก002", false],
    ]);
  });
});
