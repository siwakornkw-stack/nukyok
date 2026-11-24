import { prisma } from "@/lib/db";
import { aiUser, query } from "@/lib/ai";
import { bad, ok } from "@/lib/http";
import { bkkDateKey, bkkStart, isDateKey } from "@/lib/time";
import { vehicleCosts } from "@/lib/summary";

export const dynamic = "force-dynamic";

// เลขา AI: cost per vehicle (Dashboard ต้นทุนต่อคัน). ?from=YYYY-MM-DD&to=YYYY-MM-DD, default this month
// up to today; at most 400 days. Approved fuel by fill date, repair cost by the date จัดซื้อ saved it.
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec", "accounting"]);
  if ("res" in a) return a.res;
  const q = query(req);
  const today = bkkDateKey();
  const from = isDateKey(q("from")) ? q("from") : `${today.slice(0, 7)}-01`;
  const to = isDateKey(q("to")) ? q("to") : today;
  const start = bkkStart(from), end = new Date(bkkStart(to).getTime() + 86_400_000);
  if (end <= start || end.getTime() - start.getTime() > 400 * 86_400_000) return bad("ช่วงวันที่ไม่ถูกต้อง (ไม่เกิน 400 วัน)");

  const costs = await vehicleCosts(start, end);
  const vehicles = await prisma.vehicle.findMany({ where: { id: { in: [...costs.keys()] } }, select: { id: true, code: true } });
  const code = new Map(vehicles.map((v) => [v.id, v.code]));
  const rows = [...costs]
    .map(([id, c]) => ({ vehicle: code.get(id) ?? id, fuel: c.fuel, liters: c.liters, repair: c.repair, total: c.fuel + c.repair }))
    .sort((x, y) => y.total - x.total);
  const sum = (k: "fuel" | "liters" | "repair" | "total") => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return ok({ from, to, totals: { fuel: sum("fuel"), liters: sum("liters"), repair: sum("repair"), total: sum("total") }, vehicles: rows });
}
