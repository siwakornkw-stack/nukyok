// Plans the PO (ใบสั่งซื้อ) and the RR (ซื้อเงินเชื่อ) Express needs for one
// repair bill saved on the web, the way staff key it in DHEWA66 (576 of 650
// repair POs since 2025 were received with an RR): one line (the service item,
// quantity 1), the RR received against the PO with the tax invoice in REFNUM,
// "<job> <plate>" in YOUREF, the expense account of the item (STMAS.ACCCOD ->
// ISACC.ACCNUM01), VAT as on the garage's tax invoice (picked by จัดซื้อ). The
// garage is paid later by staff: no R3. Reference bills: PO0002945 / RR691031-03,
// PO0003070 / RR691117-03, PO0003072 / RR691118-01.
//
// Run on TESTR3 2026-11-18 (PO0002892-94 / RR691118-01..03, one per VAT mode, plus
// a rollback): every field matches RRs keyed by staff; accounting checked them.
// EXPRESS_REPAIR_MODE=live on DHEWA66 since 2026-11-18.
// Pure planning from parsed Express rows; the write is repair-write.ps1.
import { balanceColumn } from "./r3.mjs";
import { h3Prefix } from "./fuel.mjs";

const r2 = (n) => Math.round(n * 100) / 100;

// Repair suppliers and service items from the PO book's history (not the fuel
// books PP / PK), for the web's choice lists.
export function buildRepairMasters({ popr, poprit, stmas, apmas, istab }, { prefix = "PO", since = "2025-01-01" } = {}) {
  const heads = new Map(popr.filter((p) => p.PONUM.startsWith(prefix) && p.PODAT && p.PODAT >= since && p.DOCSTAT !== "C").map((p) => [p.PONUM, p]));
  const stock = new Map(stmas.map((s) => [s.STKCOD, s]));
  const deps = new Map(istab.filter((t) => t.TABTYP === "50").map((t) => [t.TYPCOD, t.TYPDES || t.SHORTNAM]));
  const sups = new Map(), items = new Map();
  for (const p of heads.values()) sups.set(p.SUPCOD, (sups.get(p.SUPCOD) || 0) + 1);
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
    .sort((a, b) => b[1] - a[1])
    .slice(0, 300)
    .map(([code]) => {
      const a = apmas.find((x) => x.SUPCOD === code);
      return { code, name: a ? `${a.PRENAM} ${a.SUPNAM}`.trim() : code, taxId: a?.TAXID || "", branch: a?.ORGNUM ? String(a.ORGNUM) : "" };
    });
  const itemRows = [...items.values()]
    .map((it) => {
      const s = stock.get(it.code);
      return {
        code: it.code,
        desc: s?.STKDES || it.lineDesc || it.code,
        depCode: it.depCode,
        depName: deps.get(it.depCode) || "",
        unit: s?.PQUCOD || "",
        stock: !s || s.STKTYP !== "5", // unknown item or a stock part: not booked automatically
        vatClaim: true,
        uses: it.uses,
      };
    })
    .filter((it) => !/ห้ามใช้/.test(it.code + it.desc))
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 1000);
  return { suppliers, items: itemRows };
}

// order: { id, supplier, item, dep, date, invoice, amount, vat, job, plate } (from GET /api/express/repair)
//   amount: what the garage is paid (VAT included when it charges VAT); job: the work, plate: the vehicle
//   vat: the bill's VAT as on the tax invoice: "1" prices include VAT, "2" VAT on top, "0" none
// opts:  { prefix: PO book prefix, user }
export function planRepair(order, { stmas, isacc, apmas, aptrn, isprd, isrun }, { prefix = "PO", user = "WEB" } = {}) {
  const sup = apmas.find((s) => s.SUPCOD === order.supplier);
  if (!sup) return { status: "error", reason: `ไม่พบผู้จำหน่าย ${order.supplier} ใน Express` };
  // The bill's own VAT mode, not the supplier's APMAS.FLGVAT: staff key 83 of 576 repair RRs
  // differently from it (mostly garages set to VAT on top whose bills include VAT).
  const flgvat = order.vat;
  if (!["0", "1", "2"].includes(flgvat)) return { status: "error", reason: "บิลนี้ไม่ได้ระบุ VAT ในใบกำกับภาษี" };
  const item = stmas.find((s) => s.STKCOD === order.item);
  if (!item) return { status: "error", reason: `ไม่พบรหัสสินค้า ${order.item} ใน Express` };
  if (item.STKTYP !== "5") return { status: "error", reason: `${order.item} เป็นสินค้าคงคลัง ต้องคีย์ใน Express เอง` };
  if (!item.PQUCOD) return { status: "error", reason: `${order.item} ไม่มีหน่วยซื้อใน Express` };
  // The expense account of a service item: STMAS.ACCCOD -> ISACC.ACCNUM01 (codes are case-sensitive).
  const expense = isacc.find((a) => a.ACCCOD === item.ACCCOD)?.ACCNUM01;
  if (!expense) return { status: "error", reason: `ไม่พบบัญชีค่าใช้จ่ายของ ${order.item} ใน Express (ISACC)` };
  if (!(order.amount > 0)) return { status: "error", reason: "ยอดค่าซ่อมเป็นศูนย์" };
  if (!order.invoice) return { status: "error", reason: "ไม่มีเลขที่ใบกำกับภาษี" };
  if (!order.dep) return { status: "error", reason: "ไม่มีแผนก" };

  // Already in Express? An RR of this supplier for this tax invoice, with the same amount and
  // dated within 90 days of the bill (repair-write.ps1 checks the same). Garage invoice numbers
  // repeat (a new book each year, per branch), so the number alone is not enough.
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
