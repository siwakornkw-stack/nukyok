import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { appLink, notifyUsers } from "@/lib/line";

// จัดซื้อ / Office close a finished job the driver cannot check (done -> closed, a reason is required; who and why are kept).
// As with the driver's accept, a closed service job starts the next cycle at the engine hours a filler last checked
// by the time the repair was done, not at close time (which may be days later).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["purchasing", "office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const note = str((await jsonBody(req)).note, 1000);
  if (!note) return bad("กรอกเหตุผลที่ปิดงาน");

  const r = await prisma.repairRequest.findUnique({ where: { id }, select: { no: true, driverId: true, fromPm: true, vehicleId: true, doneAt: true } });
  if (!r) return bad("ไม่พบรายการ", 404);
  const res = await prisma.repairRequest.updateMany({
    where: { id, status: "done" },
    data: { status: "closed", closedAt: new Date(), endedBy: u.name, endNote: note },
  });
  if (res.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  if (r.fromPm) {
    const fill = await prisma.fuelRequest.findFirst({
      where: { vehicleId: r.vehicleId, status: { in: ["filled", "approved"] }, createdAt: { lte: r.doneAt ?? new Date() } },
      orderBy: { createdAt: "desc" },
      select: { engineHours: true },
    });
    if (fill) await prisma.vehicle.update({ where: { id: r.vehicleId }, data: { pmLastHours: fill.engineHours } });
  }

  await notifyUsers([r.driverId], `ปิดงานซ่อม #${r.no} โดย ${u.name}: ${note}\n${appLink("/driver/my")}`);
  return ok();
}
