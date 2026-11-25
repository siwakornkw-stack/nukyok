import { prisma } from "@/lib/db";
import { bad, crossSite, formStr, ok, readForm } from "@/lib/http";
import { appLink, notifyOfficeGroup } from "@/lib/line";
import { ROLES, ROLE_KEYS } from "@/lib/roles";
import { currentUser } from "@/lib/session";
import { nameOk } from "./name";

// A pending user (not active yet, so not apiUser) says who they are and which role they need.
export async function POST(req: Request) {
  if (crossSite(req.headers)) return bad("ระบบไม่รับคำขอที่ส่งมาจากเว็บอื่น", 403);
  const u = await currentUser();
  if (!u) return bad("กรุณาเข้าสู่ระบบใหม่", 401);
  if (u.status !== "pending") return bad(u.status === "disabled" ? "บัญชีนี้ถูกปิดการใช้งาน ติดต่อ Office" : "บัญชีนี้ได้รับการอนุมัติแล้ว", 403);
  const fd = await readForm(req, 200_000);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const name = formStr(fd, "name", 200).replace(/\s+/g, " ");
  const phone = formStr(fd, "phone", 100);
  const posted = formStr(fd, "role", 40);
  const role = ROLE_KEYS.find((r) => r === posted);
  if (!nameOk(name)) return bad("กรอกชื่อ-นามสกุล 2-60 ตัวอักษร ใช้ได้เฉพาะตัวอักษร เว้นวรรค และ . - ' ( ) ไม่มีตัวเลขหรือลิงก์ (จุดหน้าอักษรอังกฤษต้องเว้นวรรค เช่น Mr. John)");
  if (phone.length > 20 || !/^[0-9 +-]*$/.test(phone)) return bad("เบอร์โทรใช้ได้เฉพาะตัวเลข เว้นวรรค - และ + ไม่เกิน 20 ตัว");
  if (!role) return bad("เลือกบทบาทที่ต้องการ");
  const data = { name, phone, requestedRole: role };
  // Once per person: only the write that fills the empty name tells the Office group, so edits,
  // a script reposting or many requests fired at once do not reach it again.
  const first = await prisma.user.updateMany({ where: { id: u.id, status: "pending", name: "" }, data });
  if (first.count === 1) await notifyOfficeGroup(`มีผู้ลงทะเบียนใหม่: ${name} ขอบทบาท ${ROLES[role]}\n${appLink("/office/users")}`);
  else {
    const r = await prisma.user.updateMany({ where: { id: u.id, status: "pending" }, data });
    if (r.count !== 1) return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  }
  return ok({ redirect: "/register" });
}
