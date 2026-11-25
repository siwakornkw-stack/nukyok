import { applyResults, companyRefused, queuedOrders } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// Office PC (Bearer EXPRESS_SYNC_SECRET, x-express-company = its Express company):
//   GET  -> { orders: [{ id, supplier, item, dep, date, invoice, amount, vat, job, plate }] }  PO + RR to write
//           (a VAT 1 / 2 bill whose VAT month closed while it waited becomes an error instead)
//   POST { results: [{ id, status: done|busy|error, poNo?, rrNo?, error? }] }
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  return ok({ orders: await queuedOrders("repair") });
}

export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  return ok({ applied: await applyResults("repair", (await jsonBody(req)).results) });
}
