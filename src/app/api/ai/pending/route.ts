import { prisma } from "@/lib/db";
import { aiUser } from "@/lib/ai";
import { ok } from "@/lib/http";
import { dec } from "@/lib/format";
import { ROLES, hasRole } from "@/lib/roles";
import { FUEL_STATUS, REPAIR_STATUS, URGENCY } from "@/components/ui";

export const dynamic = "force-dynamic";

const flagTexts = (f: unknown) => (Array.isArray(f) ? f.map((x) => String((x as { text?: unknown })?.text ?? "")) : []);

// เลขา AI: what waits for this person, by their roles (the same lists their pages show first).
export async function GET(req: Request) {
  const a = await aiUser(req);
  if ("res" in a) return a.res;
  const u = a.user;
  const out: Record<string, unknown> = {};
  const vehicle = { select: { code: true } } as const;

  if (hasRole(u, "filler")) {
    const rows = await prisma.fuelRequest.findMany({ where: { status: { in: ["waiting", "returned"] } }, orderBy: { createdAt: "asc" }, take: 50, include: { vehicle } });
    out.fuelToFill = rows.map((r) => ({ no: r.no, status: FUEL_STATUS[r.status][0], vehicle: r.vehicle.code, engineHours: dec(r.engineHours), askedAt: r.createdAt, returnNote: r.returnNote || undefined }));
  }
  if (hasRole(u, "office", "exec")) {
    const rows = await prisma.fuelRequest.findMany({ where: { status: "filled" }, orderBy: { filledAt: "asc" }, take: 50, include: { vehicle } });
    out.fuelToReview = rows
      .map((r) => ({ no: r.no, vehicle: r.vehicle.code, liters: dec(r.liters), amount: dec(r.amount), source: r.source, filledAt: r.filledAt, flags: flagTexts(r.flags) }))
      .sort((x, y) => Number(y.flags.length > 0) - Number(x.flags.length > 0));
  }
  if (hasRole(u, "exec")) {
    const rows = await prisma.repairRequest.findMany({ where: { status: "approval" }, orderBy: { quotedAt: "asc" }, take: 50, include: { vehicle } });
    out.repairsToApprove = rows.map((r) => ({ no: r.no, vehicle: r.vehicle.code, urgency: URGENCY[r.urgency]?.[0], symptom: r.symptom, cause: r.cause, quoteAmount: dec(r.quoteAmount), quoteNote: r.quoteNote }));
  }
  if (hasRole(u, "purchasing")) {
    const rows = await prisma.repairRequest.findMany({ where: { status: { in: ["quote", "approved", "repairing"] } }, orderBy: { createdAt: "asc" }, take: 50, include: { vehicle } });
    out.repairsForPurchasing = rows.map((r) => ({ no: r.no, status: REPAIR_STATUS[r.status][0], vehicle: r.vehicle.code, urgency: URGENCY[r.urgency]?.[0], symptom: r.symptom, reopenNote: r.reopenNote || undefined }));
  }
  if (hasRole(u, "driver")) {
    const [repairs, fuel] = await Promise.all([
      prisma.repairRequest.findMany({ where: { driverId: u.id, status: "done" }, include: { vehicle } }),
      prisma.fuelRequest.findMany({ where: { driverId: u.id, status: "waiting" }, include: { vehicle } }),
    ]);
    out.myRepairsToAccept = repairs.map((r) => ({ no: r.no, vehicle: r.vehicle.code, symptom: r.symptom, note: "ตรวจรับรถในแอป (/driver/my)" }));
    out.myFuelWaiting = fuel.map((r) => ({ no: r.no, vehicle: r.vehicle.code, askedAt: r.createdAt }));
  }
  if (hasRole(u, "office")) {
    const rows = await prisma.user.findMany({ where: { status: "pending" }, orderBy: { createdAt: "asc" }, take: 50 });
    out.usersToApprove = rows.map((x) => ({ name: x.name, requestedRole: ROLES[x.requestedRole as keyof typeof ROLES] ?? x.requestedRole, at: x.createdAt }));
  }
  if (hasRole(u, "office", "accounting")) {
    out.expressProblems = await prisma.expressOrder.count({ where: { OR: [{ status: "error" }, { r3Status: "error" }] } });
  }
  return ok(out);
}
