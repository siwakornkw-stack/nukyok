import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { Card, Field, PageHeader, URGENCY, inputCls } from "@/components/ui";
import { ApiForm, PhotoInput, VehiclePicker } from "@/components/forms";

// แจ้งซ่อม (driver). ?vehicle=<id> preselects a vehicle; ?pm=1 comes from a service-due reminder.
export default async function DriverRepairPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requirePage(["driver"]);
  const sp = await searchParams;
  const vehicles = await prisma.vehicle.findMany({ where: { active: true }, select: { id: true, code: true, model: true }, orderBy: { code: "asc" } });
  const preset = vehicles.find((v) => v.id === sp.vehicle) ?? vehicles.find((v) => v.id === u.rememberVehicleId);
  const pm = sp.pm === "1";
  return (
    <>
      <PageHeader title="แจ้งซ่อม" back="/" />
      <Card>
        <ApiForm action="/api/repairs" submit="ส่งแจ้งซ่อม">
          <Field label="ชื่อผู้ขับ">
            <input name="driverName" defaultValue={u.name} required maxLength={60} className={inputCls} />
          </Field>
          <VehiclePicker vehicles={vehicles} defaultValue={preset?.id ?? ""} />
          <Field label="อาการ">
            <textarea name="symptom" required minLength={3} maxLength={1000} rows={3} className={inputCls} />
          </Field>
          <Field label="สาเหตุ (ถ้าทราบ)">
            <textarea name="cause" maxLength={1000} rows={2} className={inputCls} />
          </Field>
          <Field label="ไมค์ / ชั่วโมงเครื่อง">
            <input name="odometer" type="number" inputMode="decimal" step="any" min="0" className={inputCls} />
          </Field>
          <Field label="รอบเช็คระยะ">
            <input name="pmRound" maxLength={100} defaultValue={pm ? "ถึงรอบเช็คระยะ" : ""} className={inputCls} />
          </Field>
          {pm && <input type="hidden" name="fromPm" value="1" />}
          <Field label="รูปอาการเสีย">
            <PhotoInput name="photos" multiple required />
          </Field>
          <fieldset className="mb-4">
            <legend className="mb-1 text-sm font-semibold">ระดับ</legend>
            <div className="grid gap-2">
              {Object.entries(URGENCY).map(([value, [label]]) => (
                <label key={value} className="flex items-center gap-3 rounded-xl border border-line bg-card transition has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:ring-1 has-[:checked]:ring-brand px-3.5 py-3">
                  <input type="radio" name="urgency" value={value} defaultChecked={value === "normal"} className="h-5 w-5" />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
        </ApiForm>
      </Card>
    </>
  );
}
