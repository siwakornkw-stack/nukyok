import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { hashAiKey, newAiKey } from "@/lib/ai";

// The signed-in person's own เลขา AI key (/ai): { action: "create" } makes a new one (the old one stops) and
// shows it this once; { action: "revoke" } removes it.
export async function POST(req: Request) {
  const a = await apiUser();
  if ("res" in a) return a.res;
  const action = str((await jsonBody(req)).action, 10);
  if (action === "revoke") {
    await prisma.user.update({ where: { id: a.user.id }, data: { aiKeyHash: null, aiKeyAt: null } });
    return ok({ notice: "ยกเลิกรหัสเลขา AI แล้ว" });
  }
  if (action !== "create") return bad("คำสั่งไม่ถูกต้อง");
  const key = newAiKey();
  await prisma.user.update({ where: { id: a.user.id }, data: { aiKeyHash: hashAiKey(key), aiKeyAt: new Date() } });
  return ok({ key });
}
