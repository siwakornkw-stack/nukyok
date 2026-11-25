import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { reviewFuel } from "@/lib/actions";

// Office / ผู้บริหาร: approve (queues the Express PK + H3), return to the filler, or cancel.
// approve sends the version the page showed: reviewedAt ("" = never returned) and the codes of the flags shown
// (flagCodes): a fill returned and filled again, or checked again, since then is refused, the page has to be read again.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["office", "exec"]);
  if ("res" in a) return a.res;
  const { id } = await params;
  const b = await jsonBody(req);
  const action = str(b.action, 20);
  const shown = typeof b.reviewedAt === "string" ? str(b.reviewedAt, 40) : null;
  const flags = typeof b.flags === "string" ? str(b.flags, 2000) : null;
  const seen = shown ? new Date(shown) : null;
  // no reviewedAt / flags: a page loaded before these checks existed
  if (action === "approve" && (shown === null || flags === null || (seen !== null && Number.isNaN(seen.getTime()))))
    return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  const r = await reviewFuel(a.user, id, action, str(b.note, 500), { reviewedAt: seen, flags: flags ?? "" });
  return "error" in r ? bad(r.error, r.status) : ok(r.data);
}
