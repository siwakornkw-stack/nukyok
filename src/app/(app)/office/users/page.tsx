import { ApiForm } from "@/components/forms";
import { Card, Empty, Info, PageHeader, Table } from "@/components/ui";
import { USER_AUDIT_KEY, readUserAudit } from "@/app/api/users/log";
import { prisma } from "@/lib/db";
import { ROLES, ROLE_KEYS, type Role } from "@/lib/roles";
import { requirePage } from "@/lib/session";
import { thDateTime } from "@/lib/time";

const GROUPS = [
  ["pending", "รออนุมัติ"],
  ["active", "ใช้งานอยู่"],
  ["disabled", "ปิดการใช้งาน"],
] as const;

const roleLabel = (r: string) => ROLES[r as Role] ?? r;

// Each form posts the full wanted state (roles + status) to /api/users/<id>, with the status, roles and registration
// it shows (was / wasRoles / wasName / wasPhone / wasRequest): the route refuses when the user changed meanwhile. A
// pending user's request ticks only คนขับ / คนเติม; any other role the approver ticks by hand. Your own roles only
// another Office sets. Below: who approved, disabled or changed whose roles (the route's audit).
export default async function UsersPage() {
  const u = await requirePage(["office"]);
  const [users, audit] = await Promise.all([
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.appSetting.findUnique({ where: { key: USER_AUDIT_KEY } }).then((r) => readUserAudit(r?.value)),
  ]);
  return (
    <>
      <PageHeader title="ผู้ใช้ / อนุมัติบทบาท" back="/" />
      {!users.length && <Empty>ยังไม่มีผู้ใช้</Empty>}
      {GROUPS.map(([status, title]) => {
        const list = users.filter((x) => x.status === status);
        if (!list.length) return null;
        return (
          <Card key={status} title={`${title} (${list.length})`}>
            <div className="divide-y divide-line">
              {list.map((x) => {
                const shown = (
                  <>
                    <input type="hidden" name="was" value={x.status} />
                    <input type="hidden" name="wasRoles" value={x.roles.join(",")} />
                    <input type="hidden" name="wasName" value={x.name} />
                    <input type="hidden" name="wasPhone" value={x.phone} />
                    <input type="hidden" name="wasRequest" value={x.requestedRole} />
                  </>
                );
                return (
                  <div key={x.id} className="py-4 first:pt-0 last:pb-0">
                    <p className="mb-2 font-semibold">
                      {x.name || "(ยังไม่ได้กรอกชื่อ)"}
                      {x.id === u.id && <span className="ml-2 text-sm font-normal text-muted">(คุณ)</span>}
                    </p>
                    <Info
                      rows={[
                        ["ชื่อ LINE", x.displayName || "-"],
                        ["เบอร์โทร", x.phone || "-"],
                        ["ขอบทบาท", x.requestedRole ? roleLabel(x.requestedRole) : "-"],
                        ["บทบาท", x.roles.map(roleLabel).join(", ") || "-"],
                        ["อนุมัติโดย", x.approvedBy ? `${x.approvedBy} (${thDateTime(x.approvedAt)})` : "-"],
                        ["รหัสเลขา AI", x.aiKeyAt ? `มี (สร้าง ${thDateTime(x.aiKeyAt)})` : "-"],
                      ]}
                    />
                    {x.status === "pending" && !x.name ? (
                      <p className="mt-3 text-sm text-muted">รอผู้ใช้กรอกข้อมูลที่หน้าลงทะเบียน</p>
                    ) : x.id === u.id ? (
                      <p className="mt-3 text-sm text-muted">บทบาทของตัวเองแก้ไม่ได้ ให้ Office คนอื่นแก้ให้</p>
                    ) : (
                      <>
                        <ApiForm
                          action={`/api/users/${x.id}`}
                          submit={x.status === "pending" ? "อนุมัติ" : x.status === "active" ? "บันทึกบทบาท" : "เปิดใช้งานอีกครั้ง"}
                          className="mt-3"
                        >
                          <input type="hidden" name="status" value="active" />
                          {shown}
                          <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {ROLE_KEYS.map((r) => (
                              <label key={r} className="flex items-center gap-2 rounded-xl border border-line bg-card transition has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:ring-1 has-[:checked]:ring-brand px-3 py-2.5">
                                <input
                                  type="checkbox"
                                  name="roles"
                                  value={r}
                                  defaultChecked={x.roles.includes(r) || (x.status === "pending" && x.requestedRole === r && (r === "driver" || r === "filler"))}
                                  className="h-5 w-5"
                                />
                                {ROLES[r]}
                              </label>
                            ))}
                          </div>
                        </ApiForm>
                        {x.status !== "disabled" && (
                          <ApiForm
                            action={`/api/users/${x.id}`}
                            submit={x.status === "pending" ? "ไม่อนุมัติ (ปิดบัญชี)" : "ปิดการใช้งาน"}
                            confirm={`ปิดการใช้งานบัญชี ${x.name || x.displayName}? ผู้ใช้จะออกจากระบบทุกเครื่อง และรหัสเลขา AI ถูกยกเลิก`}
                            className="mt-2"
                          >
                            <input type="hidden" name="status" value="disabled" />
                            {shown}
                          </ApiForm>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })}
      <Card title="ประวัติอนุมัติ / เปลี่ยนบทบาท">
        {audit.length ? (
          <Table head={["เวลา", "รายการ", "โดย"]}>
            {audit.map((e, i) => (
              <tr key={i}>
                <td className="whitespace-nowrap">{thDateTime(new Date(e.at))}</td>
                <td>{e.text}</td>
                <td>{e.by}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>ยังไม่มีรายการ</Empty>
        )}
      </Card>
    </>
  );
}
