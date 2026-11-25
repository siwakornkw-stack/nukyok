import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { notifyRoles } from "@/lib/line";

// The driver cancels their own request while it still waits for a filler (คนขับยกเลิกคำขอ).
// Once filled it is Office's to cancel (review route). The fillers were told about it, so they hear it is off.
// A slip already sent means a filler is filling it (likely paid): only Office can cancel it then.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["driver"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const note = str((await jsonBody(req)).note, 500);

  const n = await prisma.fuelRequest.updateMany({
    where: { id, driverId: u.id, status: "waiting", slipPhoto: null },
    data: { status: "cancelled", returnNote: note ? `คนขับยกเลิก: ${note}` : "คนขับยกเลิก", reviewedBy: u.name, reviewedAt: new Date() },
  });
  if (n.count !== 1) {
    const filling = await prisma.fuelRequest.count({ where: { id, driverId: u.id, status: "waiting", slipPhoto: { not: null } } });
    return bad(filling ? "ยกเลิกไม่ได้: คนเติมแนบสลิปแล้ว (เติมไปแล้ว) ติดต่อ Office" : "ยกเลิกไม่ได้: คนเติมบันทึกไปแล้ว หรือรายการถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  }
  const r = await prisma.fuelRequest.findUniqueOrThrow({ where: { id }, select: { no: true, vehicle: { select: { code: true } } } });
  await notifyRoles(["filler"], `คนขับยกเลิกคำขอเติมน้ำมัน #${r.no} รถ ${r.vehicle.code} ไม่ต้องเติม`);
  return ok({ notice: `ยกเลิกคำขอ #${r.no} แล้ว` });
}
