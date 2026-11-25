import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formStr, ok, readForm, str } from "@/lib/http";
import { getMasters, queueRepairExpress, repairOrder, type RepairBill } from "@/lib/express";
import { baht, dec } from "@/lib/format";
import { invoiceDateError, vatOnTopOff } from "@/lib/fuel-checks";
import { dateOnly } from "@/lib/time";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// Thrown inside the transaction so the repair keeps its old fields: its failed order was retried or settled meanwhile.
class Raced extends Error {}

// จัดซื้อ / Office: a costed repair that has no Express order (not queued when the cost was saved: no masters yet,
// writing off, no department, no supplier or item picked, a bad invoice, a closed VAT month, ...), or whose order the
// office PC could not write (status error: e.g. VAT on a garage without a usable tax ID, an item no longer in the
// masters). The form gives the bill's Express fields again (supplierCode, itemCode, invoice, invoiceDate, vatMode: the
// VAT mode is not kept); they are saved on the repair and its PO + RR is queued in one transaction: a new order, or
// the failed one replaced (guarded on its status error, so a retry or close meanwhile refuses this save).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing", "office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const id = str((await params).id, 40);
  const fd = await readForm(req, 100_000);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const supplierCode = formStr(fd, "supplierCode", 20);
  const itemCode = formStr(fd, "itemCode", 40);
  const invoice = formStr(fd, "invoice", 31);
  const invoiceDate = formStr(fd, "invoiceDate", 10);
  const vatMode = formStr(fd, "vatMode", 2);

  const r = await prisma.repairRequest.findUnique({
    where: { id },
    select: {
      no: true,
      symptom: true,
      costAmount: true,
      costDetail: true,
      costedAt: true,
      express: { select: { status: true } },
      vehicle: { select: { code: true, expressDep: true, expressItem: true } },
    },
  });
  if (!r) return bad("ไม่พบรายการ", 404);
  const costedAt = r.costedAt;
  const failed = r.express?.status === "error";
  if (!costedAt || (r.express && !failed)) return bad(CHANGED);
  const costAmount = dec(r.costAmount) ?? 0;

  const m = await getMasters();
  if (!m) return bad("ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)");
  const supplier = m.repair.suppliers.find((s) => s.code === supplierCode);
  if (!supplier) return bad("เลือกร้าน / อู่ (ผู้จำหน่ายใน Express)");
  if (!m.repair.items.some((i) => i.code === itemCode)) return bad("เลือกรหัสค่าซ่อม (Express)");
  if (!invoice || invoice.length > 30) return bad("กรอกเลขที่ใบกำกับภาษี ไม่เกิน 30 ตัวอักษร");
  const dateError = invoiceDateError(invoiceDate);
  if (dateError) return bad(dateError);
  if (!["0", "1", "2"].includes(vatMode)) return bad("เลือก VAT ในใบกำกับภาษี");
  if (vatMode !== "0" && !supplier.vat) return bad(`${supplier.name} ไม่มีเลขประจำตัวผู้เสียภาษีใน Express (บิลไม่ใช่ใบกำกับภาษี): เลือก "ไม่มี VAT"`);
  if (vatMode === "2" && vatOnTopOff(costAmount)) return bad(`ค่าซ่อม ${baht(costAmount)} บาท แยกเป็นราคา + VAT 7% ไม่ลงตัว: ตรวจยอดในบิล หรือเลือก VAT ใหม่`);

  const bill: RepairBill = {
    id,
    no: r.no,
    supplierCode,
    itemCode,
    invoice,
    invoiceDate: dateOnly(invoiceDate),
    costAmount,
    vatMode,
    costedAt,
    symptom: r.symptom,
    costDetail: r.costDetail,
    vehicle: r.vehicle,
  };
  try {
    const q = await prisma.$transaction(async (tx) => {
      const n = await tx.repairRequest.updateMany({
        // still without an order, or still with the failed one this form was opened on
        where: { id, costedAt, express: failed ? { is: { status: "error" } } : { is: null } },
        data: { supplierCode, supplierName: supplier.name, itemCode, invoice, invoiceDate: dateOnly(invoiceDate) },
      });
      if (n.count !== 1) return null;
      if (!failed) return queueRepairExpress(tx, bill, u.name);
      // the failed order itself is queued again with this bill (a repair has one order: repairRequestId is unique)
      const o = await repairOrder(tx, bill);
      if ("reason" in o) return { queued: false as const, reason: o.reason };
      const swapped = await tx.expressOrder.updateMany({ where: { repairRequestId: id, status: "error" }, data: { status: "queued", error: null, payload: o.payload } });
      if (swapped.count !== 1) throw new Raced();
      return { queued: true as const, note: o.note };
    });
    if (!q) return bad(CHANGED);
    if (!q.queued) return ok({ notice: `บันทึกข้อมูลบิลแล้ว แต่ยังส่งเข้า Express ไม่ได้: ${q.reason}` });
    return ok({ queued: true, ...(q.note ? { notice: q.note } : {}) });
  } catch (e) {
    // two people sent it at once (ExpressOrder.repairRequestId is unique, the other one won), or the failed order was
    // retried or settled meanwhile
    if (e instanceof Raced || (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) return bad(CHANGED);
    throw e;
  }
}
