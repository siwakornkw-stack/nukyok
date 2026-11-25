// Plans the PK (ใบสั่งซื้อ-น้ำมัน(ใหม่)) and the H3 (ซื้อสดด้วยบัตร) Express needs
// for one fuel bill saved on the web, the way staff key them (every PP since
// July 2026 is one bill, one line, VAT included; it is received by an H3 with
// the tax invoice in "เลขที่บิล"). The PK is written when the bill is saved, the
// H3 once an admin approved the PK (stage "pk" / "h3"):
//   PK  POPR + POPRIT, number from ISRUN (PK0000001…), STMAS TOTREO += litres
//   H3  APTRN (number H3<BEyymmdd>-NN like staff use), STCRD line linked to the
//       PK line, journal 03 Dr 5110-04 (dep) / Dr 1164-01 VAT (dep) / Cr 2120-03,
//       ISVAT input-VAT row, APRCPCQ payment, PK closed (M, REMQTY 0),
//       STMAS TOTREO -= litres, supplier LASRCV and APBAL HP<period> += total.
// Pure planning from parsed Express rows; the write is fuel-write.ps1.
import { balanceColumn } from "./r3.mjs";

const r2 = (n) => Math.round(n * 100) / 100;

// "2026-10-28" -> "H3691028-"
export function h3Prefix(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return `H3${String(Number(y) + 543).slice(-2)}${m}${d}-`;
}

// Line maths as staff key it: litres x pump price, the rounding difference down
// to the paid total booked as a discount (never negative: 0 of 72 October lines).
// Counted in whole satang, the line rounded half-up like Express: in floating
// point 44.55 x 44.90 (2000.295) rounds to 2000.29, one satang short.
export function lineAmounts(liters, price, total) {
  const l = Math.round(liters * 10000), t = Math.round(total * 100); // 1/10000 litre, satang
  const line = (p) => Math.floor((l * Math.round(p * 10000) + 500000) / 1000000); // litres x price, satang
  let p = price > 0 ? price : r2(total / liters);
  if (line(p) < t) p = Math.ceil((t * 10000) / l) / 100;
  const disc = (line(p) - t) / 100;
  const vat = r2((total * 7) / 107);
  const net = r2(total - vat);
  return { price: p, disc, total: r2(total), vat, net, xunit: r2(net / liters) };
}

// order: { id, stage, pkNo, withH3, supplier, item, dep, date, invoice, liters, price, amount, force }
// stage "pk" (when the bill is saved): the PK only. stage "h3" (once an admin
// approved that PK, order.pkNo): its H3. An order without a stage is both at once.
// force: Office checked Express and confirmed that the other H3 / PK of this tax
// invoice is not this bill (one invoice split over several vehicles).
export function planFuel(order, tables, user = "WEB") {
  if (order.stage === "pk") return planStage({ ...order, withH3: false }, tables, user, "");
  if (order.stage === "h3") {
    const pk = tables.popr.find((p) => p.PONUM === order.pkNo && p.DOCSTAT !== "C");
    if (!pk) return { status: "error", reason: `ไม่พบ ${order.pkNo} ใน Express` };
    const item = tables.stmas.find((s) => s.STKCOD === order.item);
    if (item && item.STKTYP !== "5") return { status: "error", reason: `${order.item} เป็นสินค้าคงคลัง H3 ต้องคีย์ใน Express เอง` };
    return planStage({ ...order, withH3: true }, tables, user, pk.PONUM);
  }
  return planStage(order, tables, user, "");
}

