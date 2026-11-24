import { prisma } from "@/lib/db";
import { aiActor, aiUser, docNo } from "@/lib/ai";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { baht, dec } from "@/lib/format";
import { decideRepair } from "@/lib/actions";

// เลขา AI (ผู้บริหาร): { no: 12, approve: true | false, quoteAmount: 10700, note } on a repair waiting for approval.
// quoteAmount must be the amount on the current quotation: the decision is about the price the person saw,
// and a new quotation sent meanwhile makes it fail. Rejecting needs a note.
export async function POST(req: Request) {
  const a = await aiUser(req, ["exec"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  if (typeof b.approve !== "boolean") return bad("ต้องส่ง approve เป็น true หรือ false");
  const no = docNo(b.no);
  const r = no ? await prisma.repairRequest.findUnique({ where: { no }, select: { id: true, status: true, quoteAmount: true, quotedAt: true } }) : null;
  if (!r) return bad(`ไม่พบงานซ่อม #${str(b.no, 20)}`, 404);
  if (r.status !== "approval" || !r.quotedAt) return bad(`งานซ่อม #${no} ไม่ได้รออนุมัติ`);
  const quote = dec(r.quoteAmount) ?? 0;
  if (typeof b.quoteAmount !== "number" || Math.round(b.quoteAmount * 100) !== Math.round(quote * 100)) {
    return bad(`ใบเสนอราคาปัจจุบันของงานซ่อม #${no} คือ ${baht(quote)} บาท ยืนยันกับผู้ใช้แล้วส่ง quoteAmount นี้มาใหม่`);
  }
  const res = await decideRepair(aiActor(a.user), r.id, b.approve, str(b.note, 1000), r.quotedAt);
  return "error" in res ? bad(res.error, res.status) : ok({ no, approved: b.approve });
}
