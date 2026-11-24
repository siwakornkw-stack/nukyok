import { describe, expect, it } from "vitest";
import { buildPrices, purchaseItem } from "../scripts/express/prices.mjs";
import { purchaseItem as webPurchaseItem } from "@/lib/prices";

// Rows shaped like the Express tables the agent reads (field names as repair-write.ps1 / r3-write.ps1 write them).
const line = (o: Record<string, unknown>) => ({
  STKCOD: "TY-11R",
  DOCNUM: "RR691101-01",
  DOCDAT: "2026-11-01",
  POSOPR: "0",
  PEOPLE: "ย001",
  TRNQTY: 2,
  TQUCOD: "สน",
  UNITPR: 8560,
  NETVAL: 16000,
  STKDES: "ยาง 11R22.5 BRIDGESTONE",
  ...o,
});
const rows = (o: Record<string, unknown[]> = {}) => ({
  stcrd: [
    line({}),
    line({ DOCNUM: "RR691102-01", PEOPLE: "ย002", UNITPR: 7900, NETVAL: 15800, DOCDAT: "2026-11-02" }),
    line({ DOCNUM: "H3691103-01", STKCOD: "140 SY", PEOPLE: "บ015", TQUCOD: "ลต", STKDES: "", DOCDAT: "2026-11-03" }), // fuel
    line({ DOCNUM: "R3691103-01", STKCOD: "2120-03", PEOPLE: "0009", DOCDAT: "2026-11-03" }), // card settlement
    line({ DOCNUM: "RR691104-01", DOCDAT: "2026-11-04" }), // cancelled bill
    line({ DOCNUM: "IV691105-01", PEOPLE: "ล001", DOCDAT: "2026-11-05" }), // a sale: no purchase bill
    line({ DOCNUM: "RR691106-01", PEOPLE: "ย002", DOCDAT: "2026-11-06" }), // the bill belongs to another supplier
    line({ DOCNUM: "RR691107-01", POSOPR: "1", DOCDAT: "2026-11-07" }), // goods going out
    line({ DOCNUM: "RR691108-01", TRNQTY: 0, DOCDAT: "2026-11-08" }),
    line({ DOCNUM: "RR681001-01", DOCDAT: "2024-10-01" }), // older than `since`
    line({ DOCNUM: "SA691031-01", STKCOD: "5301-01", PEOPLE: "พ999", STKDES: "เงินเดือนพนักงาน", DOCDAT: "2026-10-31" }), // payroll
    line({ DOCNUM: "RR691109-01", STKCOD: "1150-05", STKDES: "คนงานเบิกเงิน", DOCDAT: "2026-11-09" }), // a staff loan on an RR
  ],
  aptrn: [
    { DOCNUM: "RR691101-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "RR691102-01", SUPCOD: "ย002", DOCSTAT: "N", FLGVAT: "2" },
    { DOCNUM: "H3691103-01", SUPCOD: "บ015", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "R3691103-01", SUPCOD: "0009", DOCSTAT: "N", FLGVAT: "0" },
    { DOCNUM: "RR691104-01", SUPCOD: "ย001", DOCSTAT: "C", FLGVAT: "1" },
    { DOCNUM: "RR691106-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "RR691107-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "RR691108-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "RR681001-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
    { DOCNUM: "SA691031-01", SUPCOD: "พ999", DOCSTAT: "N", FLGVAT: "0" },
    { DOCNUM: "RR691109-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "0" },
  ],
  apmas: [
    { SUPCOD: "พ999", PRENAM: "", SUPNAM: "เงินเดือนพนักงาน", FLGVAT: "0" },
    { SUPCOD: "ย001", PRENAM: "หจก.", SUPNAM: "ยางดี", ADDR01: "1 ถ.เทพกระษัตรี", ADDR02: "ภูเก็ต", ADDR03: "", ZIPCOD: "83000", TELNUM: "076-111111", TAXID: "0833500000001", ORGNUM: 0, REMARK: "", FLGVAT: "2" },
    { SUPCOD: "ย002", PRENAM: "", SUPNAM: "ร้านยางถูก", ADDR01: "", ADDR02: "", ADDR03: "", ZIPCOD: "", TELNUM: "", TAXID: "", ORGNUM: 2, REMARK: "ส่งของช้า", FLGVAT: "0" },
    { SUPCOD: "บ015", PRENAM: "", SUPNAM: "บางจาก", FLGVAT: "1" },
  ],
  stmas: [{ STKCOD: "TY-11R", STKDES: "ยางรถบรรทุก 11R22.5" }],
  poprit: [{ PONUM: "PK0000004", STKCOD: "140 SY" }],
  istab: [
    { TABTYP: "20", TYPCOD: "สน", SHORTNAM: "เส้น", TYPDES: "เส้น" },
    { TABTYP: "50", TYPCOD: "C001", TYPDES: "รถ6ล้อ" },
  ],
  ...o,
});

describe("purchase prices for เทียบราคา", () => {
  it("keeps the item lines received from a supplier on its own, live purchase bill", () => {
    const p = buildPrices(rows(), { since: "2024-11-24" });
    expect(p.lines).toEqual([
      { date: "2026-11-01", doc: "RR691101-01", sup: "ย001", item: "TY-11R", desc: "ยาง 11R22.5 BRIDGESTONE", qty: 2, unit: "เส้น", price: 8560, net: 16000, vat: "1" },
      { date: "2026-11-02", doc: "RR691102-01", sup: "ย002", item: "TY-11R", desc: "ยาง 11R22.5 BRIDGESTONE", qty: 2, unit: "เส้น", price: 7900, net: 15800, vat: "2" },
    ]);
    expect(p.items).toEqual({ "TY-11R": "ยางรถบรรทุก 11R22.5" });
    expect(p.since).toBe("2024-11-24");
  });

  it("sends the details of the suppliers in those lines only", () => {
    expect(buildPrices(rows(), { since: "2024-11-24" }).suppliers).toEqual([
      { code: "ย001", name: "หจก. ยางดี", address: "1 ถ.เทพกระษัตรี ภูเก็ต", zip: "83000", phone: "076-111111", taxId: "0833500000001", branch: "", remark: "", vat: "2" },
      { code: "ย002", name: "ร้านยางถูก", address: "", zip: "", phone: "", taxId: "", branch: "2", remark: "ส่งของช้า", vat: "0" },
    ]);
  });

  it("sends only items purchasing buys: never payroll, staff loans, cash, taxes (same rule on the web)", () => {
    const bought = ["TY-11R", "ค่าบริการ 5110-06", "5110-08", "5360-08", "5302-01", "5320-18", "5330-01", "1203-14", "1221-04", "1221-06"];
    const not = ["5301-01", "5310-13", "1150-05", "1161-05", "1111-12", "2131-03", "2132-01", "4900-01", "5500-01", "5110-02", "5110-09", "5110-12", "5320-04", "5320-12", "5320-14", "5320-17", "5320-18.", "1164-05", "1204-05"];
    for (const f of [purchaseItem, webPurchaseItem]) {
      expect(bought.filter((c) => !f(c))).toEqual([]);
      expect(not.filter((c) => f(c))).toEqual([]);
    }
  });

  it("keeps the unit code when Express has no name for it", () => {
    const p = buildPrices(rows({ istab: [] }), { since: "2024-11-24" });
    expect(p.lines[0].unit).toBe("สน");
  });
});
