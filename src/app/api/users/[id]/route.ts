import { prisma } from "@/lib/db";
import { bad, formStr, ok, readForm, str } from "@/lib/http";
import { appLink, linkRichMenu, pushText } from "@/lib/line";
import { ROLES, ROLE_KEYS } from "@/lib/roles";
import { apiUser } from "@/lib/session";

// Office sets a user's roles and status. FormData: roles (repeated), status = active | disabled.
// Any change into active (approval of a pending user, or re-enabling) counts as an approval.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const posted = fd.getAll("roles").map((v) => str(v, 40));
  const roles = ROLE_KEYS.filter((r) => posted.includes(r));
  const status = formStr(fd, "status", 20);
  if (status !== "active" && status !== "disabled") return bad("สถานะไม่ถูกต้อง");

  const target = await prisma.user.findUnique({ where: { id: str((await params).id, 40) } });
  if (!target) return bad("ไม่พบผู้ใช้", 404);
  if (target.id === u.id && status !== "active") return bad("ปิดบัญชีของตัวเองไม่ได้");
  if (target.id === u.id && !roles.includes("office")) return bad("เอาบทบาท Office ของตัวเองออกไม่ได้");
  if (status === "active" && !roles.length) return bad("เลือกบทบาทอย่างน้อย 1 บทบาท");
  const activating = status === "active" && target.status !== "active";
  if (activating && !target.name) return bad("ผู้ใช้นี้ยังไม่ได้กรอกข้อมูลที่หน้าลงทะเบียน");

  const r = await prisma.user.updateMany({
    where: { id: target.id, status: target.status },
    data: { roles, status, ...(activating ? { approvedBy: u.name || u.displayName, approvedAt: new Date() } : {}) },
  });
  if (r.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");

  const rolesChanged = roles.length !== target.roles.length || roles.some((x) => !target.roles.includes(x));
  if (activating) {
    await linkRichMenu(target.lineUserId, roles);
    await pushText(target.lineUserId, `บัญชีของคุณได้รับการอนุมัติแล้ว บทบาท: ${roles.map((x) => ROLES[x]).join(", ")}\n${appLink("/")}`);
  } else if (status === "active" && rolesChanged) {
    await linkRichMenu(target.lineUserId, roles);
  }
  return ok();
}
