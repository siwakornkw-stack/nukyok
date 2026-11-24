import { saveMasters } from "@/lib/express";
import { bad, bearerOk, jsonBody, ok } from "@/lib/http";

// Office PC -> master data read from Express (Bearer EXPRESS_SYNC_SECRET).
// Body: { fuel: { suppliers, items, writer }, repair: { suppliers, items, writer } }
export async function POST(req: Request) {
  if (!bearerOk(req, process.env.EXPRESS_SYNC_SECRET)) return bad("unauthorized", 401);
  const saved = await saveMasters(await jsonBody(req));
  return saved ? ok({ saved }) : bad("masters ไม่ถูกต้อง");
}
