import { readdirSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { buildRepairMasters, hasTaxId, planRepair, supplierTax } from "../scripts/express/repair.mjs";

const isprd = [{ BEG1NY: "2021-01-01", END1NY: "2027-01-31", LOCK1NY: "N", BEG2NY: "2027-02-01", END2NY: "2027-02-28", LOCK2NY: "Y" }];

// Rows shaped like the live company's, with made-up suppliers, bills, amounts and plates
// (the 13-digit IDs fail the Thai ID checksum on purpose). ท001 is a person, ท002 a company,
// ท003 a shop with no tax ID, ท004 one keyed with the filler 0000000000000, ท005 a non-Thai
// person (00...), ท006 a shop keyed with another filler.
const tables = (extra: Record<string, unknown[]> = {}) => ({
  stmas: [
    { STKCOD: "5360-02", STKDES: "ค่าซ่อมแซม-เครื่องจักร", STKTYP: "5", PQUCOD: "คง", ACCCOD: "000h" },
    { STKCOD: "5360-08", STKDES: "ค่าอะไหล่-เครื่องจักร", STKTYP: "5", PQUCOD: "คง", ACCCOD: "000U" },
    { STKCOD: "PART-01", STKDES: "ไส้กรอง", STKTYP: "0", PQUCOD: "ชน", ACCCOD: "000h" },
    { STKCOD: "SV-NOUNIT", STKDES: "ค่าแรง", STKTYP: "5", PQUCOD: "", ACCCOD: "000h" },
    { STKCOD: "SV-NOACC", STKDES: "ค่าแรง", STKTYP: "5", PQUCOD: "คง", ACCCOD: "zzzz" },
    { STKCOD: "1150-05", STKDES: "ลูกหนี้เงินยืม-คนงาน", STKTYP: "5", PQUCOD: "คง", ACCCOD: "001a" },
  ],
  // ACCCOD is case-sensitive: 000H is another account (ภงด.53)
  isacc: [
    { ACCCOD: "000H", ACCNUM01: "2132-03" },
    { ACCCOD: "000h", ACCNUM01: "5360-02" },
    { ACCCOD: "000U", ACCNUM01: "5360-08" },
    { ACCCOD: "001a", ACCNUM01: "1150-05" },
  ],
  apmas: [
    { SUPCOD: "ท001", SUPNAM: "สมมุติ ใจดี", PRENAM: "นาย", TAXID: "3100000000001", ORGNUM: "0", FLGVAT: "2" },
    { SUPCOD: "ท002", SUPNAM: "ทดสอบการช่าง", PRENAM: "หจก.", TAXID: "0100000000001", ORGNUM: "0", FLGVAT: "2" },
    { SUPCOD: "ท003", SUPNAM: "ร้านยางทดสอบ", PRENAM: "", TAXID: "", ORGNUM: "0", FLGVAT: "0" },
    { SUPCOD: "ท004", SUPNAM: "ร้านแบตทดสอบ", PRENAM: "ร้าน", TAXID: "0000000000000", ORGNUM: "0", FLGVAT: "0" },
    { SUPCOD: "ท005", SUPNAM: "TEST GARAGE", PRENAM: "MR.", TAXID: "0012345678901", ORGNUM: "0", FLGVAT: "2" },
    { SUPCOD: "ท006", SUPNAM: "ร้านกระจกทดสอบ", PRENAM: "ร้าน", TAXID: "1111111111111", ORGNUM: "0", FLGVAT: "0" },
  ],
  aptrn: [{ RECTYP: "3", DOCNUM: "RR691020-97", DOCDAT: "2026-10-20", SUPCOD: "ท001", REFNUM: "IV-0101", PONUM: "PO0000101", DOCSTAT: "N", NETAMT: 535 }],
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
  supplier: "ท001",
  item: "5360-02",
  dep: "D001",
  date: "2026-11-18",
  invoice: "IV-0102",
  amount: 535,
  vat: "2",
  job: "เปลี่ยนผ้าเบรก",
  plate: "99-0001",
  ...o,
});

const opts = { prefix: "PO" };

describe("repair PO + RR plan", () => {
  it("plans a PO + RR: VAT on top, the item's own account, Cr trade payables", () => {
    expect(planRepair(order(), tables(), opts)).toEqual({
      status: "ready",
      orderId: "r1",
      date: "2026-11-18",
      invoice: "IV-0102",
      user: "WEB",
      poPrefix: "PO",
      rrPrefix: "RR691118-",
      flgvat: "2",
      supplier: { code: "ท001", name: "สมมุติ ใจดี", prenam: "นาย", taxId: "3100000000001", branch: 0 },
      item: { code: "5360-02", desc: "เปลี่ยนผ้าเบรก", unit: "คง" },
      job: "เปลี่ยนผ้าเบรก",
      plate: "99-0001",
      dep: "D001",
      price: 500,
      net: 500,
      vat: 35,
      total: 535,
      accounts: { expense: "5360-02", vat: "1164-01", pay: "2110-01" },
      balColumn: "RR1NY",
    });
  });

  it("books VAT as on the tax invoice, not as the supplier is set up (APMAS.FLGVAT)", () => {
    // prices include VAT, 1,500 = 1,401.87 + 98.13, the line keyed at 1,500 (the garage is set to VAT on top)
    expect(planRepair(order({ supplier: "ท002", item: "5360-08", amount: 1500, vat: "1" }), tables(), opts)).toMatchObject({
      flgvat: "1", price: 1500, net: 1401.87, vat: 98.13, total: 1500, accounts: { expense: "5360-08" },
    });
    // a bill without VAT: no VAT line, the whole amount is the expense (also from a garage set up with VAT)
    expect(planRepair(order({ supplier: "ท003", amount: 3500, vat: "0" }), tables(), opts)).toMatchObject({ flgvat: "0", price: 3500, net: 3500, vat: 0, total: 3500 });
    expect(planRepair(order({ vat: "0" }), tables(), opts)).toMatchObject({ flgvat: "0", net: 535, vat: 0 });
    // VAT on top: the price the bill was made from (1,000 = 934.58 + 65.42)
    expect(planRepair(order({ amount: 1000 }), tables(), opts)).toMatchObject({ price: 934.58, net: 934.58, vat: 65.42, total: 1000 });
    // no price + ROUND(price x 7%, 2) gives 1,000.07: a typo, not booked
    expect(planRepair(order({ amount: 1000.07 }), tables(), opts).reason).toMatch(/VAT 7%/);
  });

  it("writes nothing when the tax invoice already has an RR of the same supplier and amount", () => {
    const same = order({ invoice: "IV-0101" });
    expect(planRepair(same, tables(), opts)).toEqual({ status: "exists", poNo: "PO0000101", rrNo: "RR691020-97" });
    // a garage reusing an invoice number (new book, other amount) is a new bill
    expect(planRepair(order({ invoice: "IV-0101", amount: 321 }), tables(), opts).status).toBe("ready");
    // the same number and amount from another garage, 200 days apart, or cancelled is another bill
    const rr = tables().aptrn[0];
    expect(planRepair(same, tables({ aptrn: [{ ...rr, SUPCOD: "ท002" }] }), opts).status).toBe("ready");
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCDAT: "2026-05-02" }] }), opts).status).toBe("ready");
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCSTAT: "C" }] }), opts).status).toBe("ready");
    // 90 days apart still counts (repair-write.ps1: ABS(docdat - date) <= 90)
    expect(planRepair(same, tables({ aptrn: [{ ...rr, DOCDAT: "2026-08-20" }] }), opts).status).toBe("exists");
  });

  it("reports a bill already in Express before any rule on how a new one is written", () => {
    // queued under older rules (keyed by staff, or written by a run whose report was lost): never "key it by hand"
    const done = { status: "exists", poNo: "PO0000101", rrNo: "RR691020-97" };
    const same = order({ invoice: "IV-0101" });
    expect(planRepair({ ...same, item: "1150-05" }, tables(), opts)).toEqual(done);
    expect(planRepair({ ...same, vat: undefined, dep: "" }, tables(), opts)).toEqual(done);
    const shop = tables({ aptrn: [{ ...tables().aptrn[0], SUPCOD: "ท003" }] });
    expect(planRepair({ ...same, supplier: "ท003", vat: "1" }, shop, opts)).toEqual(done);
  });

  it("refuses what it cannot book safely", () => {
    expect(planRepair(order({ supplier: "Y" }), tables(), opts).reason).toMatch(/ผู้จำหน่าย/);
    expect(planRepair(order({ vat: undefined }), tables(), opts).reason).toMatch(/VAT ในใบกำกับ/);
    expect(planRepair(order({ vat: "7" }), tables(), opts).reason).toMatch(/VAT ในใบกำกับ/);
    // no usable tax ID in Express (none, or a filler such as 0000000000000): not a tax invoice, no input VAT
    for (const supplier of ["ท003", "ท004", "ท006"]) {
      expect(planRepair(order({ supplier, vat: "1" }), tables(), opts).reason).toMatch(/ไม่มีเลขผู้เสียภาษี/);
      expect(planRepair(order({ supplier, vat: "2" }), tables(), opts).reason).toMatch(/ไม่มีเลขผู้เสียภาษี/);
      expect(planRepair(order({ supplier, vat: "0" }), tables(), opts).status).toBe("ready");
    }
    // a non-Thai person's ID is usable: VAT is booked, the ID going on the ISVAT row (the plan stays on the office PC)
    expect(planRepair(order({ supplier: "ท005" }), tables(), opts)).toMatchObject({ status: "ready", flgvat: "2", vat: 35, supplier: { taxId: "0012345678901" } });
    expect(planRepair(order({ item: "PART-01" }), tables(), opts).reason).toMatch(/สินค้าคงคลัง/);
    expect(planRepair(order({ item: "SV-NOUNIT" }), tables(), opts).reason).toMatch(/หน่วยซื้อ/);
    expect(planRepair(order({ item: "SV-NOACC" }), tables(), opts).reason).toMatch(/บัญชีค่าใช้จ่าย/);
    // an item that books outside repair / maintenance (a loan to a worker)
    expect(planRepair(order({ item: "1150-05" }), tables(), opts).reason).toMatch(/1150-05 ซึ่งไม่ใช่ค่าซ่อมแซม/);
    expect(planRepair(order({ amount: 0 }), tables(), opts).reason).toMatch(/ศูนย์/);
    expect(planRepair(order({ date: "2027-02-10" }), tables(), opts).reason).toMatch(/ปิดแล้ว/);
    expect(planRepair(order(), tables({ isrun: tables().isrun.filter((r) => r.PREFIX !== "PO") }), opts).reason).toMatch(/เลขรันของ PO/);
    expect(planRepair(order(), tables({ isrun: tables().isrun.filter((r) => r.PREFIX !== "RR") }), opts).reason).toMatch(/บัญชีของ RR/);
  });
});

