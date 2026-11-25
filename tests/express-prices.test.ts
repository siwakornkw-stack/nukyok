import { describe, expect, it } from "vitest";
import { buildPrices, company, person, purchaseItem, staffItem } from "../scripts/express/prices.mjs";
import { company as webCompany, keepPrices, person as webPerson, purchaseItem as webPurchaseItem, staffItem as webStaffItem } from "@/lib/prices";

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

  it("leaves staff out with all their lines, a private person's details and service wages too", () => {
    const p = buildPrices(people(), { since: "2024-11-24" });
    expect(p.lines.map((l: { doc: string; sup: string; item: string }) => [l.doc, l.sup, l.item])).toEqual([
      ["RR691101-01", "ย001", "TY-11R"],
      ["RR691102-01", "ย002", "TY-11R"],
      ["RR691112-01", "ช001", "5360-03"], // the private person's repair, not their service wage
      ["RR691113-01", "ย001", "5110-05"], // a company's service: kept, its staff-loan line (1150-05) did not make it staff
    ]); // and no service wage of the supplier with no APMAS record (ข001)
    expect(p.suppliers.map((s: { code: string }) => s.code)).toEqual(["ย001", "ย002", "ช001"]); // no employee น001
    expect(p.suppliers[2]).toEqual({ code: "ช001", name: "นาย ช่างทดสอบ", address: "", zip: "", phone: "", taxId: "", branch: "", remark: "", vat: "0" });
    expect(p.items).toEqual({ "TY-11R": "ยางรถบรรทุก 11R22.5", "5360-03": "", "5110-05": "" });
  });

  it("tells companies from private persons by tax ID and title", () => {
    expect(person("3830100000001", "ร้านอะไหล่ทดสอบ")).toBe(true); // a shop under a person's ID
    expect(person("", "นายทดสอบ ใจดี")).toBe(true); // title in SUPNAM
    expect(["น.ส. ทดสอบ", "นางสาวทดสอบ", "นาง ทดสอบ", "คุณทดสอบ", "MR. TEST", "Mrs. Test", "MISS TEST"].every((n) => person("", n))).toBe(true);
    expect(person("0000000000000", "MR. TEST")).toBe(true); // a worker keyed with zeros
    expect(person("0012345678901", "NISTER TEST")).toBe(true); // a non-Thai person's ID, the title mistyped
    expect(person("0000000000000", "ร้านทดสอบ")).toBe(false); // zeros = unknown
    expect(person("0833500000001", "หจก. ยางดี")).toBe(false);
    expect(person("", "ร้านยางถูก")).toBe(false); // no ID, no title: not known to be a person
    expect(person("", "MISSION PARTS")).toBe(false);
    expect(company("0833500000001", "หจก. ยางดี")).toBe(true);
    expect(company("0994000000001", "สำนักงานทดสอบ")).toBe(true); // a state body
    expect(company("0000000000000", "ร้านทดสอบ")).toBe(false); // zeros = unknown
    expect(company("0012345678901", "NISTER TEST")).toBe(false); // a non-Thai person's ID
    expect(company("0833500000001", "นาย ทดสอบ")).toBe(false);
    expect(company("", "บริษัท ทดสอบ จำกัด")).toBe(false);
  });

  it("the web applies the same rules (twins) and keeps all the agent sends", () => {
    const codes = ["TY-11R", "5110-05", "5110-08", "5360-08", "5301-01", "5301-06", "5310-011", "5310-13", "5110-09", "5110-12", "1150-03", "1150-031"];
    codes.push("1161-01", "1161-05", "1161-07", "1111-00", "1111-10", "1111-19", "2131-03", "2131-10", "2131-12", "2132-01", "2132-03", "2110-01", "2110-03", "4900-01");
    expect(codes.filter((c) => staffItem(c))).toEqual(["5301-01", "5301-06", "5310-011", "5310-13", "5110-09", "5110-12", "1150-03", "1150-031", "1161-05", "1111-10", "1111-19", "2131-03", "2131-10", "2131-12", "2132-01", "2110-03"]);
    for (const c of codes) {
      expect([webPurchaseItem(c), webStaffItem(c)]).toEqual([purchaseItem(c), staffItem(c)]);
      expect(purchaseItem(c) && staffItem(c)).toBe(false); // a staff-type line is never sent itself
    }
    const who = [["3830100000001", "ร้านอะไหล่"], ["", "นายทดสอบ"], ["0000000000000", "MR. TEST"], ["0000000000000", "ร้านทดสอบ"], ["0833500000001", "หจก. ยางดี"], ["", "ร้านยางถูก"], ["0012345678901", "NISTER TEST"], ["0833500000001", "นาย ทดสอบ"]];
    for (const [id, name] of who) expect([webPerson(id, name), webCompany(id, name)]).toEqual([person(id, name), company(id, name)]);
    const sent = buildPrices(people(), { since: "2024-11-24" });
    expect(keepPrices(sent)).toEqual(sent);
  });
});

