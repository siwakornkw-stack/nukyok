import "server-only";
import { prisma } from "./db";
import { baht, dec, num } from "./format";
import { bkkDateKey, bkkStart, dateOnly, thDate } from "./time";
import { REPAIR_STATUS, type Tone } from "@/components/ui";

// Vehicle figures shared by the vehicle / cost pages, the CSV export and the cron jobs.

// A repair cost counts once จัดซื้อ has saved it and the job went ahead.
export const COSTED = ["repairing", "done", "closed"];

// Latest engine hours per vehicle: the reading on its most recent fuel request (cancelled ones left out),
// not the highest, so a mistyped high reading is replaced by the next one.
export async function latestHours(): Promise<Map<string, number>> {
  const rows = await prisma.$queryRaw<{ vehicleId: string; engineHours: { toString(): string } }[]>`
    SELECT DISTINCT ON ("vehicleId") "vehicleId", "engineHours" FROM "FuelRequest"
    WHERE "status" <> 'cancelled' ORDER BY "vehicleId", "createdAt" DESC`;
  return new Map(rows.map((r) => [r.vehicleId, dec(r.engineHours) ?? 0]));
}

export const PM_STATE: Record<string, [string, Tone]> = {
  over: ["เลยรอบ", "red"],
  near: ["ใกล้รอบ", "orange"],
  ok: ["ปกติ", "green"],
};

// Service (เช็คระยะ) is due at pmLastHours + pmEveryHours; "near" within PM_WARN_HOURS of it.
// null when the vehicle has no interval or no engine hours yet.
export function pmState(v: { pmEveryHours: number | null; pmLastHours: { toString(): string } | null }, hours: number | undefined) {
  if (!v.pmEveryHours || hours === undefined) return null;
  const due = (dec(v.pmLastHours) ?? 0) + v.pmEveryHours;
  const warn = Number(process.env.PM_WARN_HOURS || 50);
  return { due, state: hours >= due ? "over" : hours >= due - warn ? "near" : "ok" } as const;
}

export type Cost = { fuel: number; liters: number; repair: number };

// Cost per vehicle in [start, end): approved fuel by fill time, repair cost by the time it was saved.
export async function vehicleCosts(start: Date, end: Date): Promise<Map<string, Cost>> {
  const [fuel, repair] = await Promise.all([
    prisma.fuelRequest.groupBy({
      by: ["vehicleId"],
      where: { status: "approved", filledAt: { gte: start, lt: end } },
      _sum: { amount: true, liters: true },
    }),
    prisma.repairRequest.groupBy({
      by: ["vehicleId"],
      where: { status: { in: COSTED }, costedAt: { gte: start, lt: end } },
      _sum: { costAmount: true },
    }),
  ]);
  const m = new Map<string, Cost>();
  const get = (id: string) => {
    let c = m.get(id);
    if (!c) m.set(id, (c = { fuel: 0, liters: 0, repair: 0 }));
    return c;
  };
  for (const f of fuel) Object.assign(get(f.vehicleId), { fuel: dec(f._sum.amount) ?? 0, liters: dec(f._sum.liters) ?? 0 });
  for (const r of repair) get(r.vehicleId).repair = dec(r._sum.costAmount) ?? 0;
  return m;
}

// Daily LINE summary for the Office group (today, Bangkok).
export async function dailySummary(now = new Date()): Promise<string> {
  const key = bkkDateKey(now);
  const start = bkkStart(key);
  const day = dateOnly(key);
  const [fuel, toReview, waiting, opened, closed, open, cost, came, notOut, expressErr] = await Promise.all([
    prisma.fuelRequest.aggregate({
      where: { status: { in: ["filled", "approved"] }, filledAt: { gte: start } },
      _count: true,
      _sum: { liters: true, amount: true },
    }),
    prisma.fuelRequest.findMany({ where: { status: "filled" }, select: { flags: true } }),
    prisma.fuelRequest.count({ where: { status: "waiting" } }),
    prisma.repairRequest.count({ where: { createdAt: { gte: start } } }),
    prisma.repairRequest.count({ where: { status: "closed", closedAt: { gte: start } } }),
    prisma.repairRequest.groupBy({ by: ["status"], where: { status: { notIn: ["closed", "rejected", "cancelled"] } }, _count: true }),
    prisma.repairRequest.aggregate({ where: { status: { in: COSTED }, costedAt: { gte: start } }, _sum: { costAmount: true } }),
    prisma.attendance.count({ where: { workDate: day } }),
    prisma.attendance.count({ where: { workDate: day, outAt: null } }),
    prisma.expressOrder.count({ where: { OR: [{ status: "error" }, { r3Status: "error" }] } }),
  ]);
  const flagged = toReview.filter((f) => Array.isArray(f.flags) && f.flags.length > 0).length;
  const openTotal = open.reduce((s, g) => s + g._count, 0);
  const byStatus = Object.keys(REPAIR_STATUS).flatMap((s) => {
    const g = open.find((x) => x.status === s);
    return g ? [`${REPAIR_STATUS[s][0]} ${g._count}`] : [];
  });
  return [
    `สรุปประจำวัน ${thDate(now)}`,
    `เติมน้ำมัน ${fuel._count} ครั้ง ${num(fuel._sum.liters ?? 0)} ลิตร ${baht(fuel._sum.amount ?? 0)} บาท`,
    `ผิดปกติรอตรวจ ${flagged} / รอเติม ${waiting}`,
    `แจ้งซ่อมใหม่ ${opened} / ปิดงาน ${closed}`,
    `งานซ่อมค้างอยู่ ${openTotal}${byStatus.length ? ` (${byStatus.join(", ")})` : ""}`,
    `ค่าซ่อมวันนี้ ${baht(cost._sum.costAmount ?? 0)} บาท`,
    `เข้างาน ${came} คน / ยังไม่ออกงาน ${notOut}`,
    `Express ไม่สำเร็จ ${expressErr}`,
  ].join("\n");
}

// Weekly LINE summary: the 7 Bangkok days before today, totals and the 10 costliest vehicles.
export async function weeklySummary(now = new Date()): Promise<string> {
  const end = bkkStart(bkkDateKey(now));
  const start = bkkStart(bkkDateKey(new Date(now.getTime() - 7 * 86_400_000)));
  const costs = await vehicleCosts(start, end);
  const vehicles = await prisma.vehicle.findMany({ where: { id: { in: [...costs.keys()] } }, select: { id: true, code: true } });
  const code = new Map(vehicles.map((v) => [v.id, v.code]));
  const rows = [...costs].map(([id, c]) => ({ code: code.get(id) ?? id, ...c, total: c.fuel + c.repair }));
  const sum = (k: keyof Cost) => rows.reduce((s, r) => s + r[k], 0);
  const top = rows.filter((r) => r.total > 0).sort((a, b) => b.total - a.total).slice(0, 10);
  return [
    `สรุปประจำสัปดาห์ ${thDate(start)} - ${thDate(new Date(end.getTime() - 1))}`,
    `น้ำมัน ${baht(sum("fuel"))} บาท (${num(sum("liters"))} ลิตร)`,
    `ค่าซ่อม ${baht(sum("repair"))} บาท`,
    `รวม ${baht(sum("fuel") + sum("repair"))} บาท`,
    ...(top.length ? ["ต้นทุนสูงสุด 10 คัน (บาท):", ...top.map((r, i) => `${i + 1}. ${r.code} ${baht(r.total)} (น้ำมัน ${baht(r.fuel)} ซ่อม ${baht(r.repair)})`)] : []),
  ].join("\n");
}