// One rule for the fuel and the repair masters and for planRepair's VAT check (the web's
// saveMasters applies it to older agents).
describe("supplier tax ID", () => {
  it("vat for a usable ID (13 digits, not one digit 13 times); the ID itself only for a Thai juristic person", () => {
    expect(supplierTax("0105500000001")).toEqual({ vat: true, taxId: "0105500000001" });
    expect(supplierTax("0994000000001")).toEqual({ vat: true, taxId: "0994000000001" });
    // an individual's: a Thai national ID, or 00... for a non-Thai person
    expect(supplierTax("3100000000001")).toEqual({ vat: true });
    expect(supplierTax("0012345678901")).toEqual({ vat: true });
    for (const filler of ["0000000000000", "1111111111111", "9999999999999"]) expect(supplierTax(filler)).toEqual({ vat: false });
    for (const bad of ["", "010550000000", "01055000000011", "0-1055-00000-00-1", "0105500000x01"]) expect(supplierTax(bad)).toEqual({ vat: false });
  });
});

describe("repair master data", () => {
  const m = buildRepairMasters({
    popr: [
      { PONUM: "PO0000001", SUPCOD: "อ001", PODAT: "2026-09-01", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PO0000003", SUPCOD: "อ001", PODAT: "2026-09-03", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PO0000004", SUPCOD: "บ002", PODAT: "2026-10-05", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PO0000005", SUPCOD: "ร003", PODAT: "2026-08-01", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PO0000006", SUPCOD: "ร004", PODAT: "2026-07-01", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PO0000007", SUPCOD: "ต005", PODAT: "2026-06-01", DOCSTAT: "M", DEPCOD: "03" },
      { PONUM: "PK0000001", SUPCOD: "บ015", PODAT: "2026-10-01", DOCSTAT: "N", DEPCOD: "" },
      { PONUM: "PO0000002", SUPCOD: "อ002", PODAT: "2026-09-02", DOCSTAT: "C", DEPCOD: "" },
    ],
    poprit: [
      { PONUM: "PO0000001", STKCOD: "SV-REPAIR", STKDES: "ค่าซ่อม", DEPCOD: "" },
      { PONUM: "PO0000001", STKCOD: "TYRE-01", STKDES: "ยาง", DEPCOD: "" },
      { PONUM: "PO0000003", STKCOD: "SV-LOAN", STKDES: "คนงานเบิกเงิน", DEPCOD: "" },
      { PONUM: "PO0000004", STKCOD: "SV-DISC", STKDES: "ส่วนลดรับ", DEPCOD: "" },
      { PONUM: "PO0000004", STKCOD: "SV-PETTY", STKDES: "เงินสดย่อย", DEPCOD: "" },
      { PONUM: "PO0000005", STKCOD: "SV-TAX", STKDES: "ภาษีหัก ณ ที่จ่าย", DEPCOD: "" },
      { PONUM: "PO0000005", STKCOD: "SV-UNKNOWN", STKDES: "ไม่มีใน STMAS", DEPCOD: "" },
      { PONUM: "PK0000001", STKCOD: "70-1826", STKDES: "น้ำมัน", DEPCOD: "" },
    ],
    stmas: [
      { STKCOD: "SV-REPAIR", STKDES: "ค่าซ่อมรถ", STKTYP: "5", PQUCOD: "งน", ACCCOD: "000h" },
      { STKCOD: "TYRE-01", STKDES: "ยางรถบรรทุก", STKTYP: "0", PQUCOD: "เส้น", ACCCOD: "001T" },
      { STKCOD: "SV-LOAN", STKDES: "ลูกหนี้เงินยืม-คนงาน", STKTYP: "5", PQUCOD: "คง", ACCCOD: "001a" },
      { STKCOD: "SV-DISC", STKDES: "ส่วนลดรับ", STKTYP: "5", PQUCOD: "คง", ACCCOD: "001b" },
      { STKCOD: "SV-PETTY", STKDES: "เงินสดย่อย", STKTYP: "5", PQUCOD: "คง", ACCCOD: "001c" },
      { STKCOD: "SV-TAX", STKDES: "ภาษีหัก ณ ที่จ่าย", STKTYP: "5", PQUCOD: "คง", ACCCOD: "000H" },
    ],
    isacc: [
      { ACCCOD: "000H", ACCNUM01: "2132-03" },
      { ACCCOD: "000h", ACCNUM01: "5360-02" },
      { ACCCOD: "001T", ACCNUM01: "5360-10" },
      { ACCCOD: "001a", ACCNUM01: "1150-05" },
      { ACCCOD: "001b", ACCNUM01: "5110-02" },
      { ACCCOD: "001c", ACCNUM01: "1111-12" },
    ],
    apmas: [
      { SUPCOD: "อ001", SUPNAM: "อู่ช่างเอก", PRENAM: "ร้าน", TAXID: "1234567890123", ORGNUM: 0 },
      { SUPCOD: "บ002", SUPNAM: "ทดสอบการช่าง", PRENAM: "บจก.", TAXID: "0105500000001", ORGNUM: 1 },
      { SUPCOD: "ร003", SUPNAM: "ร้านยางทดสอบ", PRENAM: "", TAXID: "", ORGNUM: 0 },
      { SUPCOD: "ร004", SUPNAM: "แบตทดสอบ", PRENAM: "ร้าน", TAXID: "0000000000000", ORGNUM: 0 },
      { SUPCOD: "ต005", SUPNAM: "TEST GARAGE", PRENAM: "MR.", TAXID: "0012345678901", ORGNUM: 0 },
    ],
    istab: [
      { TABTYP: "50", TYPCOD: "03", TYPDES: "งานขุด", SHORTNAM: "" },
      { TABTYP: "50", TYPCOD: "07", TYPDES: "", SHORTNAM: "ส่วนกลาง" },
      { TABTYP: "20", TYPCOD: "X1", TYPDES: "ไม่ใช่แผนก", SHORTNAM: "" },
    ],
  });

  it("offers the PO book's suppliers most recently used first, a person's tax ID kept on the office PC", () => {
    expect(m.suppliers).toEqual([
      { code: "บ002", name: "บจก. ทดสอบการช่าง", vat: true, taxId: "0105500000001" },
      { code: "อ001", name: "ร้าน อู่ช่างเอก", vat: true },
      { code: "ร003", name: "ร้านยางทดสอบ", vat: false },
      // the filler 0000000000000 is no tax ID: no VAT, and nothing to send
      { code: "ร004", name: "ร้าน แบตทดสอบ", vat: false },
      // 00...: a non-Thai person's ID, usable for VAT but not sent
      { code: "ต005", name: "MR. TEST GARAGE", vat: true },
    ]);
  });

  it("sends every Express department (ISTAB 50), also those no item uses", () => {
    expect(m.departments).toEqual([
      { code: "03", name: "งานขุด" },
      { code: "07", name: "ส่วนกลาง" },
    ]);
  });

  it("sends at most 1000 suppliers, dropping the longest unused", () => {
    const popr = Array.from({ length: 1001 }, (_, i) => ({ PONUM: `PO${String(i).padStart(7, "0")}`, SUPCOD: `S${i}`, PODAT: i ? "2026-01-02" : "2026-01-01", DOCSTAT: "M", DEPCOD: "" }));
    const big = buildRepairMasters({ popr, poprit: [], stmas: [], isacc: [], apmas: [], istab: [] });
    expect(big.suppliers).toHaveLength(1000);
    expect(big.suppliers.some((s) => s.code === "S0")).toBe(false);
  });

  it("offers only items that book to a repair / maintenance account (5360-xx)", () => {
    // not: a worker loan, a discount, petty cash, 000H (case-sensitive: not 000h), an item missing from STMAS, the PK book
    expect(m.items.map((i) => [i.code, i.stock, i.depCode, i.depName])).toEqual([
      ["SV-REPAIR", false, "03", "งานขุด"],
      ["TYRE-01", true, "03", "งานขุด"],
    ]);
  });
});

// The writers run in 32-bit PowerShell on the office PC (checked on scratch VFP tables, then TESTR3):
// here only their text is checked.
const writer = (name: string) => readFileSync(new URL(`../scripts/express/${name}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("repair-write.ps1", () => {
  // The APTRN header is appended last: a write cut off part way leaves rows under its RR number
  // that APTRN does not show, and the next RR of that date must not take that number again.
  it("takes the RR number past every table the RR is written to before its APTRN header", () => {
    const src = writer("repair-write.ps1");
    const rr = src.slice(src.indexOf("# ---- RR ----"), src.indexOf('Append "fwap"'));
    const list = rr.match(/foreach \(\$f in @\((.*)\)\) \{/)?.[1] ?? "";
    const scanned = [...list.matchAll(/@\("(\w+)", "(\w+)"\)/g)].map((m) => `${m[1]}.${m[2]}`);
    expect(scanned).toEqual(["fwap.docnum", "fwst.docnum", "fwgj.voucher", "fwgi.voucher", "fwvt.docnum"]);
    const before = [...new Set([...rr.matchAll(/Append "(\w+)"/g)].map((m) => m[1]))];
    expect(before.length).toBeGreaterThan(0);
    for (const alias of before) expect(scanned.map((s) => s.split(".")[0])).toContain(alias);
  });

  it("saves its ledger as the fuel and R3 writers do (swapped in atomically, retried)", () => {
    const save = (name: string) => writer(name).match(/^function Save-Ledger \{\n[\s\S]*?\n\}\n/m)?.[0];
    expect(save("repair-write.ps1")).toContain("Start-Sleep");
    expect(save("repair-write.ps1")).toBe(save("fuel-write.ps1"));
    expect(save("repair-write.ps1")).toBe(save("r3-write.ps1"));
    // Defender / the indexer / OneDrive held the new ledger up to about 2 s during the TESTR3 run:
    // the swap is tried for about 10 s before the write gives up.
    const tries = Number(save("repair-write.ps1")?.match(/\$i -ge (\d+)\)/)?.[1]);
    const pause = Number(save("repair-write.ps1")?.match(/Start-Sleep -Milliseconds (\d+)/)?.[1]);
    expect(tries * pause).toBeGreaterThanOrEqual(10000);
  });

  // The TESTR3 run proves the RR numbering above: killed before the journal header, a stock line is
  // left under the RR number with no APTRN row, as with fuel-write.ps1's kill after its H3 stock line.
  it("has the kill test hook fuel-write.ps1 has (REPAIR_TEST_FAIL_AT=kill, after the RR stock line)", () => {
    const hook = (name: string) => writer(name).match(/^function Append\(.*\n(.*)\n/m)?.[1];
    expect(hook("fuel-write.ps1")).toContain('$env:FUEL_TEST_FAIL_AT -eq "kill" -and $alias -eq "fwgj"');
    expect(hook("repair-write.ps1")).toBe(hook("fuel-write.ps1")?.replace("FUEL_TEST_FAIL_AT", "REPAIR_TEST_FAIL_AT"));
    const src = writer("repair-write.ps1");
    expect(src).toMatch(/^#\s+kill\s/m);
    const rr = src.slice(src.indexOf("# ---- RR ----"));
    expect(rr.indexOf('Append "fwst"')).toBeGreaterThan(0);
    expect(rr.indexOf('Append "fwst"')).toBeLessThan(rr.indexOf('Append "fwgj"'));
  });
});

describe("fuel-write.ps1", () => {
  // The H3's ISVAT row claims input VAT with the pump's tax ID: an order queued while the masters
  // still said vat (or before staff blanked the ID) is refused by repair's rule, before any row.
  it("refuses an H3 for a pump without a usable tax ID, by the rule of hasTaxId", () => {
    const src = writer("fuel-write.ps1");
    const m = src.match(/\$plan\.withH3 -and -not \(\$taxId -cmatch '([^']+)' -and \$taxId -cnotmatch '([^']+)'\)/);
    expect(m).not.toBeNull();
    const ok = (id: string) => new RegExp(m![1]).test(id) && !new RegExp(m![2]).test(id);
    const ids = ["0105500000017", "3100000000001", "0".repeat(13), "7".repeat(13), "", "010550000001", "01055000000177", "0105-5000001", "๐๑๐๕๕๐๐๐๐๐๐๑๗"];
    for (const id of ids) expect(ok(id), id).toBe(hasTaxId(id));
    expect(ids.filter(ok)).toEqual(["0105500000017", "3100000000001"]);
    expect(src.indexOf("$taxId -cmatch")).toBeGreaterThan(0);
    expect(src.indexOf("$taxId -cmatch")).toBeLessThan(src.indexOf("# ---- PK ----"));
  });
});

// The write steps of one writer (comments left out): how many, those that do not end as they must
// (an APPEND BLANK, REPLACE or DELETE IN flushes the alias it wrote, FLUSH IN <alias> FORCE, right
// before its RETURN; every REPLACE but Append's own, on the row it just appended (GO $r IN $alias),
// is on an existing row and goes back to it, the same GO again, before the flush), and the source
// lines of those REPLACEs.
function writeSteps(src: string) {
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
  const writes = [...code.matchAll(/APPEND BLANK|REPLACE |DELETE IN /g)];
  const bad: string[] = [];
  const goneBack: string[] = [];
  for (const w of writes) {
    const before = code.slice(0, w.index);
    const step = code.slice(w.index, code.indexOf("RETURN", w.index));
    const go = before.match(/(?:"|`n)GO ([^`\n]+) IN ([^\s`]+)`r`n$/);
    const alias = w[0] === "APPEND BLANK" ? before.match(/SELECT ([^\s`]+)`r`n$/)?.[1] : step.match(/^(?:REPLACE .*?|DELETE) IN ([^\s`]+)`r`n/)?.[1];
    const appended = go?.[1] === "$r" && go[2] === "$alias";
    const back = w[0] === "REPLACE " && go && !appended ? `GO ${go[1]} IN ${go[2]}\`r\`n` : "";
    if (back) goneBack.push(code.slice(code.lastIndexOf("\n", w.index) + 1, code.indexOf("\n", w.index)));
    const ok = alias && (w[0] === "APPEND BLANK" || go?.[2] === alias) && step.endsWith(`\`r\`n${back}FLUSH IN ${alias} FORCE\`r\`n`);
    if (!ok) bad.push(step);
  }
  return { count: writes.length, bad, goneBack };
}

