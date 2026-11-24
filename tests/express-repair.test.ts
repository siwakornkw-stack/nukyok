import { describe, expect, it } from "vitest";
import { buildRepairMasters, planRepair } from "../scripts/express/repair.mjs";

const isprd = [{ BEG1NY: "2021-01-01", END1NY: "2027-01-31", LOCK1NY: "N", BEG2NY: "2027-02-01", END2NY: "2027-02-28", LOCK2NY: "Y" }];

// Rows shaped like DHEWA66's (office PC read 2026-11-18): reference bills PO0002945 / RR691031-03
// (พ042, VAT on top) and PO0003072 / RR691118-01 (ก026, keyed with prices including VAT although
// its APMAS.FLGVAT is 2).
const tables = (extra: Record<string, unknown[]> = {}) => ({
  stmas: [
    { STKCOD: "5360-02", STKDES: "ค่าซ่อมแซม-เครื่องจักร", STKTYP: "5", PQUCOD: "คง", ACCCOD: "000h" },
    { STKCOD: "5360-08", STKDES: "ค่าอะไหล่-เครื่องจักร", STKTYP: "5", PQUCOD: "คง", ACCCOD: "000U" },
    { STKCOD: "PART-01", STKDES: "ไส้กรอง", STKTYP: "0", PQUCOD: "ชน", ACCCOD: "000h" },
    { STKCOD: "SV-NOUNIT", STKDES: "ค่าแรง", STKTYP: "5", PQUCOD: "", ACCCOD: "000h" },
    { STKCOD: "SV-NOACC", STKDES: "ค่าแรง", STKTYP: "5", PQUCOD: "คง", ACCCOD: "zzzz" },
  ],
  // ACCCOD is case-sensitive: 000H is another account (ภงด.53)
  isacc: [
    { ACCCOD: "000H", ACCNUM01: "2132-03" },
    { ACCCOD: "000h", ACCNUM01: "5360-02" },
    { ACCCOD: "000U", ACCNUM01: "5360-08" },
  ],
  apmas: [
    { SUPCOD: "พ042", SUPNAM: "พยัพพันธ์ จันดาหาร", PRENAM: "นาย", TAXID: "3420600035370", ORGNUM: "0", FLGVAT: "2" },
    { SUPCOD: "ก026", SUPNAM: "เกาะแก้วชัยสตีล", PRENAM: "หจก.", TAXID: "0833539000324", ORGNUM: "0", FLGVAT: "2" },
    { SUPCOD: "น013", SUPNAM: "ร้านน้องใหม่การยาง", PRENAM: "", TAXID: "", ORGNUM: "0", FLGVAT: "0" },
  ],
  aptrn: [{ RECTYP: "3", DOCNUM: "RR691031-03", DOCDAT: "2026-10-31", SUPCOD: "พ042", REFNUM: "041/2025", PONUM: "PO0002945", DOCSTAT: "N", NETAMT: 856 }],
  isprd,
  isrun: [
    { DOCTYP: "RR", PREFIX: "RR", ACCNUM01: "5110-01", ACCNUM02: "1164-01", ACCNUM03: "2110-01" },
    { DOCTYP: "RR", PREFIX: "R3", ACCNUM01: "2111-02", ACCNUM02: "1164-01", ACCNUM03: "2111-02" },
    { DOCTYP: "PO", PREFIX: "PO" },
    { DOCTYP: "PO", PREFIX: "PK" },
  ],
  ...extra,
});

const order = (o: Record<string, unknown> = {}) => ({
  id: "r1",
  supplier: "พ042",
  item: "5360-02",
  dep: "C020",
  date: "2026-11-18",
  invoice: "042/2025",
  amount: 856,
  vat: "2",
  job: "แก้เปลี่ยนแม่ปั๊มคลัชบน",
  plate: "87-8212",
  ...o,
});

const opts = { prefix: "PO" };

