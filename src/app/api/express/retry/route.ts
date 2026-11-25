import { prisma } from "@/lib/db";
import { fuelOrder, getMasters, repairOrder } from "@/lib/express";
import { dec } from "@/lib/format";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { hasRole } from "@/lib/roles";
import { apiUser } from "@/lib/session";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// Office / accounting: put a failed Express step back in its queue.
//   { id }               a failed PK + H3 / PO + RR: the order is built again from the current fill or repair, its
//                        vehicle and the masters, through the same checks as queueing (a department fixed since, a
//                        closed VAT month, a writer turned off ...), never the payload that failed
//   { id, force: true }  "ยืนยันว่าไม่ซ้ำ" (Office only) on a fuel bill the office PC held as a possible duplicate
//                        (error "อาจซ้ำ": the pump's tax invoice is in another H3 / PK, one invoice split over
//                        vehicles): built again as above, with force: true in the payload. The office PC then writes
//                        it all the same (fuel.mjs, fuel-write.ps1); an H3 of this invoice and amount still counts as
//                        this bill already in Express.
//   { id, force?: true } a failed R3 (not while the fuel writer, and with it the R3, is off: saveMasters); force =
//                        "ยืนยันว่าไม่ซ้ำ" for an R3 held as a possible duplicate
export async function POST(req: Request) {
  const a = await apiUser(["office", "accounting"]);
  if ("res" in a) return a.res;
  const b = await jsonBody(req);
  const id = str(b.id, 40);
  const force = b.force === true;
  const row = await prisma.expressOrder.findUnique({
    where: { id },
    include: {
      fuelRequest: { include: { vehicle: { select: { expressItem: true, expressDep: true } } } },
      repairRequest: { include: { vehicle: { select: { code: true, expressDep: true, expressItem: true } } } },
    },
  });
  if (!row) return bad("ไม่พบรายการ");

  if (row.status === "error") {
    if (force && !hasRole(a.user, "office")) return bad("เฉพาะ Office ยืนยันว่าไม่ซ้ำได้", 403);
    // the page offers force only on a fuel bill held as "อาจซ้ำ": anything else changed since the page was drawn
    if (force && !(row.kind === "fuel" && row.error?.startsWith("อาจซ้ำ"))) return bad(CHANGED);
    const f = row.fuelRequest, r = row.repairRequest;
    const order =
      f?.status === "approved"
        ? await fuelOrder(prisma, {
            id: f.id,
            source: f.source,
            supplierCode: f.supplierCode,
            invoice: f.invoice,
            liters: dec(f.liters) ?? 0,
            pricePerLiter: dec(f.pricePerLiter) ?? 0,
            amount: dec(f.amount) ?? 0,
            filledAt: f.filledAt ?? row.createdAt,
            invoiceDate: f.invoiceDate,
            vehicle: f.vehicle,
          })
        : r?.costedAt
          ? await repairOrder(prisma, {
              id: r.id,
              no: r.no,
              supplierCode: r.supplierCode,
              itemCode: r.itemCode,
              invoice: r.invoice,
              costAmount: dec(r.costAmount) ?? 0,
              vatMode: str((row.payload as Record<string, unknown>).vat, 2), // chosen in the cost form, kept only here
              costedAt: r.costedAt,
              invoiceDate: r.invoiceDate,
              symptom: r.symptom,
              costDetail: r.costDetail,
              vehicle: r.vehicle,
            })
          : { reason: "ไม่พบเติมน้ำมันที่อนุมัติแล้ว / ค่าซ่อมของรายการนี้" };
    if ("reason" in order) return ok({ notice: `ยังส่งเข้า Express ไม่ได้: ${order.reason}` });
    // force: guarded on the very "อาจซ้ำ" error checked above
    const n = await prisma.expressOrder.updateMany({
      where: { id, status: "error", ...(force ? { error: row.error } : {}) },
      data: { status: "queued", error: null, payload: force ? { ...order.payload, force: true } : order.payload },
    });
    if (n.count !== 1) return bad(CHANGED);
    return ok(order.note ? { notice: order.note } : {});
  }

  if (row.status === "written" && row.r3Status === "error" && row.poNo) {
    // The R3 runs with the fuel writer (saveMasters): while it is off nothing would write it.
    if (!(await getMasters())?.fuel.writer) return ok({ notice: "ยังส่ง R3 เข้าคิวไม่ได้: การเปิด PK / H3 / R3 อัตโนมัติปิดอยู่ที่เครื่อง Office" });
    const n = await prisma.expressOrder.updateMany({
      where: { id, status: "written", r3Status: "error" },
      data: { r3Status: force ? "force" : "queued", r3Error: null },
    });
    if (n.count !== 1) return bad(CHANGED);
    return ok();
  }
  return bad("รายการนี้ไม่มีขั้นที่ไม่สำเร็จ");
}