// Staff and private persons as DHEWA66 has them: an employee with a staff loan who also has a reimbursed
// purchase line, and a private person paid service wages (5110-05) who also did a repair.
function people() {
  const base = rows();
  return {
    ...base,
    stcrd: [
      ...base.stcrd,
      line({ DOCNUM: "PE691110-01", PEOPLE: "น001", STKCOD: "5360-03", STKDES: "ยางใน", DOCDAT: "2026-11-10" }),
      line({ DOCNUM: "PE681001-01", PEOPLE: "น001", STKCOD: "1150-03", STKDES: "เงินยืม", DOCDAT: "2024-10-01" }), // older than `since`
      line({ DOCNUM: "RR691111-01", PEOPLE: "ช001", STKCOD: "5110-05", STKDES: "ค่าแรง 3 วัน", DOCDAT: "2026-11-11" }),
      line({ DOCNUM: "RR691112-01", PEOPLE: "ช001", STKCOD: "5360-03", STKDES: "ค่าซ่อมไดชาร์จ", TRNQTY: 1, NETVAL: 1500, DOCDAT: "2026-11-12" }),
      line({ DOCNUM: "RR691113-01", STKCOD: "5110-05", STKDES: "ค่าบริการถ่วงล้อ", TRNQTY: 1, NETVAL: 400, DOCDAT: "2026-11-13" }),
      line({ DOCNUM: "RR691114-01", PEOPLE: "ข001", STKCOD: "5110-05", STKDES: "ค่าแรง 2 วัน", TRNQTY: 1, NETVAL: 800, DOCDAT: "2026-11-14" }), // no APMAS record: maybe a person's
    ],
    aptrn: [
      ...base.aptrn,
      { DOCNUM: "PE691110-01", SUPCOD: "น001", DOCSTAT: "N", FLGVAT: "0" },
      { DOCNUM: "PE681001-01", SUPCOD: "น001", DOCSTAT: "N", FLGVAT: "0" },
      { DOCNUM: "RR691111-01", SUPCOD: "ช001", DOCSTAT: "N", FLGVAT: "0" },
      { DOCNUM: "RR691112-01", SUPCOD: "ช001", DOCSTAT: "N", FLGVAT: "0" },
      { DOCNUM: "RR691113-01", SUPCOD: "ย001", DOCSTAT: "N", FLGVAT: "1" },
      { DOCNUM: "RR691114-01", SUPCOD: "ข001", DOCSTAT: "N", FLGVAT: "0" },
    ],
    apmas: [
      ...base.apmas,
      { SUPCOD: "น001", PRENAM: "", SUPNAM: "พนักงานทดสอบ", ADDR01: "บ้านพัก", TELNUM: "089-0000001", TAXID: "3830100000001", REMARK: "", FLGVAT: "0" },
      { SUPCOD: "ช001", PRENAM: "นาย", SUPNAM: "ช่างทดสอบ", ADDR01: "9 หมู่ 1", ADDR02: "ภูเก็ต", ZIPCOD: "83000", TELNUM: "089-0000002", TAXID: "3830100000002", ORGNUM: 0, REMARK: "บัญชีส่วนตัว", FLGVAT: "0" },
    ],
  };
}
