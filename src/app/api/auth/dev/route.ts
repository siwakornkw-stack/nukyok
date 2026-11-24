import { prisma } from "@/lib/db";
import { devLoginOn } from "@/lib/dev";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { setSession } from "@/lib/session";

// Local testing only (DEV_LOGIN=1 and not production).
export async function POST(req: Request) {
  if (!devLoginOn()) return bad("not found", 404);
  const u = await prisma.user.findUnique({ where: { id: str((await jsonBody(req)).userId, 40) } });
  if (!u || u.status === "disabled") return bad("ไม่พบผู้ใช้");
  await setSession(u.id);
  return ok({ active: u.status === "active" && u.roles.length > 0 });
}