describe("fuel-write.ps1, r3-write.ps1, repair-write.ps1", () => {
  // The VFP OLE DB provider keeps a change to a row its connection holds locked in memory until the
  // record pointer is set again, unlock or close, and FLUSH alone does not write it: killed on TESTR3,
  // a write lost the ISRUN / STMAS changes its ledger listed (flushed or not) while its appended rows
  // stayed. Every step that writes, the rollback's too, flushes the alias it wrote before it returns,
  // and a REPLACE on an existing row (Change, the rollback's) goes back to that row before the flush.
  it("flush the alias each step appends to, changes or deletes in, a changed row after going back to it", () => {
    for (const name of ["fuel-write.ps1", "r3-write.ps1", "repair-write.ps1"]) {
      const { count, bad, goneBack } = writeSteps(writer(name));
      // APPEND BLANK, Append's REPLACE, Change's REPLACE, the rollback's DELETE and REPLACE: a new
      // write step is reviewed and counted here
      expect(count, name).toBe(5);
      expect(bad, name).toEqual([]);
      // the REPLACEs on an existing row: Change's, then the rollback's
      expect(goneBack.length, name).toBe(2);
      expect(goneBack[0], name).toContain("(@($recno, $alias, $field) + $params)");
      expect(goneBack[1], name).toContain("@($c.recno, $c.alias, $c.field, $v)");
    }
    // the check itself: a flush of another alias, or a changed row not gone back to, is caught
    const src = writer("fuel-write.ps1");
    const good = "REPLACE (p3) WITH $expr IN (p2)`r`nGO VAL(p1) IN (p2)`r`nFLUSH IN (p2) FORCE`r`n";
    const parts = src.split(good);
    expect(parts.length).toBe(3);
    const swap = (n: number, wrong: string) => parts.slice(1).reduce((s, p, i) => s + (i === n ? wrong : good) + p, parts[0]);
    expect(swap(-1, "")).toBe(src);
    for (const n of [0, 1]) {
      expect(writeSteps(swap(n, "REPLACE (p3) WITH $expr IN (p2)`r`nGO VAL(p1) IN (p2)`r`nFLUSH IN fwst FORCE`r`n")).bad.length).toBe(1);
      expect(writeSteps(swap(n, "REPLACE (p3) WITH $expr IN (p2)`r`nFLUSH IN (p2) FORCE`r`n")).bad.length).toBe(1);
    }
    expect(writeSteps(src.replace("APPEND BLANK`r`nFLUSH IN $alias FORCE", "APPEND BLANK`r`nFLUSH IN fwst FORCE")).bad.length).toBe(1);
    expect(writeSteps(src.replace("DELETE IN (p1)`r`nFLUSH IN (p1) FORCE", "DELETE IN (p1)`r`nFLUSH IN (p2) FORCE")).bad.length).toBe(1);
    // a REPLACE on a row positioned another way must go back the same way: Change's row reached by
    // another GO, or a new step on a row named by a variable, is caught (a new step also moves the count)
    const change = 'Run ("GO VAL(p1) IN (p2)`r`nREPLACE (p3)';
    expect(src.split(change).length).toBe(3);
    expect(writeSteps(src.replace(change, 'Run ("GO VAL(p4) IN (p2)`r`nREPLACE (p3)')).bad.length).toBe(1);
    for (const go of ["GO $item IN fwsm", "GO VAL(p2) IN fwsm"]) {
      const step = (back: string) => `\n[void](Run "${go}\`r\`nREPLACE totreo WITH 0 IN fwsm\`r\`n${back}FLUSH IN fwsm FORCE\`r\`nRETURN 'ok'")\n`;
      const without = writeSteps(src + step(""));
      expect(without.count, go).toBe(6);
      expect(without.bad.length, go).toBe(1);
      expect(writeSteps(src + step(`${go}\`r\`n`)).bad.length, go).toBe(0);
    }
  });
});

