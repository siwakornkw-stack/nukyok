import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { appLink, notifyOfficeGroup } from "./line";
import { bkkDateKey, shiftMonth } from "./time";

// Express Accounting, web side. The office PC that holds the Express data runs
// scripts/express-agent.mjs every minute: it sends the master data (fuel
// suppliers and per-vehicle items; repair suppliers, service items and every
// Express department) and writes what is queued here, then reports back
// (/api/express/*).
//   fuel   (Office approved, filled at a pump): PK + H3 -> R3 of the bill date
//   repair (จัดซื้อ saved the repair cost):      PO + RR (bought on credit from the garage, no R3)
// Each side only runs while its mode is "live" on that PC; the masters carry
// that flag ("writer"): nothing is queued while it is off, and what was queued
// becomes an error when it goes off (saveMasters). The R3 goes with the fuel
// writer (install.cmd sets both from one answer).

const MASTERS_KEY = "express_masters";
// "YYYY-MM": the last month whose VAT return (ภ.พ.30) Office marked as filed on /office/express
export const VAT_FILED_KEY = "vat_filed_through";

const text = (max: number) => z.string().catch("").transform((s) => s.trim().slice(0, max));
// vat: the supplier has a usable tax ID in Express (13 digits, not a filler such as 0000000000000 keyed for a shop
// without one), so its bill can be a tax invoice. Newer agents send it; for older ones, which sent only the taxId, it
// is worked out here by the same rule as the agent (fuel-masters.mjs, repair.mjs). The ID itself is kept only for a Thai
// juristic person (a usable ID from 0 then 1-9): an individual's is a national ID the web has no use for, and one
// from 00 is a non-Thai person's.
const supplier = z
  .object({ code: text(10), name: text(120), taxId: text(20).optional(), vat: z.boolean().optional() })
  .transform(({ taxId = "", vat, ...s }): { code: string; name: string; vat: boolean; taxId?: string } => {
    const id = taxId.replace(/\D/g, "");
    const usable = /^\d{13}$/.test(id) && !/^(\d)\1{12}$/.test(id);
    return { ...s, vat: vat ?? usable, ...(usable && /^0[1-9]/.test(id) ? { taxId: id } : {}) };
  });
const item = z.object({
  code: text(20),
  desc: text(50),
  depCode: text(4),
  depName: text(50).optional(),
  unit: text(4).optional(),
  stock: z.boolean().catch(false),
  vatClaim: z.boolean().catch(false), // unknown = not claimable: the PK only, staff key the H3
});
const department = z.object({ code: text(4), name: text(50) });
const book = z.object({ suppliers: z.array(supplier).max(1000), items: z.array(item).max(2000), writer: z.boolean().catch(false) });
// The repair book of a newer agent also carries every Express department (ISTAB 50), used by an item or not.
const mastersSchema = z.object({ fuel: book, repair: book.extend({ departments: z.array(department).max(1000).optional() }) });

export type ExpressBook = z.infer<typeof book>;
export type ExpressItem = z.infer<typeof item>;
export type ExpressMasters = z.infer<typeof mastersSchema> & { at: string };

// The masters as the office PC sent them, cleaned as above; null when they are not masters.
export function parseMasters(raw: unknown) {
  const p = mastersSchema.safeParse(raw);
  return p.success ? p.data : null;
}

const DOC = { fuel: "PK / H3", repair: "PO / RR" } as const;

