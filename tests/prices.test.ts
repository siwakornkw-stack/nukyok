import { describe, expect, it } from "vitest";
import { compareSuppliers, findLines, keepPrices, productKey, productOf, purchaseItem, unitPrice, type PriceLine, type PriceSupplier } from "@/lib/prices";

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

  it("compares thousands of products in one pass: a short search can match most of the lines", () => {
    // 10,000 products, each from two suppliers: well under a second; the quadratic pass took over 30 s, blocking the web
    const many = Array.from({ length: 20_000 }, (_, i) => l({ doc: `RR${i}`, sup: i % 2 ? "ก001" : "ก002", desc: `สินค้า ${i >> 1}`, qty: 1, net: 100 + (i % 2) }));
    const start = performance.now();
    const rows = compareSuppliers(many, data.items);
    expect(performance.now() - start).toBeLessThan(3000);
    expect(rows.length).toBe(20_000);
    expect(rows.filter((r) => r.cheapest).map((r) => r.sup)).toEqual(Array(10_000).fill("ก002"));
  });
});

describe("what the web keeps of the prices an office PC sent", () => {
  const s = (o: Partial<PriceSupplier>): PriceSupplier => ({ code: "", name: "", address: "", zip: "", phone: "", taxId: "", branch: "", remark: "", vat: "0", ...o });
  // as an agent from before purchaseItem sent them: every line on the purchase bills, every supplier's APMAS details
  const sent = {
    since: "2024-11-24",
    lines: [
      l({ doc: "RR691101-01", sup: "ย001" }),
      l({ doc: "RR691113-01", sup: "ย001", item: "5110-05", desc: "ค่าบริการถ่วงล้อ", qty: 1, net: 400 }), // a company's service
      l({ doc: "RR691109-01", sup: "ย001", item: "1150-05", desc: "เงินยืม" }), // a staff-type line on a company's bill
      l({ doc: "SA691031-01", sup: "พ999", item: "5301-01", desc: "เงินเดือนพนักงาน" }), // payroll
      l({ doc: "PE691110-01", sup: "น001", item: "5360-03", desc: "ยางใน" }), // an employee's reimbursed purchase
      l({ doc: "PE691001-01", sup: "น001", item: "1150-03", desc: "เงินยืม" }), // ... and their staff loan
      l({ doc: "RR691111-01", sup: "ช001", item: "5110-05", desc: "ค่าแรง 3 วัน" }), // a private person's service wage
      l({ doc: "RR691112-01", sup: "ช001", item: "5360-03", desc: "ค่าซ่อมไดชาร์จ" }), // ... and a repair from them
      l({ doc: "RR691115-01", sup: "ร001", item: "5360-08", desc: "ไส้กรอง" }), // a shop under its owner's ID
    ],
    items: { "TY-11R": "ยางรถบรรทุก 11R22.5", "5110-05": "ค่าจ้างบริการ", "1150-05": "เงินยืม", "5301-01": "เงินเดือน", "5360-03": "ค่าซ่อมแซม-ยานพาหนะ", "1150-03": "เงินยืม", "5360-08": "ค่าอะไหล่" },
    suppliers: [
      s({ code: "ย001", name: "หจก. ยางดี", address: "1 ถ.เทพกระษัตรี", zip: "83000", phone: "076-111111", taxId: "0833500000001", vat: "2" }),
      s({ code: "พ999", name: "เงินเดือนพนักงาน" }),
      s({ code: "น001", name: "พนักงานทดสอบ", address: "บ้านพัก", phone: "089-0000001", taxId: "3830100000001" }),
      s({ code: "ช001", name: "นาย ช่างทดสอบ", address: "9 หมู่ 1", zip: "83000", phone: "089-0000002", taxId: "3830100000002", remark: "บัญชีส่วนตัว" }),
      s({ code: "ร001", name: "ร้านอะไหล่ทดสอบ", address: "ตลาด", phone: "089-0000003", taxId: "3830100000003", branch: "0" }),
    ],
  };

  it("keeps purchases only: nothing of staff, no service wages of private persons, a private person by name only", () => {
    const p = keepPrices(sent);
    expect(p.lines.map((x) => x.doc)).toEqual(["RR691101-01", "RR691113-01", "RR691112-01", "RR691115-01"]);
    expect(p.suppliers).toEqual([
      sent.suppliers[0],
      s({ code: "ช001", name: "นาย ช่างทดสอบ" }),
      s({ code: "ร001", name: "ร้านอะไหล่ทดสอบ", branch: "0" }),
    ]);
    expect(Object.keys(p.items)).toEqual(["TY-11R", "5110-05", "5360-03", "5360-08"]);
    expect(p.since).toBe("2024-11-24");
  });

  it("reads a value saved before these rules with them; saved and then read, it stays the same", () => {
    // what the older web kept: the purchase lines with every supplier's APMAS details (an agent with purchaseItem
    // sends the same). No staff-type line comes with them: the employee น001 stays, by name only, until the agent
    // that leaves staff out runs
    const lines = sent.lines.filter((x) => purchaseItem(x.item));
    const older = { ...sent, lines, suppliers: sent.suppliers.filter((x) => lines.some((y) => y.sup === x.code)) };
    const p = keepPrices(older);
    expect(p.lines.map((x) => x.doc)).toEqual(["RR691101-01", "RR691113-01", "PE691110-01", "RR691112-01", "RR691115-01"]);
    expect(p.suppliers).toEqual([
      sent.suppliers[0],
      s({ code: "น001", name: "พนักงานทดสอบ" }),
      s({ code: "ช001", name: "นาย ช่างทดสอบ" }),
      s({ code: "ร001", name: "ร้านอะไหล่ทดสอบ", branch: "0" }),
    ]);
    expect(keepPrices(p)).toEqual(p);
    expect(keepPrices(keepPrices(sent))).toEqual(keepPrices(sent));
    // the same value with its suppliers cleared on the server: whose service wages they are is unknown, so none show
    expect(keepPrices({ ...older, suppliers: [] }).lines.map((x) => x.doc)).toEqual(["RR691101-01", "PE691110-01", "RR691112-01", "RR691115-01"]);
  });
});
