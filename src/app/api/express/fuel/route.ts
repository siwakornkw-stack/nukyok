import { applyResults, companyRefused, queuedOrders } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// Office PC (Bearer EXPRESS_SYNC_SECRET, x-express-company = its Express company):
//   GET  -> { orders: [{ id, withH3, supplier, item, dep, date, invoice, liters, price, amount, force? }] }  PK + H3 to
//           write (a bill whose VAT month closed while it waited becomes an error instead); force: true = Office
//           confirmed ("ยืนยันว่าไม่ซ้ำ", /api/express/retry) that another H3 / PK of this tax invoice is another bill
//   POST { results: [{ id, status: done|busy|error, pkNo?, h3No?, error? }] }
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  return ok({ orders: await queuedOrders("fuel") });
}

export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  return ok({ applied: await applyResults("fuel", (await jsonBody(req)).results) });
}
