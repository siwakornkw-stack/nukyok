import { aiUser, query } from "@/lib/ai";
import { ok } from "@/lib/http";
import { dailySummary, weeklySummary } from "@/lib/summary";

export const dynamic = "force-dynamic";

// เลขา AI: the same summary the Office LINE group gets. ?period=day (today, default) | week (last 7 days)
export async function GET(req: Request) {
  const a = await aiUser(req, ["office", "exec", "accounting"]);
  if ("res" in a) return a.res;
  const week = query(req)("period") === "week";
  return ok({ period: week ? "week" : "day", text: week ? await weeklySummary() : await dailySummary() });
}
