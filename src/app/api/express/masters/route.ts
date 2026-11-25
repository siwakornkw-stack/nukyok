import { saveMasters } from "@/lib/express";
import { companyRefused } from "@/lib/express-queue";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

// Office PC -> master data read from Express (Bearer EXPRESS_SYNC_SECRET, x-express-company = its Express company).
// Body: { fuel: { suppliers, items, writer }, repair: { suppliers, items, departments, writer } }
//   suppliers (at most 1000 per book): [{ code, name, vat, taxId? }]  vat = a usable tax ID in APMAS (13 digits, not
//   a filler such as 0000000000000); taxId only for a Thai juristic person (from 0 then 1-9), never an individual's
//   items: [{ code, desc, depCode, depName, unit, stock, vatClaim }]  vatClaim missing = false
//   departments (repair book only, at most 1000): [{ code, name }]  every Express department (ISTAB 50); an older
//   agent sends none, and the items' departments stand in for them (knownDepartments)
// A writer sent as off turns its queued bills into errors (saveMasters).
export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const refused = companyRefused(req);
  if (refused) return refused;
  const saved = await saveMasters(await jsonBody(req));
  return saved ? ok({ saved }) : bad("masters ไม่ถูกต้อง");
}