export async function saveMasters(raw: unknown): Promise<boolean> {
  const data = parseMasters(raw);
  if (!data) return false;
  const value = { ...data, at: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: MASTERS_KEY }, update: { value }, create: { key: MASTERS_KEY, value } });
  // A writer turned off on the office PC (install.cmd) would leave its queued bills to be written unattended, with
  // their old dates, whenever it is turned on again: they become errors a person settles (keyed by hand, or ลองใหม่
  // once writing is back on). Nothing new is queued while it is off. The R3 goes with the fuel writer (install.cmd
  // sets EXPRESS_R3_MODE from the same answer; the masters carry no flag of its own): the R3 steps of written fuel
  // orders still to do (queued, force, or waiting for staff to key the H3) become R3 errors the same way.
  for (const kind of ["fuel", "repair"] as const) {
    if (data[kind].writer) continue;
    const n = await prisma.expressOrder.updateMany({
      where: { kind, status: "queued" },
      data: { status: "error", error: `การเปิด ${DOC[kind]} อัตโนมัติถูกปิดที่เครื่อง Office: ตรวจใน Express ถ้าคีย์เองแล้วกด "คีย์เองแล้ว" ถ้ายังไม่มี กด "ลองใหม่" เมื่อเปิดการเขียนอีกครั้ง` },
    });
    const r3 =
      kind === "fuel"
        ? await prisma.expressOrder.updateMany({
            where: { kind, status: "written", r3Status: { in: ["queued", "force", "waiting"] } },
            data: {
              r3Status: "error",
              r3Error: `การเปิด R3 อัตโนมัติถูกปิดที่เครื่อง Office (ปิดพร้อม PK / H3): ทำ R3 ใน Express เอง (คีย์ H3 ก่อนถ้ายังไม่มี) แล้วกด "ทำ R3 เองแล้ว" หรือกด "ลองใหม่" เมื่อเปิดการเขียนอีกครั้ง`,
            },
          })
        : { count: 0 };
    const moved = [n.count ? `${n.count} รายการที่รอเขียน` : "", r3.count ? `R3 ${r3.count} รายการที่รอเปิด` : ""].filter(Boolean).join(" และ ");
    if (moved) await notifyOfficeGroup(`ปิดการเปิด ${DOC[kind]} อัตโนมัติที่เครื่อง Office: ${moved}ย้ายไปที่ "ไม่สำเร็จ" ตรวจใน Express แล้วจัดการเอง\n${appLink("/office/express?f=problem")}`);
  }
  return true;
}

// db: pass the transaction client when called inside one (a second pool connection
// taken while the transaction holds one can stall under load).
export async function getMasters(db: Prisma.TransactionClient = prisma): Promise<ExpressMasters | null> {
  const row = await db.appSetting.findUnique({ where: { key: MASTERS_KEY } });
  const data = parseMasters(row?.value);
  return data ? { ...data, at: (row!.value as { at?: string }).at ?? "" } : null;
}

// The office PC resends the masters every 15 minutes: an hour without them = PC off, offline or its task stopped.
export const agentSilent = (m: { at: string }, now = Date.now()) => !m.at || now - new Date(m.at).getTime() > 60 * 60_000;

