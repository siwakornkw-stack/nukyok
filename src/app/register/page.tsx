import Link from "next/link";
import { redirect } from "next/navigation";
import { ApiForm } from "@/components/forms";
import { AuthShell, Card, Field, Info, Notice, btn2Cls, inputCls } from "@/components/ui";
import { ROLES, ROLE_KEYS, type Role } from "@/lib/roles";
import { currentUser } from "@/lib/session";

// Outside the (app) group: requirePage() sends pending users here. They fill in
// who they are, then wait for Office to approve a role at /office/users.
export default async function RegisterPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const u = await currentUser();
  if (!u) redirect("/login?next=/register");
  if (u.status === "active" && u.roles.length) redirect("/");
  const sp = await searchParams;
  const pending = u.status === "pending";
  return (
    <AuthShell title="ลงทะเบียน">
      {u.status === "disabled" ? (
        <Notice tone="danger">บัญชีถูกปิด ติดต่อ Office</Notice>
      ) : pending && (!u.name || sp.edit) ? (
        <Card>
          <ApiForm action="/api/auth/register" redirect="/register" submit="ลงทะเบียน">
            <Field label="ชื่อ-นามสกุล">
              <input name="name" required minLength={2} maxLength={60} defaultValue={u.name} autoComplete="name" className={inputCls} />
            </Field>
            <Field label="เบอร์โทร">
              <input name="phone" type="tel" maxLength={20} defaultValue={u.phone} autoComplete="tel" className={inputCls} />
            </Field>
            <Field label="บทบาทที่ต้องการ">
              <select name="role" required defaultValue={u.requestedRole} className={inputCls}>
                <option value="">เลือกบทบาท</option>
                {ROLE_KEYS.map((r) => (
                  <option key={r} value={r}>
                    {ROLES[r]}
                  </option>
                ))}
              </select>
            </Field>
          </ApiForm>
        </Card>
      ) : (
        <Card>
          <Notice tone="info">ลงทะเบียนแล้ว รอ Office อนุมัติบทบาท</Notice>
          <Info
            rows={[
              ["ชื่อ-นามสกุล", u.name || "-"],
              ["เบอร์โทร", u.phone || "-"],
              ["บทบาทที่ต้องการ", ROLES[u.requestedRole as Role] ?? "-"],
              ["ชื่อ LINE", u.displayName || "-"],
            ]}
          />
          {pending && (
            <Link href="/register?edit=1" className={`${btn2Cls} mt-4 block text-center`}>
              แก้ไขข้อมูล
            </Link>
          )}
        </Card>
      )}
    </AuthShell>
  );
}