function planStage(order, { popr, poprit, stmas, apmas, aptrn, isprd, isrun }, user, knownPk) {
  const sup = apmas.find((s) => s.SUPCOD === order.supplier);
  if (!sup) return { status: "error", reason: `ไม่พบผู้จำหน่าย ${order.supplier} ใน Express` };
  const item = stmas.find((s) => s.STKCOD === order.item);
  if (!item) return { status: "error", reason: `ไม่พบรหัสรถ ${order.item} ใน Express` };
  if (!(order.liters > 0) || !(order.amount > 0)) return { status: "error", reason: "ลิตรหรือยอดเงินเป็นศูนย์" };
  if (!order.invoice) return { status: "error", reason: "ไม่มีเลขที่ใบกำกับภาษี" };
  if (order.price > 0 && Math.abs(order.liters * order.price - order.amount) > 1) {
    return { status: "error", reason: `ลิตร × ราคาต่อลิตร (${r2(order.liters * order.price)}) ไม่ตรงกับยอดเงิน (${order.amount})` };
  }

  // Already in Express? An H3 for this tax invoice with the same amount (staff
  // may have keyed it, perhaps under another branch's supplier code) means
  // nothing is written at all. A PK an earlier run opened for this bill (this
  // supplier, date and invoice in "อ้างอิง", this amount and vehicle) gets only the H3.
  const invoiceH3 = aptrn.filter((r) => r.DOCNUM.startsWith("H3") && r.REFNUM === order.invoice && r.DOCSTAT !== "C");
  const h3 = invoiceH3.find((r) => r2(r.NETAMT) === r2(order.amount));
  if (h3) return { status: "exists", pkNo: h3.PONUM || knownPk, h3No: h3.DOCNUM };
  const vehicle = (ponum) => poprit.find((i) => i.PONUM === ponum)?.STKCOD ?? "";
  const pks = knownPk ? [] : popr.filter((p) => p.PONUM.startsWith("PK") && p.SUPCOD === order.supplier && p.PODAT === order.date && p.YOUREF === order.invoice && p.DOCSTAT !== "C");
  const pk = knownPk ? { PONUM: knownPk } : pks.find((p) => r2(p.NETAMT) === r2(order.amount) && vehicle(p.PONUM) === order.item);
  // The invoice of this supplier in another H3, or in another PK of this date: one invoice
  // split over several vehicles, or this bill keyed with another amount. A person checks
  // Express and keys it, or confirms it is not this bill (force). fuel-write.ps1 says the same.
  const split = invoiceH3.find((r) => r.SUPCOD === order.supplier);
  const other = !pk && pks[0];
  if ((split || other) && order.force !== true) {
    const theirs = split ? `${split.DOCNUM} (ยอด ${r2(split.NETAMT).toFixed(2)})` : `${other.PONUM} (รถ ${vehicle(other.PONUM)} ยอด ${r2(other.NETAMT).toFixed(2)})`;
    return {
      status: "error",
      reason:
        `อาจซ้ำ: ใบกำกับ ${order.invoice} ของผู้จำหน่ายนี้มี ${theirs} ใน Express แล้ว ไม่ตรงกับบิลนี้ (รถ ${order.item} ยอด ${r2(order.amount).toFixed(2)}) ` +
        `อาจเป็นใบกำกับที่แบ่งเติมหลายคัน ตรวจใน Express ถ้ายังไม่มีบิลนี้ให้กด "ยืนยันว่าไม่ซ้ำ" หรือคีย์เอง`,
    };
  }
  const withH3 = order.withH3 && item.STKTYP === "5";
  if (pk && !withH3) return { status: "exists", pkNo: pk.PONUM, h3No: "" };

  const a = lineAmounts(order.liters, order.price, order.amount);
  const run = isrun.find((r) => r.DOCTYP === "HP" && r.PREFIX === "H3");
  if (withH3 && (!run?.ACCNUM01 || !run?.ACCNUM02 || !run?.ACCNUM04)) return { status: "error", reason: "ไม่พบบัญชีของ H3 ใน ISRUN" };
  const hp = withH3 ? balanceColumn(isprd, order.date, "HP") : { column: "" };
  if (hp.error) return { status: "error", reason: hp.error };
  if (!pk && !isrun.some((r) => r.DOCTYP === "PO" && r.PREFIX === "PK")) return { status: "error", reason: "ไม่พบเลขรันของ PK ใน ISRUN" };

  return {
    status: "ready",
    orderId: order.id,
    date: order.date,
    invoice: order.invoice,
    user,
    pkNo: pk?.PONUM || "", // existing PK: only the H3 is written
    withH3,
    force: order.force === true, // fuel-write.ps1 re-checks the possible duplicates above unless confirmed
    h3Prefix: h3Prefix(order.date),
    supplier: { code: sup.SUPCOD, name: sup.SUPNAM, prenam: sup.PRENAM, taxId: sup.TAXID, branch: Number(sup.ORGNUM) || 0 },
    item: { code: item.STKCOD, desc: item.STKDES, unit: item.PQUCOD || "ลต" },
    dep: order.dep,
    qty: order.liters,
    ...a,
    accounts: withH3 ? { expense: run.ACCNUM01, vat: run.ACCNUM02, pay: run.ACCNUM04 } : null,
    hpColumn: hp.column,
    glDescr: `${sup.SUPNAM}:`.slice(0, 50), // ISRUN H3 JNLEXP "APMAS->SUPNAM -':'-APTRN->YOUREF", YOUREF empty
  };
}
