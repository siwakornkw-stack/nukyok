import { prisma } from "@/lib/db";
import { str } from "@/lib/http";
import { requirePage } from "@/lib/session";
import { bkkDateKey, dateOnly, hoursBetween, isDateKey, shiftOpen, thDate, thTime } from "@/lib/time";
import { Card, Empty, Field, Files, Info, PageHeader, Pill, Table, btnCls, inputCls, Notice } from "@/components/ui";

const LIMIT = 1000;

const mapUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;

export default async function AttendanceReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage(["office", "exec"]);
  const sp = await searchParams;
  const today = bkkDateKey();
  const from = isDateKey(sp.from) ? sp.from : `${today.slice(0, 8)}01`;
  const to = isDateKey(sp.to) ? sp.to : today;
  const drivers = await prisma.user.findMany({
    where: { roles: { has: "driver" } },
    select: { id: true, name: true, displayName: true },
    orderBy: { name: "asc" },
  });
  const picked = str(sp.driver, 40);
  const driver = drivers.some((d) => d.id === picked) ? picked : "";

  const found = await prisma.attendance.findMany({
    where: { workDate: { gte: dateOnly(from), lte: dateOnly(to) }, ...(driver ? { userId: driver } : {}) },
    include: { user: { select: { name: true, displayName: true } } },
    orderBy: [{ workDate: "desc" }, { inAt: "asc" }],
    take: LIMIT + 1,
  });
  const cut = found.length > LIMIT;
  const rows = found.slice(0, LIMIT);
  const now = new Date();

  // Per person: days clocked in, hours of finished shifts, days without ออกงาน.
  const totals = new Map<string, { name: string; days: number; hours: number; noOut: number }>();
  for (const r of rows) {
    const t = totals.get(r.userId) ?? { name: r.user.name || r.user.displayName, days: 0, hours: 0, noOut: 0 };
    t.days++;
    if (r.outAt) t.hours += hoursBetween(r.inAt, r.outAt);
    else t.noOut++;
    totals.set(r.userId, t);
  }
  const summary = [...totals].sort(([, a], [, b]) => a.name.localeCompare(b.name, "th"));

  return (
    <>
      <PageHeader title="รีพอร์ตเข้างาน / ออกงาน" back="/" />
      <Card>
        <form method="get" className="grid gap-x-3 sm:grid-cols-4 sm:items-end">
          <Field label="ตั้งแต่วันที่">
            <input type="date" name="from" defaultValue={from} className={inputCls} />
          </Field>
          <Field label="ถึงวันที่">
            <input type="date" name="to" defaultValue={to} className={inputCls} />
          </Field>
          <Field label="คนขับ">
            <select name="driver" defaultValue={driver} className={inputCls}>
              <option value="">ทุกคน</option>
              {drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.displayName}
                </option>
              ))}
            </select>
          </Field>
          <button type="submit" className={`${btnCls} mb-3`}>
            ดูรายงาน
          </button>
        </form>
      </Card>

      <Card title={`รายการ (${rows.length})`}>
        {cut && (
          <Notice className="mb-3">
            แสดงเพียง {LIMIT.toLocaleString()} รายการล่าสุด และสรุปด้านล่างนับเฉพาะรายการที่แสดง เลือกช่วงวันที่ให้สั้นลงหรือเลือกคนขับ
          </Notice>
        )}
        {rows.length ? (
          <Table head={["วันที่", "ชื่อ", "เข้า", "ออก", "ชั่วโมง", "รูป", "พิกัด"]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">{thDate(r.workDate)}</td>
                <td>{r.user.name || r.user.displayName}</td>
                <td>{thTime(r.inAt)}</td>
                <td>
                  {r.outAt ? (
                    thTime(r.outAt)
                  ) : shiftOpen(r, now) ? (
                    <Pill tone="red">ยังไม่ออก</Pill>
                  ) : (
                    <Pill tone="orange">ลืมออกงาน</Pill>
                  )}
                </td>
                <td>{r.outAt ? hoursBetween(r.inAt, r.outAt).toFixed(1) : "-"}</td>
                <td>
                  <Files keys={[r.inPhoto, r.outPhoto]} />
                </td>
                <td className="whitespace-nowrap">
                  {r.inLat !== null && r.inLng !== null && (
                    <a href={mapUrl(r.inLat, r.inLng)} target="_blank" rel="noreferrer" className="mr-2 text-brand hover:underline">
                      เข้า
                    </a>
                  )}
                  {r.outLat !== null && r.outLng !== null && (
                    <a href={mapUrl(r.outLat, r.outLng)} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">
                      ออก
                    </a>
                  )}
                  {r.inLat === null && r.outLat === null && <span className="text-muted">-</span>}
                </td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>ไม่มีข้อมูลในช่วงนี้</Empty>
        )}
      </Card>

      {!!summary.length && (
        <>
          <h2 className="mb-3 font-semibold">สรุปรายคน</h2>
          <div className="grid gap-x-3 sm:grid-cols-2 lg:grid-cols-3">
            {summary.map(([id, s]) => (
              <Card key={id} title={s.name}>
                <Info
                  rows={[
                    ["วันที่เข้างาน", `${s.days} วัน`],
                    ["ชั่วโมงรวม", s.hours.toFixed(1)],
                    ["ไม่ได้กดออกงาน", s.noOut ? <Pill tone="red">{s.noOut} วัน</Pill> : "0 วัน"],
                  ]}
                />
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
