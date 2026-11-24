import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { reviewFuel } from "@/lib/actions";

// Office / ผู้บริหาร: approve (queues the Express PK + H3), return to the filler, or cancel.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["office", "exec"]);
  if ("res" in a) return a.res;
  const { id } = await params;
  const b = await jsonBody(req);
  const r = await reviewFuel(a.user, id, str(b.action, 20), str(b.note, 500));
  return "error" in r ? bad(r.error, r.status) : ok(r.data);
}
