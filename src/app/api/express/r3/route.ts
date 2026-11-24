import { prisma } from "@/lib/db";
import { appLink, notifyOfficeGroup } from "@/lib/line";
import { bad, bearerOk, jsonBody, ok, str } from "@/lib/http";

export const dynamic = "force-dynamic";

const OPEN = ["queued", "waiting", "force"];

// Office PC R3 queue (Bearer EXPRESS_SYNC_SECRET):
//   GET  -> { po: ["PK0000012", ...], force: [...] }  fuel PKs whose H3 goes into the R3 of its date (repairs have no R3);
//           force = an admin confirmed that a same-amount line already in that R3 is another bill
//   POST { results: [{ po, status: done|waiting|busy|error, docNo?, error? }] }
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
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
  const b = await jsonBody(req);
  const results = Array.isArray(b.results) ? b.results.slice(0, 50) : [];
  let applied = 0;
  for (const x of results) {
    const r = (x ?? {}) as Record<string, unknown>;
    const po = str(r.po, 20), status = str(r.status, 10);
    if (!po || !["done", "waiting", "busy", "error"].includes(status)) continue;
    const where = { poNo: po, status: "written", r3Status: { in: OPEN } };
    if (status === "done") {
      await prisma.expressOrder.updateMany({ where, data: { r3Status: "done", r3No: str(r.docNo, 20) || null, r3Error: null } });
    } else if (status === "waiting") {
      await prisma.expressOrder.updateMany({ where, data: { r3Status: "waiting", r3Error: str(r.error) || null } });
    } else if (status === "error") {
      const error = str(r.error) || "เปิด R3 ไม่สำเร็จ";
      const n = await prisma.expressOrder.updateMany({ where, data: { r3Status: "error", r3Error: error } });
      if (n.count) await notifyOfficeGroup(`เปิด R3 ของ ${po} ใน Express ไม่สำเร็จ: ${error}\n${appLink("/office/express")}`);
    }
    applied++;
  }
  return ok({ applied });
}