describe("test data", () => {
  // A real Thai tax / citizen ID passes this checksum; made-up ones in tests must not. IDs are
  // looked for as test rows hold them: a quoted value, plain or dashed (1-2345-67890-12-3).
  // A bare 13-digit number is a timestamp in milliseconds, not an ID.
  it("holds no real 13-digit Thai ID", () => {
    const digit = (first12: string) => (11 - ([...first12].reduce((s, d, i) => s + Number(d) * (13 - i), 0) % 11)) % 10;
    const real = (id: string) => digit(id.slice(0, 12)) === Number(id[12]);
    const ids = (src: string) => [...src.matchAll(/["'`](\d{13}|\d-\d{4}-\d{5}-\d{2}-\d)["'`]/g)].map((m) => m[1].replace(/-/g, ""));
    const id = `310000000000${digit("310000000000")}`;
    const dashed = `${id[0]}-${id.slice(1, 5)}-${id.slice(5, 10)}-${id.slice(10, 12)}-${id[12]}`;
    expect(ids(`{ TAXID: "${id}", other: '${dashed}', at: 1735689600000 }`).filter(real)).toEqual([id, id]);
    const dir = new URL(".", import.meta.url);
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const found = ids(readFileSync(new URL(f, dir), "utf8")).filter(real);
      expect(found.length, `${f}: 13-digit IDs that pass the Thai ID checksum (use made-up IDs that fail it)`).toBe(0);
    }
  });
});
