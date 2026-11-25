import { prisma } from "@/lib/db";
import { companyRefused } from "@/lib/express-queue";
import { appLink, notifyOfficeGroup } from "@/lib/line";
import { bad, bearerOk, jsonBody, ok, str } from "@/lib/http";

export const dynamic = "force-dynamic";

const OPEN = ["queued", "waiting", "force"];

// Office PC R3 queue (Bearer EXPRESS_SYNC_SECRET, x-express-company = its Express company):
//   GET  -> { po: ["PK0000012", ...], force: [...] }  fuel PKs whose H3 goes into the R3 of its date (repairs have no R3);
//           force = an admin confirmed that a same-amount line already in that R3 is another bill
//   POST { results: [{ po, status: done|waiting|busy|error, docNo?, error? }] }  done = written now, or already in Express;
//           a done for an order Office cancelled meanwhile is kept on that order and the Office group told
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  const rows = await prisma.expressOrder.findMany({
    where: { status: "written", poNo: { not: null }, r3Status: { in: OPEN } },
    select: { poNo: true, r3Status: true },
    orderBy: { updatedAt: "asc" },
    take: 50,
  });
  return ok({ po: [...new Set(rows.map((r) => r.poNo!))], force: rows.filter((r) => r.r3Status === "force").map((r) => r.poNo!) });
}

export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  const b = await jsonBody(req);
  const results = Array.isArray(b.results) ? b.results.slice(0, 50) : [];
  let applied = 0;
  for (const x of results) {
    const r = (x ?? {}) as Record<string, unknown>;
    const po = str(r.po, 20), status = str(r.status, 10);
    if (!po || !["done", "waiting", "busy", "error"].includes(status)) continue;
    const where = { poNo: po, status: "written", r3Status: { in: OPEN } };
    if (status === "done") {
      const r3No = str(r.docNo, 20) || null;
      const n = await prisma.expressOrder.updateMany({ where, data: { r3Status: "done", r3No, r3Error: null } });
      // No open step: Office cancelled the order while the office PC was at its R3 (cancel is allowed while the R3
      // waits for staff to key the H3, and the run that finds the H3 writes the R3 at once; the cancel cleared the
      // step). The line is in Express all the same: it is kept on the cancelled order, and staff void it there as
      // they do the order's PK / H3.
      if (!n.count) {
        const late = await prisma.expressOrder.updateMany({ where: { poNo: po, status: "cancelled", r3Status: null }, data: { r3Status: "done", r3No, r3Error: null } });
        if (late.count)
          await notifyOfficeGroup(
            `R3${r3No ? ` ${r3No}` : ""} ใน Express มีบรรทัดของ ${po} แล้ว แต่รายการนี้ถูกยกเลิกไปก่อน: ยกเลิกบรรทัดนั้นใน Express ด้วย เช่นเดียวกับ PK / H3 ของรายการนี้\n${appLink("/office/express")}`
          );
      }
    } else if (status === "waiting") {
      await prisma.expressOrder.updateMany({ where, data: { r3Status: "waiting", r3Error: str(r.error, 1500) || null } });
    } else if (status === "error") {
      const error = str(r.error, 1500) || "เปิด R3 ไม่สำเร็จ";
      const n = await prisma.expressOrder.updateMany({ where, data: { r3Status: "error", r3Error: error } });
      if (n.count) await notifyOfficeGroup(`เปิด R3 ของ ${po} ใน Express ไม่สำเร็จ: ${error}\n${appLink("/office/express")}`);
    }
    applied++;
  }
  return ok({ applied });
}
