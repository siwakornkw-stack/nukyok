import { applyResults, queuedOrders } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

export const dynamic = "force-dynamic";

// Office PC (Bearer EXPRESS_SYNC_SECRET):
//   GET  -> { orders: [{ id, withH3, supplier, item, dep, date, invoice, liters, price, amount }] }  PK + H3 to write
//   POST { results: [{ id, status: done|busy|error, pkNo?, h3No?, error? }] }
export async function GET(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  return ok({ orders: await queuedOrders("fuel") });
}

export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  return ok({ applied: await applyResults("fuel", (await jsonBody(req)).results) });
}
