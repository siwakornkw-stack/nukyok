import { UNTRUSTED, aiUser, filterError, query } from "@/lib/ai";
import { bad, ok } from "@/lib/http";
import { dailySummary, weeklySummary } from "@/lib/summary";

export const dynamic = "force-dynamic";

// เลขา AI: the same summary the Office LINE group gets. ?period=day (today, default) | week (last 7 days)
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec", "accounting"]);
  if ("res" in a) return a.res;
  const invalid = filterError(req, { period: ["day", "week"] });
  if (invalid) return bad(invalid);
  const week = query(req)("period") === "week";
  return ok({ untrusted: UNTRUSTED, period: week ? "week" : "day", text: week ? await weeklySummary() : await dailySummary() });
}
