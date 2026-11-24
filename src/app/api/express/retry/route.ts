import { prisma } from "@/lib/db";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { apiUser } from "@/lib/session";

// Office / accounting: put a failed Express step back in its queue.
// { id, force?: true } force = "ยืนยันว่าไม่ซ้ำ" for an R3 held as a possible duplicate.
export async function POST(req: Request) {
  const a = await apiUser(["office", "accounting"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const id = str(b.id, 40);
  const row = await prisma.expressOrder.findUnique({ where: { id } });
  if (!row) return bad("ไม่พบรายการ");
  if (row.status === "error") {
    await prisma.expressOrder.updateMany({ where: { id, status: "error" }, data: { status: "queued", error: null } });
  } else if (row.status === "written" && row.r3Status === "error" && row.poNo) {
    await prisma.expressOrder.updateMany({ where: { id, r3Status: "error" }, data: { r3Status: b.force === true ? "force" : "queued", r3Error: null } });
  } else return bad("รายการนี้ไม่มีขั้นที่ไม่สำเร็จ");
  return ok();
}
