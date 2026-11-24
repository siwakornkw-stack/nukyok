import { applyResults, queuedOrders } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// Office PC (Bearer EXPRESS_SYNC_SECRET):
//   GET  -> { orders: [{ id, supplier, item, dep, date, invoice, amount, vat, job, plate }] }  PO + RR to write
//   POST { results: [{ id, status: done|busy|error, poNo?, rrNo?, error? }] }
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  return ok({ orders: await queuedOrders("repair") });
}

export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  return ok({ applied: await applyResults("repair", (await jsonBody(req)).results) });
}
