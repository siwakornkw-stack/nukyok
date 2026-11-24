import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, ok } from "@/lib/http";
import { appLink, notifyUsers } from "@/lib/line";

// จัดซื้อ: the garage finished (repairing -> done); the driver is asked to check the vehicle.
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing"]);
  if ("res" in a) return a.res;
  const { id } = await params;

  const r = await prisma.repairRequest.findUnique({ where: { id }, select: { no: true, driverId: true, vehicle: { select: { code: true } } } });
  if (!r) return bad("ไม่พบรายการ", 404);
  const res = await prisma.repairRequest.updateMany({ where: { id, status: "repairing" }, data: { status: "done", doneAt: new Date() } });
  if (res.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");

  await notifyUsers([r.driverId], `ซ่อมเสร็จแล้ว #${r.no} รถ ${r.vehicle.code} กรุณาตรวจรับรถ\n${appLink("/driver/my")}`);
  return ok();
}
