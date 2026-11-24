import { savePrices } from "@/lib/prices";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

// Office PC -> two years of purchase prices read from Express (Bearer EXPRESS_SYNC_SECRET), for เทียบราคา.
// Body: { since, lines: [{ date, doc, sup, item, desc, qty, unit, price, net, vat }], items: { code: name },
//         suppliers: [{ code, name, address, zip, phone, taxId, branch, remark, vat }] }
export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const saved = await savePrices(await jsonBody(req, 50_000_000)); // larger than the usual 1 MB: nginx allows 100m
  return saved === null ? bad("prices ไม่ถูกต้อง") : ok({ saved });
}
