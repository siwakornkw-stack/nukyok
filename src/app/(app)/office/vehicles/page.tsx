import Link from "next/link";
import { prisma } from "@/lib/db";
import { num } from "@/lib/format";
import { hasRole } from "@/lib/roles";
import { requirePage } from "@/lib/session";
import { latestHours, PM_STATE, pmState } from "@/lib/summary";
import { Card, Empty, Field, PageHeader, StatusPill, Table, inputCls } from "@/components/ui";
import { ApiForm } from "@/components/forms";

export default async function VehiclesPage() {
  const u = await requirePage(["office", "exec", "purchasing", "accounting"]);
  const [vehicles, hours] = await Promise.all([prisma.vehicle.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] }), latestHours()]);
  return (
    <>
      <PageHeader title="ข้อมูลรถ / หน้าสินทรัพย์" back="/" />
      <Card>
        {vehicles.length ? (
          <Table head={["รหัส / ทะเบียน", "รุ่น", "ลิตร/ชม. มาตรฐาน", "ความจุถัง", "รอบเช็คระยะ (ชม.)", "เช็คล่าสุดที่ (ชม.)", "ชม.เครื่องล่าสุด", "สถานะเช็คระยะ", "Express รหัส"]}>
            {vehicles.map((v) => {
              const h = hours.get(v.id);
              const pm = pmState(v, h);
              return (
                <tr key={v.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/office/vehicles/${v.id}`} className="font-semibold text-brand hover:underline">
                      {v.code}
                    </Link>
                    {!v.active && <span className="ml-1 text-xs text-muted">(ไม่ใช้งาน)</span>}
                  </td>
                  <td>{v.model || "-"}</td>
                  <td>{num(v.litersPerHour, 2)}</td>
                  <td>{num(v.tankLiters, 2)}</td>
                  <td>{num(v.pmEveryHours, 0)}</td>
                  <td>{num(v.pmLastHours)}</td>
                  <td>{num(h)}</td>
                  <td>
                    {pm ? (
                      <StatusPill map={PM_STATE} value={pm.state} />
                    ) : v.pmEveryHours && v.pmLastHours === null ? (
                      <span className="text-xs text-muted">ไม่ทราบเช็คล่าสุด</span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td>{v.expressItem || "-"}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>ยังไม่มีรถ</Empty>
        )}
      </Card>
      {hasRole(u, "office") && (
        <Card title="เพิ่มรถ">
          <ApiForm action="/api/vehicles" submit="เพิ่มรถ">
            <Field label="รหัส / ทะเบียนรถ">
              <input name="code" required maxLength={30} className={inputCls} />
            </Field>
            <Field label="รุ่น">
              <input name="model" maxLength={100} className={inputCls} />
            </Field>
            <Field label="ลิตร/ชม. มาตรฐาน">
              <input name="litersPerHour" type="number" inputMode="decimal" min="0" step="0.01" className={inputCls} />
            </Field>
            <Field label="ความจุถัง (ลิตร)">
              <input name="tankLiters" type="number" inputMode="decimal" min="0" step="0.01" className={inputCls} />
            </Field>
            <Field label="รอบเช็คระยะ (ชม.)" hint="เช่น ทุก 500 ชม.เครื่อง">
              <input name="pmEveryHours" type="number" inputMode="numeric" min="0" step="1" className={inputCls} />
            </Field>
            <Field label="เช็คล่าสุดที่ (ชม.เครื่อง)" hint="ว่างไว้ = ไม่ทราบ ระบบยังไม่เตือนเช็คระยะของคันนี้">
              <input name="pmLastHours" type="number" inputMode="decimal" min="0" step="0.1" className={inputCls} />
            </Field>
          </ApiForm>
        </Card>
      )}
    </>
  );
}
