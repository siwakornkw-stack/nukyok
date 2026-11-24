import "server-only";
import { prisma } from "./db";
import { notifyOfficeGroup, notifyRoles, appLink } from "./line";
import { expressDocs } from "./express";
import { str } from "./http";

// The office PC's side of the queue, shared by /api/express/fuel (PK + H3) and /repair (PO + RR).
export async function queuedOrders(kind: "fuel" | "repair") {
  const rows = await prisma.expressOrder.findMany({ where: { kind, status: "queued" }, orderBy: { createdAt: "asc" }, take: 10 });
  return rows.map((r) => ({ id: r.id, ...(r.payload as Record<string, unknown>) }));
}

const DOC = { fuel: "PK / H3", repair: "PO / RR" };

// results: [{ id, status: done|busy|error, pkNo + h3No (fuel) | poNo + rrNo (repair), error }]
// A repair's RR number is kept in the h3No column.
export async function applyResults(kind: "fuel" | "repair", raw: unknown) {
  const results = Array.isArray(raw) ? raw.slice(0, 50) : [];
  let applied = 0;
  for (const x of results) {
    const r = (x ?? {}) as Record<string, unknown>;
    const id = str(r.id, 40), status = str(r.status, 10);
    if (!id || !["done", "busy", "error"].includes(status)) continue;
    const row = await prisma.expressOrder.findFirst({ where: { id, kind, status: "queued" } });
    if (!row) continue;
    if (status === "done") {
      const poNo = str(kind === "fuel" ? r.pkNo : r.poNo, 20) || null;
      const h3No = str(kind === "fuel" ? r.h3No : r.rrNo, 20) || null;
      // "Already in Express" pointing at another order's document = the same bill entered twice
      // (same tax invoice): a person decides, this order is not booked silently.
      const twin =
        poNo || h3No
          ? await prisma.expressOrder.findFirst({ where: { id: { not: id }, OR: [...(h3No ? [{ h3No }] : []), ...(poNo ? [{ poNo }] : [])] }, select: { id: true } })
          : null;
      if (twin) {
        const error = `เอกสาร ${[poNo, h3No].filter(Boolean).join(" ")} ใน Express เป็นของอีกรายการแล้ว (ใบกำกับซ้ำ?) ตรวจแล้วคีย์ใน Express เอง`;
        await prisma.expressOrder.updateMany({ where: { id, status: "queued" }, data: { status: "error", error } });
        await notifyOfficeGroup(`${error}\n${appLink("/office/express")}`);
        applied++;
        continue;
      }
      await prisma.expressOrder.updateMany({
        where: { id, status: "queued" },
        data: {
          status: "written",
          poNo,
          h3No,
          error: null,
          // Fuel: the R3 is found through the H3 that names this PK; without one a person does it.
          // Repair: an RR is a credit purchase, it has no R3.
          ...(kind === "repair"
            ? { r3Status: null, r3Error: null }
            : poNo
              ? { r3Status: "queued", r3Error: null }
              : { r3Status: null, r3Error: "H3 ใน Express ไม่ได้อ้างถึงใบสั่งซื้อ: ทำ R3 ใน Express เอง" }),
        },
      });
      // a repair's PO + RR are now in Express: exec and accounting hear it once (flowchart)
      const o = kind === "repair" ? await prisma.expressOrder.findFirst({ where: { id, status: "written" }, include: { repairRequest: { select: { id: true, no: true, vehicle: { select: { code: true } } } } } }) : null;
      if (o?.repairRequest) {
        const rr = o.repairRequest;
        const msg = `เปิด PO / RR ค่าซ่อม #${rr.no} รถ ${rr.vehicle.code} ใน Express แล้ว: ${expressDocs(o)}
`;
        await notifyRoles(["exec"], msg + appLink(`/exec/repairs/${rr.id}`));
        await notifyRoles(["accounting"], msg + appLink(`/purchasing/repairs/${rr.id}`));
      }
    } else if (status === "error") {
      const error = str(r.error) || "เขียนลง Express ไม่สำเร็จ";
      await prisma.expressOrder.updateMany({ where: { id, status: "queued" }, data: { status: "error", error } });
      await notifyOfficeGroup(`เปิด ${DOC[kind]} ใน Express ไม่สำเร็จ: ${error}\n${appLink("/office/express")}`);
    }
    // busy: someone is editing a row the write needs in Express; stays queued for the next run.
    applied++;
  }
  return applied;
}
