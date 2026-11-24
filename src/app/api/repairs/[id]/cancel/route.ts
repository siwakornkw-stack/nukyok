import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { appLink, notifyUsers } from "@/lib/line";

// จัดซื้อ / Office cancel a repair before its cost is saved: quote | approval | approved -> cancelled (a reason is required).
// Who and why are kept (endedBy / endNote), closedAt says when.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing", "office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const note = str((await jsonBody(req)).note, 1000);
  if (!note) return bad("กรอกเหตุผลที่ยกเลิก");

  const r = await prisma.repairRequest.findUnique({ where: { id }, select: { no: true, driverId: true, vehicle: { select: { code: true } } } });
  if (!r) return bad("ไม่พบรายการ", 404);
  const res = await prisma.repairRequest.updateMany({
    where: { id, status: { in: ["quote", "approval", "approved"] } },
    data: { status: "cancelled", closedAt: new Date(), endedBy: u.name, endNote: note },
  });
  if (res.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");

  await notifyUsers([r.driverId], `ยกเลิกงานซ่อม #${r.no} รถ ${r.vehicle.code}: ${note}\n${appLink("/driver/my")}`);
  return ok();
}
