import { ApiForm } from "@/components/forms";
import { Card, Empty, Info, PageHeader } from "@/components/ui";
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

// Each form posts the full wanted state (roles + status) to /api/users/<id>.
export default async function UsersPage() {
  const u = await requirePage(["office"]);
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
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
              {list.map((x) => (
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
                    ]}
                  />
                  {x.status === "pending" && !x.name ? (
                    <p className="mt-3 text-sm text-muted">รอผู้ใช้กรอกข้อมูลที่หน้าลงทะเบียน</p>
                  ) : (
                    <>
                      <ApiForm
                        action={`/api/users/${x.id}`}
                        submit={x.status === "pending" ? "อนุมัติ" : x.status === "active" ? "บันทึกบทบาท" : "เปิดใช้งานอีกครั้ง"}
                        className="mt-3"
                      >
                        <input type="hidden" name="status" value="active" />
                        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {ROLE_KEYS.map((r) => (
                            <label key={r} className="flex items-center gap-2 rounded-xl border border-line bg-card transition has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:ring-1 has-[:checked]:ring-brand px-3 py-2.5">
                              <input
                                type="checkbox"
                                name="roles"
                                value={r}
                                defaultChecked={x.roles.includes(r) || (x.status === "pending" && x.requestedRole === r)}
                                className="h-5 w-5"
                              />
                              {ROLES[r]}
                            </label>
                          ))}
                        </div>
                      </ApiForm>
                      {x.status !== "disabled" && x.id !== u.id && (
                        <ApiForm
                          action={`/api/users/${x.id}`}
                          submit={x.status === "pending" ? "ไม่อนุมัติ (ปิดบัญชี)" : "ปิดการใช้งาน"}
                          confirm={`ปิดการใช้งานบัญชี ${x.name || x.displayName}?`}
                          className="mt-2"
                        >
                          <input type="hidden" name="status" value="disabled" />
                          {x.roles.map((r) => (
                            <input key={r} type="hidden" name="roles" value={r} />
                          ))}
                        </ApiForm>
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </Card>
        );
      })}
    </>
  );
}
