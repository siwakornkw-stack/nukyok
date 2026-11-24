import { aiUser } from "@/lib/ai";
import { ok } from "@/lib/http";
import { ROLES, isRole } from "@/lib/roles";

export const dynamic = "force-dynamic";

// เลขา AI: whose key this is and which roles it acts with.
export async function GET(req: Request) {
  const a = await aiUser(req);
  if ("res" in a) return a.res;
  return ok({ name: a.user.name, roles: a.user.roles.filter(isRole).map((r) => ({ key: r, label: ROLES[r] })) });
}
