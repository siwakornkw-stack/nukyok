import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { aiActor, aiUser, docNo, limitOf, query, vehicleByCode } from "@/lib/ai";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { dec, driverOf } from "@/lib/format";
import { dateRange, isDateKey } from "@/lib/time";
import { openRepair } from "@/lib/actions";
import { REPAIR_STATUS, URGENCY } from "@/components/ui";

export const dynamic = "force-dynamic";

// เลขา AI, GET: repairs (งานซ่อม), newest first.
//   ?no=12  ?status=quote|approval|approved|repairing|done|closed|rejected|cancelled  ?vehicle=CODE
//   ?urgency=urgent|normal|canwait  ?from&to=YYYY-MM-DD (date reported)  ?limit (<= 200)
export async function GET(req: Request) {
  const a = await aiUser(req, ["purchasing", "office", "accounting", "exec"]);
  if ("res" in a) return a.res;
  const q = query(req);
  const where: Prisma.RepairRequestWhereInput = {};
  const no = docNo(q("no"));
  if (no) where.no = no;
  if (Object.hasOwn(REPAIR_STATUS, q("status"))) where.status = q("status");
  if (Object.hasOwn(URGENCY, q("urgency"))) where.urgency = q("urgency");
  if (q("vehicle")) {
    const v = await vehicleByCode(q("vehicle"));
    if (!v) return bad(`ไม่พบรถ ${q("vehicle")}`, 404);
    where.vehicleId = v.id;
  }
  const range = dateRange(isDateKey(q("from")) ? q("from") : "", isDateKey(q("to")) ? q("to") : "");
  if (range) where.createdAt = range;

  const rows = await prisma.repairRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limitOf(q("limit")),
    include: { vehicle: { select: { code: true } }, driver: { select: { name: true } } },
  });
  return ok({
    repairs: rows.map((r) => ({
      no: r.no,
      status: REPAIR_STATUS[r.status][0],
      vehicle: r.vehicle.code,
      driver: driverOf(r),
      urgency: URGENCY[r.urgency]?.[0],
      symptom: r.symptom,
      cause: r.cause || null,
      reportedAt: r.createdAt,
      quoteAmount: dec(r.quoteAmount),
      quoteNote: r.quoteNote || null,
      decidedBy: r.decidedBy,
      decisionNote: r.decisionNote || null,
      costAmount: dec(r.costAmount),
      garage: r.supplierName || null,
      doneAt: r.doneAt,
      closedAt: r.closedAt,
      reopenNote: r.reopenNote || null,
      endNote: r.endNote || null,
    })),
  });
}

// เลขา AI, POST (คนขับ): report a repair. { vehicle: "SY140-01", symptom, cause?, urgency: "urgent" | "normal" |
// "canwait", odometer? }. No photos this way: จัดซื้อ is told it came without any.
export async function POST(req: Request) {
  const a = await aiUser(req, ["driver"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const v = await vehicleByCode(str(b.vehicle, 40));
  if (!v) return bad(`ไม่พบรถ ${str(b.vehicle, 40)}`);
  const odometer = b.odometer === undefined || b.odometer === null || b.odometer === "" ? null : typeof b.odometer === "number" ? b.odometer : Number.NaN;
  const r = await openRepair(
    aiActor(a.user),
    { vehicleId: v.id, symptom: str(b.symptom, 1100), cause: str(b.cause, 1100), odometer, pmRound: "", urgency: str(b.urgency, 20), fromPm: false },
    async () => []
  );
  return "error" in r ? bad(r.error, r.status) : ok({ no: r.data.no, status: REPAIR_STATUS.quote[0] });
}
