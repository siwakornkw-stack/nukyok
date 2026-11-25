import { prisma } from "@/lib/db";
import { UNTRUSTED, aiUser, filterError, query } from "@/lib/ai";
import { bad, ok } from "@/lib/http";
import { bkkDateKey, dateOnly, hoursBetween } from "@/lib/time";

export const dynamic = "force-dynamic";

// เลขา AI: who clocked in / out on one Bangkok day (รีพอร์ตเข้างาน). ?date=YYYY-MM-DD, default today.
// No GPS: the answer goes to an outside AI service; the map links stay on /office/attendance.
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec"]);
  if ("res" in a) return a.res;
  const invalid = filterError(req, { date: "date" });
  if (invalid) return bad(invalid);
  const date = query(req)("date") || bkkDateKey();
  const rows = await prisma.attendance.findMany({ where: { workDate: dateOnly(date) }, orderBy: { inAt: "asc" }, include: { user: { select: { name: true } } } });
  return ok({
    untrusted: UNTRUSTED,
    date,
    attendance: rows.map((r) => ({
      name: r.user.name,
      in: r.inAt,
      out: r.outAt,
      hours: r.outAt ? Math.round(hoursBetween(r.inAt, r.outAt) * 10) / 10 : null,
    })),
  });
}
