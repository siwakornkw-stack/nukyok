// Plans the PO (ใบสั่งซื้อ) and the RR (ซื้อเงินเชื่อ) Express needs for one
// repair bill saved on the web, the way staff key it in the live company (most
// repair POs are received with an RR): one line (the service item,
// quantity 1), the RR received against the PO with the tax invoice in REFNUM,
// "<job> <plate>" in YOUREF, the expense account of the item (STMAS.ACCCOD ->
// ISACC.ACCNUM01), VAT as on the garage's tax invoice (picked by จัดซื้อ). The
// garage is paid later by staff: no R3.
//
// Run on TESTR3 2026-11-18 (one bill per VAT mode, plus a rollback): every field
// matches RRs keyed by staff; accounting checked them. EXPRESS_REPAIR_MODE=live
// since 2026-11-18.
// Pure planning from parsed Express rows; the write is repair-write.ps1.
import { balanceColumn } from "./r3.mjs";
import { h3Prefix } from "./fuel.mjs";

const r2 = (n) => Math.round(n * 100) / 100;

// The repair / maintenance expense accounts (5360-xx, under "5360-00 ค่าซ่อมแซม+บำรุงรักษา"
// in the chart): the only ones a garage bill books to. The PO book's other service items
// book to staff loans, petty cash, discounts, wages, job costs or fixed assets.
const repairAccount = (acc) => /^5360-/.test(acc || "");

// A usable tax ID in APMAS: 13 digits, not one digit 13 times (a filler such as
// 0000000000000, keyed for shops that have none). Input VAT needs one: it goes on the ISVAT row.
export const hasTaxId = (id) => /^\d{13}$/.test(id || "") && !/^(\d)\1{12}$/.test(id);

// A supplier's tax ID as the web's masters get it, fuel and repair alike (the web's saveMasters
// applies the same rule to older agents): vat = a usable ID; the ID itself only for a Thai
// juristic person (0 then 1-9). Any other usable ID is an individual's (a national ID, or 00...
// for a non-Thai person) and never leaves the office PC.
export function supplierTax(id) {
  const vat = hasTaxId(id);
  return vat && /^0[1-9]/.test(id) ? { vat, taxId: id } : { vat };
}

// Repair suppliers and service items from the PO book's history (not the fuel
// books PP / PK), for the web's choice lists, and every Express department (ISTAB 50)
// for the vehicles' department (fuel and repair). Suppliers most recently used first,
// with supplierTax.
export function buildRepairMasters({ popr, poprit, stmas, apmas, istab, isacc }, { prefix = "PO", since = "2025-01-01" } = {}) {
  const heads = new Map(popr.filter((p) => p.PONUM.startsWith(prefix) && p.PODAT && p.PODAT >= since && p.DOCSTAT !== "C").map((p) => [p.PONUM, p]));
  const stock = new Map(stmas.map((s) => [s.STKCOD, s]));
  const deps = new Map(istab.filter((t) => t.TABTYP === "50").map((t) => [t.TYPCOD, t.TYPDES || t.SHORTNAM]));
  const sups = new Map(), items = new Map();
  for (const p of heads.values()) {
    const s = sups.get(p.SUPCOD) || { uses: 0, last: "" };
    s.uses++;
    if (p.PODAT > s.last) s.last = p.PODAT;
    sups.set(p.SUPCOD, s);
  }
  for (const l of poprit) {
    const h = heads.get(l.PONUM);
    if (!h || !l.STKCOD) continue;
    const it = items.get(l.STKCOD) || { code: l.STKCOD, uses: 0, last: "", depCode: "", lineDesc: "" };
    it.uses++;
    if (h.PODAT >= it.last) {
      it.last = h.PODAT;
      it.depCode = l.DEPCOD || h.DEPCOD || it.depCode;
      it.lineDesc = l.STKDES;
    }
    items.set(l.STKCOD, it);
  }
  const suppliers = [...sups.entries()]
    .sort((a, b) => b[1].last.localeCompare(a[1].last) || b[1].uses - a[1].uses)
    .slice(0, 1000)
    .map(([code]) => {
      const a = apmas.find((x) => x.SUPCOD === code);
      return { code, name: a ? `${a.PRENAM} ${a.SUPNAM}`.trim() : code, ...supplierTax(a?.TAXID || "") };
    });
  const itemRows = [...items.values()]
    // the item's account as planRepair finds it (STMAS.ACCCOD -> ISACC.ACCNUM01) must be a repair account
    .filter((it) => repairAccount(isacc.find((a) => a.ACCCOD === stock.get(it.code)?.ACCCOD)?.ACCNUM01))
    .map((it) => {
      const s = stock.get(it.code);
      return {
        code: it.code,
        desc: s.STKDES || it.lineDesc || it.code,
        depCode: it.depCode,
        depName: deps.get(it.depCode) || "",
        unit: s.PQUCOD || "",
        stock: s.STKTYP !== "5", // a stock part: not booked automatically
        vatClaim: true,
        uses: it.uses,
      };
    })
    .filter((it) => !/ห้ามใช้/.test(it.code + it.desc))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 1000);
  // Every department, not only the items' ones: a vehicle (one filled only from the central
  // tank, say) may be booked to a department no PO behind these masters used.
  const departments = [...deps].map(([code, name]) => ({ code, name })).slice(0, 1000);
  return { suppliers, items: itemRows, departments };
}

