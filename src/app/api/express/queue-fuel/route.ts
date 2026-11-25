import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { queueFuelExpress } from "@/lib/express";
import { dec } from "@/lib/format";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// Office / accounting, for an approved pump fill that was not queued at approval
// (no masters yet, vehicle without an Express item, invoice too long, ...):
//   { id }               queue its PK + H3 for the office PC
//   { id, manual: true } staff keyed it in Express by hand: an order the agent never picks up (status "manual")
export async function POST(req: Request) {
  const a = await apiUser(["office", "accounting"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const b = await jsonBody(req);
  const id = str(b.id, 40);
  const manual = b.manual === true;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const f = await tx.fuelRequest.findFirst({
        where: { id, status: "approved", source: "pump", express: { is: null } },
        include: { vehicle: { select: { expressItem: true, expressDep: true } } },
      });
      if (!f) return null;
      if (manual) {
        await tx.expressOrder.create({
          data: {
            kind: "fuel",
            fuelRequestId: id,
            status: "manual",
            error: `คีย์ใน Express เองแล้ว (โดย ${u.name})`,
            createdBy: u.name,
            payload: { invoice: f.invoice, amount: dec(f.amount) ?? 0 },
          },
        });
        return { manual: true as const };
      }
      return queueFuelExpress(
        tx,
        {
          id,
          source: f.source,
          supplierCode: f.supplierCode,
          invoice: f.invoice,
          liters: dec(f.liters) ?? 0,
          pricePerLiter: dec(f.pricePerLiter) ?? 0,
          amount: dec(f.amount) ?? 0,
          filledAt: f.filledAt ?? new Date(),
          invoiceDate: f.invoiceDate,
          vehicle: f.vehicle,
        },
        u.name
      );
    });
    if (!result) return bad(CHANGED);
    if ("manual" in result) return ok({ manual: true });
    // note: queued with a change the person must act on (a closed VAT month: the PK only, staff key the H3)
    if (result.queued) return ok({ queued: true, ...(result.note ? { notice: result.note } : {}) });
    return ok({ notice: `ยังส่งเข้า Express ไม่ได้: ${result.reason}` });
  } catch (e) {
    // two people acted on it at once: ExpressOrder.fuelRequestId is unique, the other one won
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad(CHANGED);
    throw e;
  }
}
