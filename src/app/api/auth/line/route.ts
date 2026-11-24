import { prisma } from "@/lib/db";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { verifyIdToken } from "@/lib/line";
import { setSession } from "@/lib/session";

// LIFF ID token -> session. A LINE user seen for the first time gets a pending
// account (they fill in /register, Office approves). ADMIN_LINE_USER_IDS are
// made active Office users at once, so the first Office can approve the rest.
export async function POST(req: Request) {
  const b = await jsonBody(req);
  const who = await verifyIdToken(str(b.idToken, 4000));
  if (!who) return bad("ยืนยันตัวตนกับ LINE ไม่สำเร็จ", 401);
  const admins = (process.env.ADMIN_LINE_USER_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const isAdmin = admins.includes(who.sub);
  const u = await prisma.user.upsert({
    where: { lineUserId: who.sub },
    update: { displayName: who.name },
    create: {
      lineUserId: who.sub,
      displayName: who.name,
      name: isAdmin ? who.name : "",
      roles: isAdmin ? ["office"] : [],
      status: isAdmin ? "active" : "pending",
      ...(isAdmin ? { approvedBy: "ADMIN_LINE_USER_IDS", approvedAt: new Date() } : {}),
    },
  });
  // also an admin whose row was made (pending) before ADMIN_LINE_USER_IDS was set
  if (isAdmin && u.status === "pending") {
    const roles = [...new Set([...u.roles, "office"])];
    await prisma.user.update({
      where: { id: u.id },
      data: { status: "active", roles, name: u.name || who.name, approvedBy: "ADMIN_LINE_USER_IDS", approvedAt: new Date() },
    });
    Object.assign(u, { status: "active", roles });
  }
  if (u.status === "disabled") return bad("บัญชีนี้ถูกปิดการใช้งาน ติดต่อ Office", 403);
  await setSession(u.id);
  return ok({ active: u.status === "active" && u.roles.length > 0 });
}
