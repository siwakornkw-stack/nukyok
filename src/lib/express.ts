import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { bkkDateKey } from "./time";

// Express Accounting, web side. The office PC that holds the Express data runs
// scripts/express-agent.mjs every minute: it sends the master data (fuel
// suppliers and per-vehicle items; repair suppliers and service items) and
// writes what is queued here, then reports back (/api/express/*).
//   fuel   (Office approved, filled at a pump): PK + H3 -> R3 of the bill date
//   repair (จัดซื้อ saved the repair cost):      PO + RR (bought on credit from the garage, no R3)
// Each side only runs while its mode is "live" on that PC; the masters carry
// that flag ("writer") and nothing is queued while it is off.

const MASTERS_KEY = "express_masters";

const text = (max: number) => z.string().catch("").transform((s) => s.trim().slice(0, max));
const supplier = z.object({ code: text(10), name: text(120), taxId: text(15).optional(), branch: text(5).optional() });
const item = z.object({
  code: text(20),
  desc: text(50),
  depCode: text(4),
  depName: text(50).optional(),
  unit: text(4).optional(),
  stock: z.boolean().catch(false),
  vatClaim: z.boolean().catch(true),
});
const book = z.object({ suppliers: z.array(supplier).max(500), items: z.array(item).max(2000), writer: z.boolean().catch(false) });
const mastersSchema = z.object({ fuel: book, repair: book });

export type ExpressBook = z.infer<typeof book>;
export type ExpressItem = z.infer<typeof item>;
export type ExpressMasters = z.infer<typeof mastersSchema> & { at: string };

export async function saveMasters(raw: unknown): Promise<boolean> {
  const p = mastersSchema.safeParse(raw);
  if (!p.success) return false;
  const value = { ...p.data, at: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: MASTERS_KEY }, update: { value }, create: { key: MASTERS_KEY, value } });
  return true;
}

// db: pass the transaction client when called inside one (a second pool connection
// taken while the transaction holds one can stall under load).
export async function getMasters(db: Prisma.TransactionClient = prisma): Promise<ExpressMasters | null> {
  const row = await db.appSetting.findUnique({ where: { key: MASTERS_KEY } });
  const p = mastersSchema.safeParse(row?.value);
  return p.success ? { ...p.data, at: (row!.value as { at?: string }).at ?? "" } : null;
}

// The office PC resends the masters every 15 minutes: an hour without them = PC off, offline or its task stopped.
export const agentSilent = (m: { at: string }, now = Date.now()) => !m.at || now - new Date(m.at).getTime() > 60 * 60_000;

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

type Queued = { queued: true } | { queued: false; reason: string };

// Office approved a fuel fill: queue its PK + H3 when it can be booked.
// Call inside the approval transaction. The reason explains a skip (shown on the page).
export async function queueFuelExpress(
  tx: Prisma.TransactionClient,
  r: {
    id: string;
    source: string | null;
    supplierCode: string;
    invoice: string;
    liters: number;
    pricePerLiter: number;
    amount: number;
    filledAt: Date;
    vehicle: { expressItem: string; expressDep?: string };
  },
  username: string
): Promise<Queued> {
  if (r.source !== "pump") return { queued: false, reason: "ถังกลาง: ไม่ต้องเปิด PK" };
  const m = await getMasters(tx);
  if (!m) return { queued: false, reason: "ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)" };
  if (!m.fuel.writer) return { queued: false, reason: "การเปิด PK / H3 อัตโนมัติยังไม่เปิดใช้" };
  if (!m.fuel.suppliers.some((s) => s.code === r.supplierCode)) return { queued: false, reason: "ยังไม่ได้เลือกปั๊ม (ผู้จำหน่ายใน Express)" };
  const it = m.fuel.items.find((i) => i.code === r.vehicle.expressItem);
  if (!it) return { queued: false, reason: "รถคันนี้ยังไม่ได้ตั้งรหัสน้ำมันใน Express (หน้าข้อมูลรถ)" };
  const dep = r.vehicle.expressDep || it.depCode;
  if (!dep) return { queued: false, reason: `รหัส ${it.code} ไม่มีแผนกใน Express` };
  const invoice = expressInvoice(r.invoice);
  if (!invoice) return { queued: false, reason: "ไม่มีเลขที่ใบกำกับภาษี หรือยาวเกิน 15 ตัว" };
  if (!(r.liters > 0) || !(r.amount > 0)) return { queued: false, reason: "ลิตรหรือยอดเงินเป็นศูนย์" };
  const off = priceOff(r.liters, r.pricePerLiter, r.amount);
  if (off) return { queued: false, reason: off };
  await tx.expressOrder.create({
    data: {
      kind: "fuel",
      fuelRequestId: r.id,
      createdBy: username,
      payload: {
        withH3: !it.stock && it.vatClaim, // stock item / VAT not claimable: the PK only, staff key that H3
        supplier: r.supplierCode,
        item: it.code,
        dep,
        date: bkkDateKey(r.filledAt),
        invoice,
        liters: r.liters,
        price: r.pricePerLiter,
        amount: r.amount,
      },
    },
  });
  return { queued: true };
}

