import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { appLink, notifyRoles } from "@/lib/line";

// The driver who reported it checks the repaired vehicle: pass -> closed, fail -> back to repairing.
// A closed service job (opened from the service-due reminder) starts the next cycle at the engine hours a filler
// last checked by the time the repair was done, not at accept time (which may be days later).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["driver"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const b = await jsonBody(req);
  if (typeof b.pass !== "boolean") return bad("ข้อมูลไม่ถูกต้อง");
  const note = str(b.note, 1000);
  if (!b.pass && !note) return bad("กรอกเหตุผลที่ซ่อมไม่เรียบร้อย");

  const r = await prisma.repairRequest.findUnique({
    where: { id },
    select: { no: true, driverId: true, fromPm: true, vehicleId: true, doneAt: true, vehicle: { select: { code: true } } },
  });
  if (!r || r.driverId !== u.id) return bad("ไม่พบรายการ", 404);
  const where = { id, driverId: u.id, status: "done" };
  const res = b.pass
    ? await prisma.repairRequest.updateMany({ where, data: { status: "closed", closedAt: new Date() } })
    : await prisma.repairRequest.updateMany({ where, data: { status: "repairing", reopenCount: { increment: 1 }, reopenNote: note } });
  if (res.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  if (b.pass && r.fromPm) {
    const fill = await prisma.fuelRequest.findFirst({
      where: { vehicleId: r.vehicleId, status: { in: ["filled", "approved"] }, createdAt: { lte: r.doneAt ?? new Date() } },
      orderBy: { createdAt: "desc" },
      select: { engineHours: true },
    });
    if (fill) await prisma.vehicle.update({ where: { id: r.vehicleId }, data: { pmLastHours: fill.engineHours } });
  }

  const link = appLink(`/purchasing/repairs/${id}`);
  if (b.pass) await notifyRoles(["purchasing"], `ปิดงานซ่อม #${r.no} รถ ${r.vehicle.code} (คนขับตรวจรับแล้ว)\n${link}`);
  else await notifyRoles(["purchasing"], `ซ่อมไม่เรียบร้อย #${r.no} รถ ${r.vehicle.code}: ${note}\n${link}`);
  return ok();
}
