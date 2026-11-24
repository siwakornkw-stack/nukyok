import type { Vehicle } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiUser, query, vehicleByCode } from "@/lib/ai";
import { bad, ok } from "@/lib/http";
import { dec } from "@/lib/format";
import { bkkDateKey, bkkStart } from "@/lib/time";
import { PM_STATE, latestHours, pmState, vehicleCosts } from "@/lib/summary";
import { FUEL_STATUS, REPAIR_STATUS } from "@/components/ui";

export const dynamic = "force-dynamic";

// เลขา AI: vehicles (ข้อมูลรถ / หน้าสินทรัพย์). No ?code = all of them; ?code=SY140-01 = one with its
// latest fuel fills, repairs and this month's cost.
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec", "purchasing", "accounting"]);
  if ("res" in a) return a.res;
  const code = query(req)("code");
  const hours = await latestHours();
  const card = (v: Vehicle) => {
    const h = hours.get(v.id);
    const pm = pmState(v, h);
    return {
      code: v.code,
      model: v.model,
      active: v.active,
      engineHours: h ?? null,
      litersPerHourStandard: dec(v.litersPerHour),
      tankLiters: dec(v.tankLiters),
      service: pm ? { state: PM_STATE[pm.state][0], dueAtHours: pm.due } : null,
    };
  };

  if (!code) {
    const list = await prisma.vehicle.findMany({ orderBy: { code: "asc" } });
    return ok({ vehicles: list.map(card) });
  }
  const v = await vehicleByCode(code);
  if (!v) return bad(`ไม่พบรถ ${code}`, 404);
  const month = bkkDateKey().slice(0, 7);
  const start = bkkStart(`${month}-01`);
  const [fuel, repairs, costs] = await Promise.all([
    prisma.fuelRequest.findMany({ where: { vehicleId: v.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    prisma.repairRequest.findMany({ where: { vehicleId: v.id }, orderBy: { createdAt: "desc" }, take: 10 }),
    vehicleCosts(start, new Date()),
  ]);
  const c = costs.get(v.id) ?? { fuel: 0, liters: 0, repair: 0 };
  return ok({
    vehicle: card(v),
    thisMonth: { month, fuel: c.fuel, liters: c.liters, repair: c.repair, total: c.fuel + c.repair },
    recentFuel: fuel.map((f) => ({ no: f.no, status: FUEL_STATUS[f.status][0], at: f.filledAt ?? f.createdAt, engineHours: dec(f.engineHours), liters: dec(f.liters), amount: dec(f.amount) })),
    recentRepairs: repairs.map((r) => ({ no: r.no, status: REPAIR_STATUS[r.status][0], at: r.createdAt, symptom: r.symptom, cost: dec(r.costAmount) ?? dec(r.quoteAmount) })),
  });
}
