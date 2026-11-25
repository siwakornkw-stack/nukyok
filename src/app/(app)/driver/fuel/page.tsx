import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { num } from "@/lib/format";
import { thDateTime } from "@/lib/time";
import { Card, Empty, Field, FUEL_STATUS, PageHeader, StatusPill, inputCls } from "@/components/ui";
import { ActionButton, ApiForm, PhotoInput, VehiclePicker } from "@/components/forms";

export default async function DriverFuelPage() {
  const u = await requirePage(["driver"]);
  const [vehicles, mine] = await Promise.all([
    prisma.vehicle.findMany({ where: { active: true }, orderBy: { code: "asc" }, select: { id: true, code: true, model: true } }),
    prisma.fuelRequest.findMany({
      where: { driverId: u.id },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, no: true, status: true, engineHours: true, driverHours: true, slipPhoto: true, createdAt: true, vehicle: { select: { code: true } } },
    }),
  ]);
  // "จำข้อมูลไว้": preselect the remembered vehicle while it is still active
  const remembered = vehicles.find((v) => v.id === u.rememberVehicleId)?.id ?? "";

  return (
    <>
      <PageHeader title="หน้าคนขับ: ขอเติมน้ำมัน" back="/" />
      {/* The key changes with each new request, so the form comes back empty after sending. */}
      <Card key={mine[0]?.id ?? "none"}>
        <ApiForm action="/api/fuel" redirect="/driver/fuel" submit="ส่งคำขอเติมน้ำมัน">
          <Field label="ชื่อผู้ขับ">
            <input name="driverName" defaultValue={u.name} required maxLength={60} className={inputCls} />
          </Field>
          <VehiclePicker vehicles={vehicles} defaultValue={remembered} />
          <label className="mb-3 flex items-center gap-2">
            <input type="checkbox" name="remember" defaultChecked={!!remembered} className="h-5 w-5" />
            จำข้อมูลไว้
          </label>
          <Field label="ชั่วโมงเครื่อง">
            <input type="number" name="engineHours" step="0.1" min="0" inputMode="decimal" required className={inputCls} />
          </Field>
          <Field label="รูปหน้าปัด">
            <PhotoInput name="photo" required />
          </Field>
          <Field label="เลขไมค์" hint="รถที่มีเลขไมค์: กรอกพร้อมถ่ายรูป (รถขุด / เครื่องปั่นไฟ เว้นว่าง)">
            <input type="number" name="odometer" step="0.1" min="0" inputMode="decimal" className={inputCls} />
          </Field>
          <Field label="รูปเลขไมค์">
            <PhotoInput name="odoPhoto" />
          </Field>
        </ApiForm>
      </Card>

      <Card title="คำขอล่าสุดของฉัน">
        {mine.length ? (
          <ul className="divide-y divide-line">
            {mine.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                <div className="flex-1">
                  <div className="font-semibold">
                    #{r.no} {r.vehicle.code}
                  </div>
                  <div className="text-muted">
                    ชม.เครื่อง {num(r.driverHours ?? r.engineHours)} เมื่อ {thDateTime(r.createdAt)}
                  </div>
                </div>
                <StatusPill map={FUEL_STATUS} value={r.status} />
                {/* a slip sent = a filler is filling it: only Office cancels it then */}
                {r.status === "waiting" && !r.slipPhoto && (
                  <ActionButton action={`/api/fuel/${r.id}/cancel`} label="ยกเลิก" confirm={`ยกเลิกคำขอเติมน้ำมัน #${r.no}?`} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีคำขอ</Empty>
        )}
      </Card>
    </>
  );
}