describe("repair PO + RR plan", () => {
  it("plans a PO + RR like RR691031-03: VAT on top, the item's own account, Cr trade payables", () => {
    expect(planRepair(order(), tables(), opts)).toEqual({
      status: "ready",
      orderId: "r1",
      date: "2026-11-18",
      invoice: "042/2025",
      user: "WEB",
      poPrefix: "PO",
      rrPrefix: "RR691118-",
      flgvat: "2",
      supplier: { code: "พ042", name: "พยัพพันธ์ จันดาหาร", prenam: "นาย", taxId: "3420600035370", branch: 0 },
      item: { code: "5360-02", desc: "แก้เปลี่ยนแม่ปั๊มคลัชบน", unit: "คง" },
      job: "แก้เปลี่ยนแม่ปั๊มคลัชบน",
      plate: "87-8212",
      dep: "C020",
      price: 800,
      net: 800,
      vat: 56,
      total: 856,
      accounts: { expense: "5360-02", vat: "1164-01", pay: "2110-01" },
      balColumn: "RR1NY",
    });
  });

  it("books VAT as on the tax invoice, not as the supplier is set up (APMAS.FLGVAT)", () => {
    // RR691118-01: prices include VAT, 6,720 = 6,280.37 + 439.63, the line keyed at 6,720
    expect(planRepair(order({ supplier: "ก026", item: "5360-08", amount: 6720, vat: "1" }), tables(), opts)).toMatchObject({
      flgvat: "1", price: 6720, net: 6280.37, vat: 439.63, total: 6720, accounts: { expense: "5360-08" },
    });
    // a bill without VAT: no VAT line, the whole amount is the expense (also from a garage set up with VAT)
    expect(planRepair(order({ supplier: "น013", amount: 3500, vat: "0" }), tables(), opts)).toMatchObject({ flgvat: "0", price: 3500, net: 3500, vat: 0, total: 3500 });
    expect(planRepair(order({ vat: "0" }), tables(), opts)).toMatchObject({ flgvat: "0", net: 856, vat: 0 });
    // VAT on top: the price the bill was made from (1,000 = 934.58 + 65.42)
    expect(planRepair(order({ amount: 1000 }), tables(), opts)).toMatchObject({ price: 934.58, net: 934.58, vat: 65.42, total: 1000 });
    // no price + ROUND(price x 7%, 2) gives 1,000.07: a typo, not booked
    expect(planRepair(order({ amount: 1000.07 }), tables(), opts).reason).toMatch(/VAT 7%/);
  });

  it("writes nothing when the tax invoice already has an RR of the same supplier and amount", () => {
    const same = order({ invoice: "041/2025" });
    expect(planRepair(same, tables(), opts)).toEqual({ status: "exists", poNo: "PO0002945", rrNo: "RR691031-03" });
    // a garage reusing an invoice number (new book, other amount) is a new bill
    expect(planRepair(order({ invoice: "041/2025", amount: 321 }), tables(), opts).status).toBe("ready");
    // the same number and amount from another garage, 200 days apart, or cancelled is another bill
    const rr = tables().aptrn[0];
    expect(planRepair(same, tables({ aptrn: [{ ...rr, SUPCOD: "ก026" }] }), opts).status).toBe("ready");
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCDAT: "2026-05-02" }] }), opts).status).toBe("ready");
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCSTAT: "C" }] }), opts).status).toBe("ready");
    // 90 days apart still counts (repair-write.ps1: ABS(docdat - date) <= 90)
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCDAT: "2026-08-20" }] }), opts).status).toBe("exists");
  });

  it("refuses what it cannot book safely", () => {
    expect(planRepair(order({ supplier: "Y" }), tables(), opts).reason).toMatch(/ผู้จำหน่าย/);
    expect(planRepair(order({ vat: undefined }), tables(), opts).reason).toMatch(/VAT ในใบกำกับ/);
    expect(planRepair(order({ vat: "7" }), tables(), opts).reason).toMatch(/VAT ในใบกำกับ/);
    expect(planRepair(order({ item: "PART-01" }), tables(), opts).reason).toMatch(/สินค้าคงคลัง/);
    expect(planRepair(order({ item: "SV-NOUNIT" }), tables(), opts).reason).toMatch(/หน่วยซื้อ/);
    expect(planRepair(order({ item: "SV-NOACC" }), tables(), opts).reason).toMatch(/บัญชีค่าใช้จ่าย/);
    expect(planRepair(order({ amount: 0 }), tables(), opts).reason).toMatch(/ศูนย์/);
    expect(planRepair(order({ date: "2027-02-10" }), tables(), opts).reason).toMatch(/ปิดแล้ว/);
    expect(planRepair(order(), tables({ isrun: tables().isrun.filter((r) => r.PREFIX !== "PO") }), opts).reason).toMatch(/เลขรันของ PO/);
    expect(planRepair(order(), tables({ isrun: tables().isrun.filter((r) => r.PREFIX !== "RR") }), opts).reason).toMatch(/บัญชีของ RR/);
  });
});

describe("repair master data", () => {
  it("takes suppliers and service items from the PO book only", () => {
    const m = buildRepairMasters({
      popr: [
        { PONUM: "PO0000001", SUPCOD: "อ001", PODAT: "2026-09-01", DOCSTAT: "M", DEPCOD: "03" },
        { PONUM: "PK0000001", SUPCOD: "บ015", PODAT: "2026-10-01", DOCSTAT: "N", DEPCOD: "" },
        { PONUM: "PO0000002", SUPCOD: "อ002", PODAT: "2026-09-02", DOCSTAT: "C", DEPCOD: "" },
      ],
      poprit: [
        { PONUM: "PO0000001", STKCOD: "SV-REPAIR", STKDES: "ค่าซ่อม", DEPCOD: "" },
        { PONUM: "PO0000001", STKCOD: "PART-01", STKDES: "ไส้กรอง", DEPCOD: "" },
        { PONUM: "PK0000001", STKCOD: "70-1826", STKDES: "น้ำมัน", DEPCOD: "" },
      ],
      stmas: [
        { STKCOD: "SV-REPAIR", STKDES: "ค่าซ่อมรถ", STKTYP: "5", PQUCOD: "งน" },
        { STKCOD: "PART-01", STKDES: "ไส้กรอง", STKTYP: "0", PQUCOD: "ชน" },
      ],
      apmas: [{ SUPCOD: "อ001", SUPNAM: "อู่ช่างเอก", PRENAM: "ร้าน", TAXID: "1234567890123", ORGNUM: "0" }],
      istab: [{ TABTYP: "50", TYPCOD: "03", TYPDES: "งานขุด" }],
    });
    expect(m.suppliers).toEqual([{ code: "อ001", name: "ร้าน อู่ช่างเอก", taxId: "1234567890123", branch: "0" }]);
    expect(m.items.map((i) => [i.code, i.stock, i.depCode, i.depName])).toEqual([
      ["SV-REPAIR", false, "03", "งานขุด"],
      ["PART-01", true, "03", "งานขุด"],
    ]);
  });
});
