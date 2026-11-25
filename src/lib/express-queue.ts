import "server-only";
import { prisma } from "./db";
import { notifyOfficeGroup, notifyRoles, appLink } from "./line";
import { expressDocs, thMonth, vatClosedThrough, vatFiledThrough } from "./express";
import { bad, str } from "./http";
import { isDateKey } from "./time";

// The agent names its Express company (the folder of EXPRESS_DIR, upper case) in x-express-company on every call.
// With EXPRESS_COMPANY set on the server, another company's agent (a TESTR3 test install) is refused: it can neither
// take real bills, report them written, nor replace the masters and writer flags. Unset = no check.
// Every route the agent calls runs this right after the bearer check.
export function companyRefused(req: Request): Response | null {
  const want = (process.env.EXPRESS_COMPANY ?? "").trim().toUpperCase();
  if (!want) return null;
  const got = str(req.headers.get("x-express-company"), 40).toUpperCase();
  return got === want ? null : bad(`เครื่อง Office ส่งมาจากบริษัท ${got || "(ไม่ระบุ)"} แต่เว็บนี้ลงบัญชีบริษัท ${want}: ตรวจ EXPRESS_DIR บนเครื่อง Office`, 409);
}

const DOC = { fuel: "PK / H3", repair: "PO / RR" };

// What a bill whose VAT month closed while it waited needs from a person instead.
const LATE = {
  fuel: (ym: string) => `เดือนภาษี ${thMonth(ym)} ปิดแล้ว: กด "ลองใหม่" ให้เปิดเฉพาะ PK แล้วคีย์ H3 ใน Express เองโดยลงภาษีซื้อในเดือนที่ยังเปิด`,
  repair: (ym: string) => `เดือนภาษี ${thMonth(ym)} ปิดแล้ว: คีย์ PO / RR ใน Express เองโดยลงภาษีซื้อในเดือนที่ยังเปิด แล้วกด "คีย์เองแล้ว"`,
};

// The office PC's side of the queue, shared by /api/express/fuel (PK + H3) and /repair (PO + RR). A bill that would
// book input VAT (fuel withH3, repair VAT 1 / 2) into a closed VAT month (vatClosedThrough) is not handed out: it
// becomes an error and the Office group hears it.
export async function queuedOrders(kind: "fuel" | "repair") {
  const rows = await prisma.expressOrder.findMany({ where: { kind, status: "queued" }, orderBy: { createdAt: "asc" }, take: 10 });
  const closed = vatClosedThrough(await vatFiledThrough());
  const orders: Record<string, unknown>[] = [];
  const late: string[] = [];
  for (const r of rows) {
    const p = r.payload as Record<string, unknown>;
    const vat = kind === "fuel" ? p.withH3 === true : p.vat === "1" || p.vat === "2";
    const ym = isDateKey(p.date) ? p.date.slice(0, 7) : "";
    if (vat && ym && ym <= closed) {
      const n = await prisma.expressOrder.updateMany({ where: { id: r.id, status: "queued" }, data: { status: "error", error: LATE[kind](ym) } });
      if (n.count) late.push(`บิล ${str(p.invoice, 20) || "-"} (${thMonth(ym)})`);
    } else orders.push({ id: r.id, ...p });
  }
  if (late.length) await notifyOfficeGroup(`ไม่ได้ส่ง ${DOC[kind]} ${late.length} รายการให้เครื่อง Office เพราะเดือนภาษีปิดแล้ว: ${late.join(", ")}\n${appLink("/office/express?f=problem")}`);
  return orders;
}

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
      // (same tax invoice): a person decides, this order is not booked silently. A cancelled order
      // counts too when every number it holds is a reported one: its documents stay live in Express
      // until staff void them there, and the office PC then reports exactly those for this bill (a
      // voided one is never matched again, so ลองใหม่ after voiding writes new documents). Sharing
      // one number only is a cancelled order of another Express company (a test company numbers its
      // documents the same way).
      const holders =
        poNo || h3No
          ? await prisma.expressOrder.findMany({
              where: { id: { not: id }, OR: [...(h3No ? [{ h3No }] : []), ...(poNo ? [{ poNo }] : [])] },
              select: { status: true, poNo: true, h3No: true, r3Status: true, r3No: true },
            })
          : [];
      const twin =
        holders.find((t) => t.status !== "cancelled") ??
        holders.find((t) => (!t.poNo || t.poNo === poNo) && (!t.h3No || t.h3No === h3No));
      if (twin) {
        const docs = [poNo, h3No].filter(Boolean).join(" ");
        // คีย์เองแล้ว gives this order no R3 step: say whether the cancelled order's R3 already holds the bill
        const r3 =
          kind === "repair"
            ? ""
            : twin.r3Status === "done" || twin.r3Status === "manual"
              ? `: R3${twin.r3No ? ` ${twin.r3No}` : ""} ของรายการที่ยกเลิกมีบิลนี้แล้ว`
              : " และทำ R3 ของบิลนี้ใน Express เองด้วย (รายการที่ยกเลิกยังไม่มี R3)";
        const error =
          twin.status === "cancelled"
            ? `เอกสาร ${docs} ใน Express ยังเป็นของรายการที่ยกเลิกแล้ว: ยกเลิกเอกสารนั้นใน Express ก่อน แล้วกด "ลองใหม่" (ถ้าเอกสารนั้นเป็นบิลนี้จริง ตรงทั้งรถและยอด กด "คีย์เองแล้ว" แทน${r3})`
            : `เอกสาร ${docs} ใน Express เป็นของอีกรายการแล้ว (ใบกำกับซ้ำ?) ตรวจแล้วคีย์ใน Express เอง`;
        const n = await prisma.expressOrder.updateMany({ where: { id, status: "queued" }, data: { status: "error", error } });
        if (n.count) await notifyOfficeGroup(`${error}\n${appLink("/office/express")}`);
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
      const error = str(r.error, 1500) || "เขียนลง Express ไม่สำเร็จ";
      await prisma.expressOrder.updateMany({ where: { id, status: "queued" }, data: { status: "error", error } });
      await notifyOfficeGroup(`เปิด ${DOC[kind]} ใน Express ไม่สำเร็จ: ${error}\n${appLink("/office/express")}`);
    }
    // busy: someone is editing a row the write needs in Express; stays queued for the next run.
    applied++;
  }
  return applied;
}
