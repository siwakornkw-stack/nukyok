import { prisma } from "@/lib/db";
import { aiActor, aiUser, docNo } from "@/lib/ai";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { baht, dec } from "@/lib/format";
import { reviewFuel } from "@/lib/actions";
import { flagCodes } from "@/lib/fuel-checks";

// เลขา AI (Office / ผู้บริหาร): { no: 12, action: "approve" | "return" | "cancel", amount: 3000, note } on a filled request.
// approve queues its Express PK / H3 / R3 and must send the current `amount` (baht): the approval is of the figures
// the person was shown, and a fill returned and filled again meanwhile makes it fail. return sends it back to the
// filler; return and cancel need a note. The version passed on is the one read here (reviewedAt, flags).
export async function POST(req: Request) {
  const a = await aiUser(req, ["office", "exec"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const no = docNo(b.no);
  const f = no ? await prisma.fuelRequest.findUnique({ where: { no }, select: { id: true, status: true, amount: true, reviewedAt: true, flags: true } }) : null;
  if (!f) return bad(`ไม่พบคำขอเติมน้ำมัน #${str(b.no, 20)}`, 404);
  const action = str(b.action, 20);
  if (action === "approve") {
    if (f.status !== "filled") return bad(`คำขอเติมน้ำมัน #${no} ไม่ได้รอตรวจ`);
    const amount = dec(f.amount) ?? 0;
    if (typeof b.amount !== "number" || Math.round(b.amount * 100) !== Math.round(amount * 100)) {
      return bad(`ยอดเงินปัจจุบันของคำขอเติมน้ำมัน #${no} คือ ${baht(amount)} บาท ยืนยันกับผู้ใช้แล้วส่ง amount นี้มาใหม่`, 409);
    }
  }
  const r = await reviewFuel(aiActor(a.user), f.id, action, str(b.note, 500), { reviewedAt: f.reviewedAt, flags: flagCodes(f.flags) });
  return "error" in r ? bad(r.error, r.status) : ok({ no, ...r.data });
}