// Express departments (ISTAB 50) the masters know: code -> name. A newer agent sends them all (repair.departments);
// for an older one, those of every fuel and repair item. A vehicle's department must be one of them (codes are
// case-sensitive in Express).
export function knownDepartments(m: ExpressMasters): Map<string, string> {
  if (m.repair.departments?.length) return new Map(m.repair.departments.filter((d) => d.code).map((d) => [d.code, d.name] as const));
  const deps = new Map<string, string>();
  for (const i of [...m.fuel.items, ...m.repair.items]) if (i.depCode && !deps.get(i.depCode)) deps.set(i.depCode, i.depName ?? "");
  return deps;
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

// The last VAT month (YYYY-MM) whose input VAT the writers may no longer book: every month before last, last month
// once its ภ.พ.30 deadline (the 15th, Bangkok) is past, or a later month Office marked as filed ("" = none marked).
export function vatClosedThrough(filed: string, now = new Date()): string {
  const today = bkkDateKey(now);
  const auto = shiftMonth(today.slice(0, 7), Number(today.slice(8, 10)) > 15 ? -1 : -2);
  return MONTH.test(filed) && filed > auto ? filed : auto;
}

// The month Office marked as filed on /office/express ("" = none).
export async function vatFiledThrough(db: Prisma.TransactionClient = prisma): Promise<string> {
  const v = (await db.appSetting.findUnique({ where: { key: VAT_FILED_KEY } }))?.value;
  return typeof v === "string" && MONTH.test(v) ? v : "";
}

// A bill dated dateKey (YYYY-MM-DD) is in a closed VAT month: staff key its input VAT into a month still open.
export async function vatMonthClosed(dateKey: string, db: Prisma.TransactionClient = prisma, now = new Date()): Promise<boolean> {
  return dateKey.slice(0, 7) <= vatClosedThrough(await vatFiledThrough(db), now);
}

// "2026-10" -> "ต.ค. 69"
export const thMonth = (ym: string) => new Intl.DateTimeFormat("th-TH", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${ym}-01T00:00:00Z`));

// Staff key the tax invoice without its leading Thai letters ("ต2610…" ->
// "2610…"); Express holds 15 characters. null when it still does not fit.
export function expressInvoice(invoice: string): string | null {
  let s = invoice.trim().replace(/\s+/g, "");
  if (/^[ก-ฮ]+\d+$/.test(s)) s = s.replace(/^[ก-ฮ]+/, "");
  return s && s.length <= 15 ? s : null;
}

// litres x price more than 1 baht off the paid total = a typo. Same test as fuel.mjs on the
// office PC (unrounded), so nothing is queued that the planner would refuse.
export function priceOff(liters: number, price: number, amount: number): string | null {
  if (!(price > 0) || Math.abs(liters * price - amount) <= 1) return null;
  return `ลิตร × ราคาต่อลิตร (${(liters * price).toFixed(2)}) ไม่ตรงกับยอดเงิน (${amount.toFixed(2)})`;
}

// Express dates the bill (PK / H3 / PO / RR, the VAT row and its period) by the tax invoice's own date; rows saved
// before that date was asked for use the Bangkok date they were saved.
const billDate = (invoiceDate: Date | null | undefined, saved: Date) => (invoiceDate ? invoiceDate.toISOString().slice(0, 10) : bkkDateKey(saved));

// note / reason: shown to the person who acted (a change made to the order / why it was not queued).
type Queued = { queued: true; note?: string } | { queued: false; reason: string };
type Order = { payload: Prisma.InputJsonObject; note?: string } | { reason: string };

export type FuelBill = {
  id: string;
  source: string | null;
  supplierCode: string;
  invoice: string;
  liters: number;
  pricePerLiter: number;
  amount: number;
  filledAt: Date;
  invoiceDate?: Date | null; // date on the tax invoice (null: the Bangkok date of filledAt)
  vehicle: { expressItem: string; expressDep?: string };
};

// An approved pump fill -> the PK + H3 the office PC writes, or why it cannot be booked. Retry builds it again the
// same way from the current fill, vehicle and masters.
export async function fuelOrder(db: Prisma.TransactionClient, r: FuelBill): Promise<Order> {
  if (r.source !== "pump") return { reason: "ถังกลาง: ไม่ต้องเปิด PK" };
  const m = await getMasters(db);
  if (!m) return { reason: "ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)" };
  if (!m.fuel.writer) return { reason: "การเปิด PK / H3 อัตโนมัติยังไม่เปิดใช้" };
  const sup = m.fuel.suppliers.find((s) => s.code === r.supplierCode);
  if (!sup) return { reason: "ยังไม่ได้เลือกปั๊ม (ผู้จำหน่ายใน Express)" };
  const it = m.fuel.items.find((i) => i.code === r.vehicle.expressItem);
  if (!it) return { reason: "รถคันนี้ยังไม่ได้ตั้งรหัสน้ำมันใน Express (หน้าข้อมูลรถ)" };
  const dep = r.vehicle.expressDep || it.depCode;
  if (!dep) return { reason: `รหัส ${it.code} ไม่มีแผนกใน Express` };
  if (!knownDepartments(m).has(dep)) return { reason: `แผนก ${dep} ไม่มีใน Express: แก้แผนก Express ของรถ (หน้าข้อมูลรถ)` };
  const invoice = expressInvoice(r.invoice);
  if (!invoice) return { reason: "ไม่มีเลขที่ใบกำกับภาษี หรือยาวเกิน 15 ตัว" };
  if (!(r.liters > 0) || !(r.amount > 0)) return { reason: "ลิตรหรือยอดเงินเป็นศูนย์" };
  const off = priceOff(r.liters, r.pricePerLiter, r.amount);
  if (off) return { reason: off };
  const date = billDate(r.invoiceDate, r.filledAt);
  // Stock item / VAT not claimable, or not known yet (no H3 of the item): the PK only, staff key that H3. So too for a
  // pump without a usable tax ID in Express (its bill is no tax invoice: the H3 would claim input VAT on an ISVAT row
  // without the seller's ID; repair refuses VAT for such a supplier), and in a closed VAT month: staff claim the
  // bill's input VAT in a month still open.
  let withH3 = !it.stock && it.vatClaim;
  let note: string | undefined;
  if (withH3 && !sup.vat) {
    withH3 = false;
    note = `ปั๊ม ${sup.code} ไม่มีเลขประจำตัวผู้เสียภาษีใน Express (บิลไม่ใช่ใบกำกับภาษี): เปิดเฉพาะ PK ให้ คีย์ H3 ใน Express เอง`;
  } else if (withH3 && (await vatMonthClosed(date, db))) {
    withH3 = false;
    note = `เดือนภาษี ${thMonth(date.slice(0, 7))} ปิดแล้ว: เปิดเฉพาะ PK ให้ คีย์ H3 ใน Express เองโดยลงภาษีซื้อในเดือนที่ยังเปิด`;
  }
  return { payload: { withH3, supplier: r.supplierCode, item: it.code, dep, date, invoice, liters: r.liters, price: r.pricePerLiter, amount: r.amount }, note };
}

// Office approved a fuel fill: queue its PK + H3 when it can be booked. Call inside the approval transaction.
export async function queueFuelExpress(tx: Prisma.TransactionClient, r: FuelBill, username: string): Promise<Queued> {
  const o = await fuelOrder(tx, r);
  if ("reason" in o) return { queued: false, reason: o.reason };
  await tx.expressOrder.create({ data: { kind: "fuel", fuelRequestId: r.id, createdBy: username, payload: o.payload } });
  return o.note ? { queued: true, note: o.note } : { queued: true };
}

export type RepairBill = {
  id: string;
  no: number;
  supplierCode: string;
  itemCode: string;
  invoice: string;
  costAmount: number;
  vatMode: string; // as on the tax invoice: "1" prices include VAT, "2" VAT on top, "0" none
  costedAt: Date;
  invoiceDate?: Date | null; // date on the tax invoice (null: the Bangkok date of costedAt)
  symptom: string;
  costDetail: string;
  vehicle: { code: string; expressDep: string; expressItem?: string };
};

// A costed repair -> the PO + RR the office PC writes, or why it cannot be booked. Retry builds it again the same
// way from the current repair, vehicle and masters.
export async function repairOrder(db: Prisma.TransactionClient, r: RepairBill): Promise<Order> {
  const m = await getMasters(db);
  if (!m) return { reason: "ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)" };
  if (!m.repair.writer) return { reason: "การเปิด PO / RR อัตโนมัติยังไม่เปิดใช้" };
  const sup = m.repair.suppliers.find((s) => s.code === r.supplierCode);
  if (!sup) return { reason: "ยังไม่ได้เลือกร้าน / อู่ (ผู้จำหน่ายใน Express)" };
  const it = m.repair.items.find((i) => i.code === r.itemCode);
  if (!it) return { reason: "ยังไม่ได้เลือกรหัสค่าซ่อมใน Express" };
  if (it.stock) return { reason: `${it.code} เป็นสินค้าคงคลัง ต้องคีย์ใน Express เอง` };
  // The vehicle's department (typed on the vehicle page, else its fuel item's), never the service item's: a service
  // item is shared by every vehicle, its department is another's.
  const fuel = m.fuel.items.find((i) => i.code === r.vehicle.expressItem);
  const dep = r.vehicle.expressDep || fuel?.depCode || "";
  if (!dep) return { reason: "รถคันนี้ยังไม่ได้ตั้งแผนก Express (หน้าข้อมูลรถ)" };
  if (!knownDepartments(m).has(dep)) return { reason: `แผนก ${dep} ไม่มีใน Express: แก้แผนก Express ของรถ (หน้าข้อมูลรถ)` };
  const invoice = expressInvoice(r.invoice);
  if (!invoice) return { reason: "ไม่มีเลขที่ใบกำกับภาษี หรือยาวเกิน 15 ตัว" };
  if (!(r.costAmount > 0)) return { reason: "ยอดค่าซ่อมเป็นศูนย์" };
  if (!["0", "1", "2"].includes(r.vatMode)) return { reason: "ยังไม่ได้เลือก VAT ในใบกำกับภาษี" };
  const date = billDate(r.invoiceDate, r.costedAt);
  if (r.vatMode !== "0") {
    // The RR claims the bill's input VAT: only on a tax invoice (a garage with a tax ID), for a vehicle whose VAT
    // Express claims (its fuel item; not found = unknown = not claimable), in a VAT month still open.
    if (!sup.vat) return { reason: `${sup.code} ไม่มีเลขประจำตัวผู้เสียภาษีใน Express (บิลไม่ใช่ใบกำกับภาษี): เลือก "ไม่มี VAT" หรือคีย์ PO / RR ใน Express เอง` };
    if (!fuel) return { reason: "รถคันนี้ยังไม่ได้ตั้งรหัสน้ำมันใน Express หรือรหัสที่ตั้งไว้ไม่มีใน Express แล้ว: แก้ที่หน้าข้อมูลรถ หรือคีย์ PO / RR ใน Express เอง" };
    // vatClaim false: the item's latest H3 booked no input VAT (staff key a vehicle that cannot claim it with a
    // "ภาษีซื้อขอคืนไม่ได้" line), or it has no H3 yet (a new vehicle). Either way staff key the RR.
    if (!fuel.vatClaim)
      return { reason: `รหัสน้ำมัน ${fuel.code} ของรถคันนี้ไม่ได้ลงภาษีซื้อใน Express (รถที่ขอคืนภาษีซื้อไม่ได้ หรือยังไม่มี H3 ของรหัสนี้): คีย์ PO / RR ใน Express เอง` };
    if (await vatMonthClosed(date, db)) return { reason: `เดือนภาษี ${thMonth(date.slice(0, 7))} ปิดแล้ว: คีย์ PO / RR ใน Express เองโดยลงภาษีซื้อในเดือนที่ยังเปิด` };
  }
  return {
    payload: {
      supplier: r.supplierCode,
      item: it.code,
      dep,
      date,
      invoice,
      amount: r.costAmount,
      vat: r.vatMode,
      // as staff key it: the work in the line (STKDES), "<work> <plate>" in YOUREF (fitted by the writer)
      job: Array.from((r.costDetail.split("\n").find((l) => l.trim()) || r.symptom).replace(/\s+/g, " ").trim()).slice(0, 80).join(""),
      plate: r.vehicle.code,
    },
  };
}

// จัดซื้อ saved the repair cost: queue its PO + RR. Call inside that transaction.
export async function queueRepairExpress(tx: Prisma.TransactionClient, r: RepairBill, username: string): Promise<Queued> {
  const o = await repairOrder(tx, r);
  if ("reason" in o) return { queued: false, reason: o.reason };
  await tx.expressOrder.create({ data: { kind: "repair", repairRequestId: r.id, createdBy: username, payload: o.payload } });
  return { queued: true };
}

export const EXPRESS_STATUS: Record<string, string> = {
  queued: "รอเครื่อง Office เขียนลง Express",
  written: "เขียนลง Express แล้ว",
  error: "เขียนลง Express ไม่สำเร็จ",
  // Office voided a wrong or test order (/api/express/close): its documents already in Express are voided there by
  // staff; until then the same-bill check still counts its numbers when a result names every one of them (applyResults)
  cancelled: "ยกเลิก",
  // staff keyed it in Express by hand (/api/express/queue-fuel { manual }, /repair-manual, /close): no agent route,
  // retry or problem count looks at this status, and it has no R3 step
  manual: "คีย์ใน Express เอง",
};

export const R3_STATUS: Record<string, string> = {
  queued: "รอเปิด R3",
  waiting: "รอ H3 (คีย์ใน Express)",
  force: "ยืนยันแล้ว รอเปิด R3",
  error: "เปิด R3 ไม่สำเร็จ",
  done: "R3 เรียบร้อย",
  manual: "ทำ R3 ใน Express เอง", // after an R3 error (/api/express/close)
};

// "PK0000012 · H3691109-01 · R3691109-01"
export const expressDocs = (o: { poNo: string | null; h3No: string | null; r3No: string | null }) =>
  [o.poNo, o.h3No, o.r3No].filter(Boolean).join(" · ");
