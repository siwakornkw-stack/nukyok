import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { decideRepair } from "@/lib/actions";

// ผู้บริหาร decides on the quotation: approval -> approved | rejected (a reason is required to reject).
// quotedAt names the quotation the executive saw, so a page opened before a new quotation cannot decide on it.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["exec"]);
  if ("res" in a) return a.res;
  const { id } = await params;
  const b = await jsonBody(req);
  const quotedAt = new Date(str(b.quotedAt, 40));
  if (typeof b.approve !== "boolean") return bad("ข้อมูลไม่ถูกต้อง");
  // no quotedAt: a page loaded before this check existed
  if (Number.isNaN(quotedAt.getTime())) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  const r = await decideRepair(a.user, id, b.approve, str(b.note, 1000), quotedAt);
  return "error" in r ? bad(r.error, r.status) : ok(r.data);
}
