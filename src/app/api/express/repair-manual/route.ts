import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { dec } from "@/lib/format";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// Office / accounting: a costed repair that has no Express order (not queued when the cost was saved) was keyed in
// Express by hand. { id } (the repair) -> an order the agent never picks up (status "manual"), so the repair leaves
// the not-sent list of /office/express. Sending it instead is done from the repair page (/api/repairs/<id>/express).
export async function POST(req: Request) {
  const a = await apiUser(["office", "accounting"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const id = str((await jsonBody(req)).id, 40);
  try {
    const done = await prisma.$transaction(async (tx) => {
      const r = await tx.repairRequest.findFirst({ where: { id, costedAt: { not: null }, express: { is: null } }, select: { invoice: true, costAmount: true } });
      if (!r) return false;
      await tx.expressOrder.create({
        data: {
          kind: "repair",
          repairRequestId: id,
          status: "manual",
          error: `คีย์ใน Express เองแล้ว (โดย ${u.name})`,
          createdBy: u.name,
          payload: { invoice: r.invoice, amount: dec(r.costAmount) ?? 0 },
        },
      });
      return true;
    });
    return done ? ok({ manual: true }) : bad(CHANGED);
  } catch (e) {
    // two people acted on it at once: ExpressOrder.repairRequestId is unique, the other one won
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad(CHANGED);
    throw e;
  }
}
