import { prisma } from "@/lib/db";
import { aiUser, query } from "@/lib/ai";
import { ok } from "@/lib/http";
import { bkkDateKey, dateOnly, hoursBetween, isDateKey } from "@/lib/time";

export const dynamic = "force-dynamic";

// เลขา AI: who clocked in / out on one Bangkok day (รีพอร์ตเข้างาน). ?date=YYYY-MM-DD, default today.
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec"]);
  if ("res" in a) return a.res;
  const d = query(req)("date");
  const date = isDateKey(d) ? d : bkkDateKey();
  const rows = await prisma.attendance.findMany({ where: { workDate: dateOnly(date) }, orderBy: { inAt: "asc" }, include: { user: { select: { name: true } } } });
  return ok({
    date,
    attendance: rows.map((r) => ({
      name: r.user.name,
      in: r.inAt,
      out: r.outAt,
      hours: r.outAt ? Math.round(hoursBetween(r.inAt, r.outAt) * 10) / 10 : null,
      gps: r.inLat !== null && r.inLng !== null ? `${r.inLat},${r.inLng}` : null,
    })),
  });
}
