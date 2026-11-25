import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { appLink, notifyRoles, notifyUsers } from "@/lib/line";
import { getMasters, queueRepairExpress } from "@/lib/express";
import { baht, dec } from "@/lib/format";
import { invoiceDateError, vatOnTopOff } from "@/lib/fuel-checks";
import { dateOnly } from "@/lib/time";

// จัดซื้อ saves the repair cost: approved -> repairing, and its PO + RR is queued for Express in the same transaction.
// The cost may be at most 5% above the approved quotation; more needs a new approval (quote route, "ขออนุมัติใหม่").
// One not queued here can be sent later from the repair page (/api/repairs/<id>/express).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");

  // Rounded once so the stored amount and the one Express books are the same number.
  const rawAmount = formNum(fd, "costAmount");
  const costAmount = rawAmount === null ? null : Math.round(rawAmount * 100) / 100;
  const costDetail = formStr(fd, "costDetail", 2100).replace(/\r\n/g, "\n");
  const files = formFiles(fd, "billFiles");
  // Read longer than Express allows so an over-long code never gets cut down to a valid one.
  const supplierCode = formStr(fd, "supplierCode", 20);
  const itemCode = formStr(fd, "itemCode", 40);
  const invoice = formStr(fd, "invoice", 31);
  // The date on the tax invoice: the date of the PO / RR and of its input VAT in Express.
  const invoiceDate = formStr(fd, "invoiceDate", 10);
  // As on the tax invoice: "1" prices include VAT, "2" VAT on top, "0" none (the PO / RR is keyed this way).
  const vatMode = formStr(fd, "vatMode", 2);
  if (costAmount === null || !(costAmount > 0) || costAmount >= 1e10) return bad("กรอกค่าซ่อม");
  const dateError = invoiceDateError(invoiceDate);
  if (dateError) return bad(dateError);
  if (vatMode && !["0", "1", "2"].includes(vatMode)) return bad("ข้อมูลไม่ถูกต้อง");
  if (supplierCode && !vatMode) return bad("เลือก VAT ในใบกำกับภาษี");
  if (vatMode === "2" && vatOnTopOff(costAmount)) {
    return bad(`ค่าซ่อม ${baht(costAmount)} บาท แยกเป็นราคา + VAT 7% ไม่ลงตัว: ตรวจยอดในบิล หรือเลือก VAT ใหม่`);
  }
  if (costDetail.length > 2000) return bad("รายละเอียดยาวเกิน 2000 ตัวอักษร");
  if (invoice.length > 30) return bad("เลขที่ใบกำกับภาษียาวเกิน 30 ตัวอักษร");
  if (files.length < 1 || files.length > 10) return bad("แนบบิล / รูปงานซ่อม 1-10 ไฟล์");

  const m = supplierCode || itemCode ? await getMasters() : null;
  const supplier = supplierCode ? m?.repair.suppliers.find((s) => s.code === supplierCode) : undefined;
  if (supplierCode && !supplier) return bad("ไม่พบร้าน / อู่นี้ใน Express");
  if (itemCode && !m?.repair.items.some((i) => i.code === itemCode)) return bad("ไม่พบรหัสค่าซ่อมนี้ใน Express");
  // VAT on a bill needs a tax invoice: a garage with a tax ID in Express
  if (supplier && vatMode !== "0" && !supplier.vat) return bad(`${supplier.name} ไม่มีเลขประจำตัวผู้เสียภาษีใน Express (บิลไม่ใช่ใบกำกับภาษี): เลือก "ไม่มี VAT"`);
  const supplierName = supplier?.name || formStr(fd, "supplierName", 120);

  const r = await prisma.repairRequest.findUnique({
    where: { id },
    select: {
      no: true,
      status: true,
      symptom: true,
      driverId: true,
      quoteAmount: true,
      quotedAt: true,
      vehicle: { select: { code: true, expressDep: true, expressItem: true } },
    },
  });
  if (!r) return bad("ไม่พบรายการ", 404);
  if (r.status !== "approved") return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  // Compared in satang so the 5% line is exact.
  const quote = dec(r.quoteAmount);
  if (quote !== null && Math.round(costAmount * 100) * 100 > Math.round(quote * 100) * 105) {
    return bad(`ค่าซ่อม ${baht(costAmount)} บาท สูงกว่าใบเสนอราคาที่อนุมัติ ${baht(quote)} บาท เกิน 5%: กด "ขออนุมัติใหม่" พร้อมใบเสนอราคาใหม่`);
  }

  // The bills are kept only by the cost saved below: one file refused, or the save refused or failed, takes back
  // every file saved for it, so none is kept without a repair pointing to it.
  const keys: string[] = [];
  const takeBack = () => Promise.all(keys.map(removeUpload));
  try {
    for (const f of files) keys.push(await saveUpload(f, "repair-bill", { pdf: true }));
  } catch (e) {
    await takeBack();
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }

  const costedAt = new Date();
  const q = await prisma.$transaction(async (tx) => {
    const res = await tx.repairRequest.updateMany({
      // quotedAt: still the quotation checked above (a re-quote approved meanwhile changes it)
      where: { id, status: "approved", quotedAt: r.quotedAt },
      data: { status: "repairing", costAmount, costDetail, billFiles: keys, supplierCode, supplierName, itemCode, invoice, invoiceDate: dateOnly(invoiceDate), costedBy: u.name, costedAt },
    });
    if (res.count !== 1) return null;
    return queueRepairExpress(
      tx,
      { id, no: r.no, supplierCode, itemCode, invoice, invoiceDate: dateOnly(invoiceDate), costAmount, vatMode, costedAt, symptom: r.symptom, costDetail, vehicle: r.vehicle },
      u.name
    );
  }).catch(async (e) => {
    await takeBack();
    throw e;
  });
  if (!q) {
    await takeBack();
    return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  }

  // Exec and accounting get the same text, each with a link to a page their role can open.
  const express = q.queued ? `กำลังเปิด PO / RR${q.note ? ` (${q.note})` : ""}` : q.reason;
  const msg = `เริ่มซ่อม #${r.no} รถ ${r.vehicle.code} ค่าซ่อม ${baht(costAmount)} บาท\nExpress: ${express}\n`;
  await notifyUsers([r.driverId], `เริ่มซ่อม #${r.no} รถ ${r.vehicle.code}\n${appLink("/driver/my")}`);
  await notifyRoles(["exec"], msg + appLink(`/exec/repairs/${id}`));
  await notifyRoles(["accounting"], msg + appLink(`/purchasing/repairs/${id}`));
  if (!q.queued) return ok({ express: q.reason, notice: `บันทึกแล้ว ไม่ได้ส่งเข้า Express: ${q.reason}` });
  return ok({ express: "queued", ...(q.note ? { notice: `บันทึกแล้ว: ${q.note}` } : {}) });
}
