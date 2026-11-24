import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { hoursBetween, shiftOpen, thDate, thDateTime, thTime } from "@/lib/time";
import { Card, Empty, Field, PageHeader, Table, Notice } from "@/components/ui";
import { ApiForm, GpsInput, PhotoInput } from "@/components/forms";

export default async function DriverAttendancePage() {
  const u = await requirePage(["driver"]);
  const recent = await prisma.attendance.findMany({ where: { userId: u.id }, orderBy: { inAt: "desc" }, take: 7 });
  // Open shift (same rule as /api/attendance): the latest shift without ออกงาน while shiftOpen.
  // An older one is ลืมออกงาน and does not block เข้างาน.
  const unclosed = recent.find((r) => !r.outAt);
  const open = unclosed && shiftOpen(unclosed) ? unclosed : undefined;
  const action = open ? "out" : "in";

  return (
    <>
      <PageHeader title="เข้างาน / ออกงาน" back="/" />
      <Card title={open ? "ออกงาน" : "เข้างาน"}>
        {open ? (
          <Notice tone="info" className="mb-3">
            เข้างานเมื่อ {thDateTime(open.inAt)}
          </Notice>
        ) : (
          <>
            {unclosed && (
              <Notice className="mb-3">กะวันที่ {thDate(unclosed.workDate)} ไม่ได้กดออกงาน (ระบบถือว่าลืม)</Notice>
            )}
            <p className="mb-3 text-sm text-muted">กดออกงานได้หลังจากกดเข้างานแล้วเท่านั้น</p>
          </>
        )}
        {/* key: a new form after each step, so the previous photo is not carried over */}
        <ApiForm key={action} action="/api/attendance" redirect="/driver/attendance" submit={open ? "ออกงาน" : "เข้างาน"}>
          <input type="hidden" name="action" value={action} />
          <Field label="รูปถ่าย" hint="รูปที่มีวันเวลา / สถานที่ (แอปกล้องที่ประทับเวลา)">
            <PhotoInput name="photo" required camera={false} />
          </Field>
          <GpsInput />
        </ApiForm>
      </Card>
      <Card title="7 ครั้งล่าสุด">
        {recent.length ? (
          <Table head={["วันที่", "เข้า", "ออก", "ชั่วโมง"]}>
            {recent.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{thDate(r.workDate)}</td>
                <td>{thTime(r.inAt)}</td>
                <td>{thTime(r.outAt)}</td>
                <td>{r.outAt ? hoursBetween(r.inAt, r.outAt).toFixed(1) : "-"}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>ยังไม่มีประวัติ</Empty>
        )}
      </Card>
    </>
  );
}