// order: { id, supplier, item, dep, date, invoice, amount, vat, job, plate } (from GET /api/express/repair)
//   amount: what the garage is paid (VAT included when it charges VAT); job: the work, plate: the vehicle
//   vat: the bill's VAT as on the tax invoice: "1" prices include VAT, "2" VAT on top, "0" none
// opts:  { prefix: PO book prefix, user }
export function planRepair(order, { stmas, isacc, apmas, aptrn, isprd, isrun }, { prefix = "PO", user = "WEB" } = {}) {
  const sup = apmas.find((s) => s.SUPCOD === order.supplier);
  if (!sup) return { status: "error", reason: `ไม่พบผู้จำหน่าย ${order.supplier} ใน Express` };
  if (!(order.amount > 0)) return { status: "error", reason: "ยอดค่าซ่อมเป็นศูนย์" };
  if (!order.invoice) return { status: "error", reason: "ไม่มีเลขที่ใบกำกับภาษี" };

  // Already in Express? An RR of this supplier for this tax invoice, with the same amount and
  // dated within 90 days of the bill (repair-write.ps1 checks the same). Garage invoice numbers
  // repeat (a new book each year, per branch), so the number alone is not enough. Checked
  // before the rules below on how a new bill is written: a bill staff (or an earlier run whose
  // report was lost) already keyed is reported with its numbers, never as one to key by hand.
  const rr = aptrn.find(
    (r) =>
      r.RECTYP === "3" &&
      r.DOCNUM.startsWith("RR") &&
      r.REFNUM === order.invoice &&
      r.SUPCOD === order.supplier &&
      r.DOCSTAT !== "C" &&
      r2(r.NETAMT) === r2(order.amount) &&
      Math.abs(Date.parse(r.DOCDAT) - Date.parse(order.date)) <= 90 * 86400000
  );
  if (rr) return { status: "exists", poNo: rr.PONUM || "", rrNo: rr.DOCNUM };

  // The bill's own VAT mode, not the supplier's APMAS.FLGVAT: staff key many repair RRs
  // differently from it (mostly garages set to VAT on top whose bills include VAT).
  const flgvat = order.vat;
  if (!["0", "1", "2"].includes(flgvat)) return { status: "error", reason: "บิลนี้ไม่ได้ระบุ VAT ในใบกำกับภาษี" };
  // Input VAT needs the seller's tax ID on the ISVAT row: without a usable one (the masters' vat
  // is false) the bill is not a tax invoice.
  if (flgvat !== "0" && !hasTaxId(sup.TAXID)) {
    return { status: "error", reason: `ร้าน / อู่ ${order.supplier} ไม่มีเลขผู้เสียภาษีใน Express จึงลง VAT ไม่ได้: เพิ่มเลขใน Express แล้วส่งใหม่ หรือคีย์บิลนี้เอง` };
  }
  const item = stmas.find((s) => s.STKCOD === order.item);
  if (!item) return { status: "error", reason: `ไม่พบรหัสสินค้า ${order.item} ใน Express` };
  if (item.STKTYP !== "5") return { status: "error", reason: `${order.item} เป็นสินค้าคงคลัง ต้องคีย์ใน Express เอง` };
  if (!item.PQUCOD) return { status: "error", reason: `${order.item} ไม่มีหน่วยซื้อใน Express` };
  // The expense account of a service item: STMAS.ACCCOD -> ISACC.ACCNUM01 (codes are case-sensitive).
  const expense = isacc.find((a) => a.ACCCOD === item.ACCCOD)?.ACCNUM01;
  if (!expense) return { status: "error", reason: `ไม่พบบัญชีค่าใช้จ่ายของ ${order.item} ใน Express (ISACC)` };
  if (!repairAccount(expense)) return { status: "error", reason: `${order.item} ลงบัญชี ${expense} ซึ่งไม่ใช่ค่าซ่อมแซม / บำรุงรักษา (5360-xx): คีย์บิลนี้ใน Express เอง` };
  if (!order.dep) return { status: "error", reason: "ไม่มีแผนก" };

  const run = isrun.find((r) => r.DOCTYP === "RR" && r.PREFIX === "RR");
  if (!run?.ACCNUM02 || !run?.ACCNUM03) return { status: "error", reason: "ไม่พบบัญชีของ RR ใน ISRUN" };
  if (!isrun.some((r) => r.DOCTYP === "PO" && r.PREFIX === prefix)) return { status: "error", reason: `ไม่พบเลขรันของ ${prefix} ใน ISRUN` };
  const bal = balanceColumn(isprd, order.date, "RR");
  if (bal.error) return { status: "error", reason: bal.error };

  // Money as staff key it, quantity 1. "price" is the line price as keyed (VAT included only
  // when flgvat is 1); "net" is the amount before VAT; "total" is what the garage is paid.
  const total = r2(order.amount);
  let net = total, vat = 0;
  if (flgvat === "1") {
    vat = r2((total * 7) / 107);
    net = r2(total - vat);
  } else if (flgvat === "2") {
    // Express: VAT = ROUND(price x 7%, 2) on top. Find the price the garage's bill was made from.
    const guess = r2(total / 1.07);
    const price = [guess, r2(guess - 0.01), r2(guess + 0.01)].find((p) => r2(p + r2(p * 0.07)) === total);
    if (price === undefined) return { status: "error", reason: `ยอด ${total} ไม่ใช่ราคา + VAT 7% ที่ลงตัว (บิลนี้คิด VAT แยก) ตรวจยอดในบิล` };
    net = price;
    vat = r2(total - net);
  }
  return {
    status: "ready",
    orderId: order.id,
    date: order.date,
    invoice: order.invoice,
    user,
    poPrefix: prefix,
    rrPrefix: `RR${h3Prefix(order.date).slice(2)}`,
    flgvat,
    supplier: { code: sup.SUPCOD, name: sup.SUPNAM, prenam: sup.PRENAM, taxId: sup.TAXID, branch: Number(sup.ORGNUM) || 0 },
    item: { code: item.STKCOD, desc: Array.from(String(order.job || item.STKDES)).slice(0, 50).join(""), unit: item.PQUCOD },
    // APTRN.YOUREF is "<job> <plate>" (repair-write.ps1 fits it to the field, the plate kept whole)
    job: String(order.job || item.STKDES),
    plate: String(order.plate || ""),
    dep: order.dep,
    price: flgvat === "1" ? total : net,
    net,
    vat,
    total,
    accounts: { expense, vat: run.ACCNUM02, pay: run.ACCNUM03 },
    balColumn: bal.column,
  };
}
