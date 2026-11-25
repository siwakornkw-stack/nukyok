import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { appLink, notifyRoles } from "@/lib/line";
import { baht } from "@/lib/format";

// จัดซื้อ attaches the quotation: quote -> approval, then the executives are asked (they approve from the LINE link).
// approved / rejected -> approval again ("ขออนุมัติใหม่"): a new quotation replaces the approved or rejected one.
// "seen" is the quotedAt of the quotation the form was opened on ("" for none): a form opened before
// someone else sent a quotation is refused instead of being taken as a re-quote.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");

  const quoteAmount = formNum(fd, "quoteAmount");
  const quoteNote = formStr(fd, "quoteNote", 1100).replace(/\r\n/g, "\n");
  const files = formFiles(fd, "quoteFiles");
  if (quoteAmount === null || !(quoteAmount > 0) || quoteAmount >= 1e10) return bad("กรอกยอดใบเสนอราคา");
  if (quoteNote.length > 1000) return bad("หมายเหตุยาวเกิน 1000 ตัวอักษร");
  if (files.length < 1 || files.length > 10) return bad("แนบใบเสนอราคา 1-10 ไฟล์");

  const r = await prisma.repairRequest.findUnique({
    where: { id },
    select: { no: true, status: true, symptom: true, quoteAmount: true, quotedAt: true, vehicle: { select: { code: true } } },
  });
  if (!r) return bad("ไม่พบรายการ", 404);
  if (!["quote", "approved", "rejected"].includes(r.status) || formStr(fd, "seen", 40) !== (r.quotedAt?.toISOString() ?? "")) {
    return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  }
  const requote = r.status !== "quote";

  // The files are kept only by the quotation saved below: one file refused, or the save refused or failed, takes
  // back every file saved for it, so none is kept without a repair pointing to it.
  const keys: string[] = [];
  const takeBack = () => Promise.all(keys.map(removeUpload));
  try {
    for (const f of files) keys.push(await saveUpload(f, "repair-quote", { pdf: true }));
  } catch (e) {
    await takeBack();
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }

  const res = await prisma.repairRequest.updateMany({
    where: { id, status: r.status, quotedAt: r.quotedAt },
    data: {
      status: "approval",
      quoteAmount,
      quoteNote,
      quoteFiles: keys,
      quotedBy: u.name,
      quotedAt: new Date(),
      decidedBy: null,
      decidedAt: null,
      decisionNote: "",
    },
  }).catch(async (e) => {
    await takeBack();
    throw e;
  });
  if (res.count !== 1) {
    await takeBack();
    return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  }

  await notifyRoles(
    ["exec"],
    `${requote ? "ขออนุมัติใหม่ (ราคาเปลี่ยน)" : "ขออนุมัติซ่อม"} #${r.no} รถ ${r.vehicle.code}\nอาการ: ${r.symptom}\n` +
      `ใบเสนอราคา ${baht(quoteAmount)} บาท${requote ? ` (เดิม ${baht(r.quoteAmount)} บาท)` : ""}\n${appLink(`/exec/repairs/${id}`)}`
  );
  return ok();
}
