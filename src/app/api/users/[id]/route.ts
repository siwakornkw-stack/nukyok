import { Prisma, type User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bad, formStr, ok, readForm, str } from "@/lib/http";
import { appLink, linkRichMenu, notifyOfficeGroup, pushText } from "@/lib/line";
import { ROLES, ROLE_KEYS, type Role } from "@/lib/roles";
import { apiUser } from "@/lib/session";
import { addUserAudit } from "../log";

const names = (roles: string[]) => roles.map((r) => ROLES[r as Role] ?? r).join(", ") || "-";
const sameRoles = (a: string[], b: string[]) => a.length === b.length && a.every((r) => b.includes(r));

// Office sets a user's roles and status. FormData: roles (repeated), status = active | disabled, and what the page
// showed: was (status), wasRoles ("a,b"), and wasName / wasPhone / wasRequest (the registration the approver read),
// so a page left open cannot undo what another Office did meanwhile, nor approve a registration edited since.
// Any change into active (approval of a pending user, or re-enabling) counts as an approval; disabling keeps the
// roles. Nobody changes their own roles (an Office account could make itself exec / purchasing) or disables
// themselves, so an active Office user always remains: the Serializable transaction re-checks that the acting user
// is still one, and two Office users removing each other at once cannot both win. Every change goes into the user
// audit (/office/users) in the same transaction and is told to the Office group.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const fd = await readForm(req, 100_000);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const posted = fd.getAll("roles").map((v) => str(v, 40));
  const wanted: string[] = ROLE_KEYS.filter((r) => posted.includes(r));
  const status = formStr(fd, "status", 20);
  if (status !== "active" && status !== "disabled") return bad("สถานะไม่ถูกต้อง");
  const id = str((await params).id, 40);
  if (id === u.id && status !== "active") return bad("ปิดบัญชีของตัวเองไม่ได้");
  if (id === u.id && !sameRoles(wanted, u.roles)) return bad("แก้บทบาทของตัวเองไม่ได้ ให้ Office คนอื่นแก้ให้");
  const shown = {
    status: formStr(fd, "was", 20),
    roles: formStr(fd, "wasRoles", 200),
    name: formStr(fd, "wasName", 200),
    phone: formStr(fd, "wasPhone", 100),
    request: formStr(fd, "wasRequest", 40),
  };
  const by = u.name || u.displayName;

  const now = new Date();
  let out: { error: string; status?: number } | { target: User; roles: string[]; text: string };
  try {
    out = await prisma.$transaction(
      async (tx) => {
        const actor = await tx.user.findUnique({ where: { id: u.id } });
        if (actor?.status !== "active" || !actor.roles.includes("office")) return { error: "ไม่มีสิทธิ์ทำรายการนี้", status: 403 };
        const target = await tx.user.findUnique({ where: { id } });
        if (!target) return { error: "ไม่พบผู้ใช้", status: 404 };
        const changed =
          target.status !== shown.status ||
          target.roles.join(",") !== shown.roles ||
          target.name.trim() !== shown.name ||
          target.phone.trim() !== shown.phone ||
          target.requestedRole !== shown.request;
        if (changed) return { error: "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า" };
        const roles = status === "active" ? wanted : target.roles;
        if (status === "active" && !roles.length) return { error: "เลือกบทบาทอย่างน้อย 1 บทบาท" };
        const activating = status === "active" && target.status !== "active";
        if (activating && !target.name) return { error: "ผู้ใช้นี้ยังไม่ได้กรอกข้อมูลที่หน้าลงทะเบียน" };
        const who = target.name || target.displayName;
        const text = activating
          ? `${target.status === "pending" ? "อนุมัติผู้ใช้" : "เปิดใช้งานอีกครั้ง"} ${who} บทบาท ${names(roles)}`
          : status === "disabled" && target.status !== "disabled"
            ? `${target.status === "pending" ? "ไม่อนุมัติผู้ใช้" : "ปิดการใช้งาน"} ${who}`
            : status === "active" && !sameRoles(roles, target.roles)
              ? `เปลี่ยนบทบาท ${who}: ${names(target.roles)} -> ${names(roles)}`
              : "";
        // Disabled or re-enabled: every session signed in before and the เลขา AI key stop for good.
        const revoke = status !== target.status && (status === "disabled" || target.status === "disabled");
        await tx.user.update({
          where: { id },
          data: {
            roles,
            status,
            ...(activating ? { approvedBy: by, approvedAt: now } : {}),
            ...(revoke ? { sessionsAfter: now, aiKeyHash: null, aiKeyAt: null } : {}),
          },
        });
        if (text) await addUserAudit(tx, { at: now.toISOString(), by, text });
        return { target, roles, text };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  } catch (e) {
    // P2002: the audit's first entry written twice at once
    if (e instanceof Prisma.PrismaClientKnownRequestError && (e.code === "P2034" || e.code === "P2002"))
      return bad("มี Office คนอื่นแก้ไขผู้ใช้พร้อมกัน ลองใหม่อีกครั้ง", 409);
    throw e;
  }
  if ("error" in out) return bad(out.error, out.status);

  const { target, roles, text } = out;
  if (!text) return ok();
  if (status === "active") await linkRichMenu(target.lineUserId, roles);
  if (status === "active" && target.status !== "active") await pushText(target.lineUserId, `บัญชีของคุณได้รับการอนุมัติแล้ว บทบาท: ${names(roles)}\n${appLink("/")}`);
  await notifyOfficeGroup(`${text} โดย ${by}\n${appLink("/office/users")}`);
  return ok();
}
