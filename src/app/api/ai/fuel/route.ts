import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { UNTRUSTED, aiActor, aiUser, docNo, filterError, limitOf, query, vehicleByCode } from "@/lib/ai";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { dec, driverOf } from "@/lib/format";
import { dateRange } from "@/lib/time";
import { requestFuel } from "@/lib/actions";
import { FUEL_STATUS } from "@/components/ui";

export const dynamic = "force-dynamic";

// เลขา AI, GET: fuel requests (ตรวจรายการน้ำมัน), newest first.
//   ?no=12  ?status=waiting|filled|returned|approved|cancelled  ?vehicle=CODE  ?from&to=YYYY-MM-DD (fill date,
//   or the day asked while not filled)  ?flagged=1 (only those the automatic checks flagged)  ?limit (<= 200).
//   A filter that is not valid, or one this list does not take, is refused (400).
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec", "accounting"]);
  if ("res" in a) return a.res;
  const invalid = filterError(req, { no: "no", status: Object.keys(FUEL_STATUS), vehicle: null, from: "date", to: "date", flagged: ["1"], limit: null });
  if (invalid) return bad(invalid);
  const q = query(req);
  const where: Prisma.FuelRequestWhereInput = {};
  const no = docNo(q("no"));
  if (no) where.no = no;
  if (q("status")) where.status = q("status");
  if (q("vehicle")) {
    const v = await vehicleByCode(q("vehicle"));
    if (!v) return bad(`ไม่พบรถ ${q("vehicle")}`, 404);
    where.vehicleId = v.id;
  }
  const range = dateRange(q("from"), q("to"));
  if (range) where.OR = [{ filledAt: range }, { filledAt: null, createdAt: range }];
  if (q("flagged") === "1") where.NOT = { flags: { equals: [] } };

  const rows = await prisma.fuelRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limitOf(q("limit")),
    include: { vehicle: { select: { code: true } }, driver: { select: { name: true } }, filler: { select: { name: true } } },
  });
  return ok({
    untrusted: UNTRUSTED,
    fuel: rows.map((r) => ({
      no: r.no,
      status: FUEL_STATUS[r.status][0],
      vehicle: r.vehicle.code,
      driver: driverOf(r),
      filler: r.filler?.name ?? null,
      engineHours: dec(r.engineHours),
      liters: dec(r.liters),
      pricePerLiter: dec(r.pricePerLiter),
      amount: dec(r.amount),
      source: r.source === "tank" ? "ถังกลาง" : r.source === "pump" ? "ปั๊ม" : null,
      pump: r.supplierName || null,
      invoice: r.invoice || null,
      // date on the tax invoice = the Express bill date (YYYY-MM-DD); null for a tank fill, one not filled yet or an
      // older one (Express then uses the Bangkok date of filledAt)
      invoiceDate: r.invoiceDate?.toISOString().slice(0, 10) ?? null,
      odometer: dec(r.odometer),
      flags: Array.isArray(r.flags) ? r.flags.map((f) => String((f as { text?: unknown })?.text ?? "")) : [],
      askedAt: r.createdAt,
      filledAt: r.filledAt,
      reviewedBy: r.reviewedBy,
      note: r.returnNote || null,
    })),
  });
}

// เลขา AI, POST (คนขับ): ask for fuel. { vehicle: "SY140-01", engineHours: 1234.5 }. No dashboard photo
// this way: the filler still reads the engine hours at the pump.
export async function POST(req: Request) {
  const a = await aiUser(req, ["driver"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const v = await vehicleByCode(str(b.vehicle, 40));
  if (!v) return bad(`ไม่พบรถ ${str(b.vehicle, 40)}`);
  const hours = typeof b.engineHours === "number" ? b.engineHours : Number.NaN;
  const r = await requestFuel(aiActor(a.user), { vehicleId: v.id, hours: Number.isFinite(hours) ? hours : null }, async () => ({ dashPhoto: "", odoPhoto: null }));
  return "error" in r ? bad(r.error, r.status) : ok({ no: r.data.no, status: FUEL_STATUS.waiting[0] });
}