// จัดซื้อ saved the repair cost: queue its PO + RR. Call inside that transaction.
export async function queueRepairExpress(
  tx: Prisma.TransactionClient,
  r: {
    id: string;
    no: number;
    supplierCode: string;
    itemCode: string;
    invoice: string;
    costAmount: number;
    vatMode: string; // as on the tax invoice: "1" prices include VAT, "2" VAT on top, "0" none
    costedAt: Date;
    symptom: string;
    costDetail: string;
    vehicle: { code: string; expressDep: string; expressItem?: string };
  },
  username: string
): Promise<Queued> {
  const m = await getMasters(tx);
  if (!m) return { queued: false, reason: "ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)" };
  if (!m.repair.writer) return { queued: false, reason: "การเปิด PO / RR อัตโนมัติยังไม่เปิดใช้" };
  // The writer claims the VAT of a VAT-registered garage; a vehicle whose fuel VAT is not claimable (its Express fuel item) is keyed by staff.
  if (m.fuel.items.some((i) => i.code === r.vehicle.expressItem && i.vatClaim === false)) {
    return { queued: false, reason: "รถคันนี้ขอคืนภาษีซื้อไม่ได้: คีย์ PO / RR ใน Express เอง" };
  }
  if (!m.repair.suppliers.some((s) => s.code === r.supplierCode)) return { queued: false, reason: "ยังไม่ได้เลือกร้าน / อู่ (ผู้จำหน่ายใน Express)" };
  const it = m.repair.items.find((i) => i.code === r.itemCode);
  if (!it) return { queued: false, reason: "ยังไม่ได้เลือกรหัสค่าซ่อมใน Express" };
  if (it.stock) return { queued: false, reason: `${it.code} เป็นสินค้าคงคลัง ต้องคีย์ใน Express เอง` };
  // The vehicle's own department only: a service item is shared by every vehicle, its department is another's.
  const dep = r.vehicle.expressDep;
  if (!dep) return { queued: false, reason: "รถคันนี้ยังไม่ได้ตั้งแผนก Express (หน้าข้อมูลรถ)" };
  const invoice = expressInvoice(r.invoice);
  if (!invoice) return { queued: false, reason: "ไม่มีเลขที่ใบกำกับภาษี หรือยาวเกิน 15 ตัว" };
  if (!(r.costAmount > 0)) return { queued: false, reason: "ยอดค่าซ่อมเป็นศูนย์" };
  if (!["0", "1", "2"].includes(r.vatMode)) return { queued: false, reason: "ยังไม่ได้เลือก VAT ในใบกำกับภาษี" };
  await tx.expressOrder.create({
    data: {
      kind: "repair",
      repairRequestId: r.id,
      createdBy: username,
      payload: {
        supplier: r.supplierCode,
        item: it.code,
        dep,
        date: bkkDateKey(r.costedAt),
        invoice,
        amount: r.costAmount,
        vat: r.vatMode,
        // as staff key it: the work in the line (STKDES), "<work> <plate>" in YOUREF (fitted by the writer)
        job: Array.from((r.costDetail.split("\n").find((l) => l.trim()) || r.symptom).replace(/\s+/g, " ").trim()).slice(0, 80).join(""),
        plate: r.vehicle.code,
      },
    },
  });
  return { queued: true };
}

export const EXPRESS_STATUS: Record<string, string> = {
  queued: "รอเครื่อง Office เขียนลง Express",
  written: "เขียนลง Express แล้ว",
  error: "เขียนลง Express ไม่สำเร็จ",
  cancelled: "ยกเลิก",
  // staff keyed it in Express by hand (/api/express/queue-fuel { manual }): no agent route, retry
  // or problem count looks at this status, and it has no R3 step
  manual: "คีย์ใน Express เอง",
};

export const R3_STATUS: Record<string, string> = {
  queued: "รอเปิด R3",
  waiting: "รอ H3 (คีย์ใน Express)",
  force: "ยืนยันแล้ว รอเปิด R3",
  error: "เปิด R3 ไม่สำเร็จ",
  done: "R3 เรียบร้อย",
};

// "PK0000012 · H3691109-01 · R3691109-01"
export const expressDocs = (o: { poNo: string | null; h3No: string | null; r3No: string | null }) =>
  [o.poNo, o.h3No, o.r3No].filter(Boolean).join(" · ");
