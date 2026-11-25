import { savePrices } from "@/lib/prices";
import { companyRefused } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

// Office PC -> two years of purchase prices read from Express (Bearer EXPRESS_SYNC_SECRET), for เทียบราคา.
// Body: { since, lines: [{ date, doc, sup, item, desc, qty, unit, price, net, vat }], items: { code: name },
//         suppliers: [{ code, name, address, zip, phone, taxId, branch, remark, vat }] }
// Kept as savePrices allows: items purchasing buys, a private person by name only and without service wages
// (5110-05). Staff are left out by the agent: one with purchaseItem sends no staff-type line the web could tell them by.
export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  const saved = await savePrices(await jsonBody(req, 50_000_000)); // larger than the usual 1 MB: nginx allows 100m
  return saved === null ? bad("prices ไม่ถูกต้อง") : ok({ saved });
}
