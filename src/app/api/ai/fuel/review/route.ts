import { prisma } from "@/lib/db";
import { aiActor, aiUser, docNo } from "@/lib/ai";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { reviewFuel } from "@/lib/actions";

// เลขา AI (Office / ผู้บริหาร): { no: 12, action: "approve" | "return" | "cancel", note } on a filled request.
// approve queues its Express PK / H3 / R3; return sends it back to the filler; return and cancel need a note.
export async function POST(req: Request) {
  const a = await aiUser(req, ["office", "exec"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const no = docNo(b.no);
  const f = no ? await prisma.fuelRequest.findUnique({ where: { no }, select: { id: true } }) : null;
  if (!f) return bad(`ไม่พบคำขอเติมน้ำมัน #${str(b.no, 20)}`, 404);
  const r = await reviewFuel(aiActor(a.user), f.id, str(b.action, 20), str(b.note, 500));
  return "error" in r ? bad(r.error, r.status) : ok({ no, ...r.data });
}
