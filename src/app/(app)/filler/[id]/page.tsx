import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { getMasters } from "@/lib/express";
import { baht, dec, driverOf, num } from "@/lib/format";
import { bkkDateKey, thDate, thDateTime } from "@/lib/time";
import { Card, Field, Files, FUEL_STATUS, Info, PageHeader, StatusPill, inputCls, Notice } from "@/components/ui";
import { ApiForm, PhotoInput, SlipInput } from "@/components/forms";
import { readingText, type SlipRead } from "@/lib/fuel-checks";

const SOURCE: Record<string, string> = { pump: "ปั๊ม", tank: "ถังกลาง" };

export default async function FillerRequestPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(["filler"]);
  const { id } = await params;
  const r = await prisma.fuelRequest.findUnique({
    where: { id },
    include: { driver: { select: { name: true } }, filler: { select: { name: true } }, vehicle: { select: { code: true, model: true } } },
  });
  if (!r) notFound();
  const open = r.status === "waiting" || r.status === "returned";
  const suppliers = open ? ((await getMasters())?.fuel.suppliers ?? []) : [];
  const knownSupplier = suppliers.some((s) => s.code === r.supplierCode);
  // the invoice date saved before (a returned fill), else the date read from the slip, else the day a returned fill
  // was filled (one saved before the date was asked: the fill keeps its filledAt), else today
  const today = bkkDateKey();
  const invoiceDate = r.invoiceDate?.toISOString().slice(0, 10) || (r.slipRead as SlipRead | null)?.date || (r.filledAt ? bkkDateKey(r.filledAt) : today);

  return (
    <>
      <PageHeader title={`เติมน้ำมัน #${r.no}`} back="/filler">
        <StatusPill map={FUEL_STATUS} value={r.status} />
      </PageHeader>

      {r.status === "returned" && (
        <Notice className="text-base">
          <p className="font-semibold">Office ส่งกลับให้แก้ไข</p>
          <p className="whitespace-pre-wrap">{r.returnNote || "-"}</p>
        </Notice>
      )}

      <Card title="คำขอ">
        <Info
          rows={[
            ["คนขับ", driverOf(r)],
            ["รถ", r.vehicle.model ? `${r.vehicle.code} - ${r.vehicle.model}` : r.vehicle.code],
            ["ชั่วโมงเครื่อง (คนขับแจ้ง)", num(r.driverHours ?? r.engineHours)],
            ["เลขไมค์ (คนขับแจ้ง)", num(r.driverOdometer)],
            ["ขอเมื่อ", thDateTime(r.createdAt)],
            ["รูปหน้าปัด", <Files key="dash" keys={[r.dashPhoto]} />],
            ["รูปเลขไมค์", <Files key="odo" keys={[r.odoPhoto]} />],
          ]}
        />
      </Card>

      {open ? (
        <Card title={r.status === "returned" ? "แก้ไขข้อมูลการเติม" : "บันทึกการเติม"}>
          <ApiForm action={`/api/fuel/${r.id}/fill`} redirect="/filler" submit="บันทึกการเติม">
            {/* read again at the pump, not copied from the driver: a returned fill shows the filler's own reading */}
            <Field label="ชั่วโมงเครื่อง (อ่านจากหน้าปัดตอนเติม)">
              <input type="number" name="engineHours" step="0.1" min="0" inputMode="decimal" required defaultValue={r.status === "returned" ? (dec(r.engineHours) ?? "") : ""} className={inputCls} />
            </Field>
            <Field label={r.driverOdometer !== null ? "เลขไมค์ (อ่านตอนเติม)" : "เลขไมค์ตอนเติม (ถ้ามี)"}>
              <input type="number" name="odometer" step="0.1" min="0" inputMode="decimal" required={r.driverOdometer !== null} defaultValue={dec(r.odometer) ?? ""} className={inputCls} />
            </Field>
            <Field label="รูปหน้าปัดตอนเติม" hint={r.fillDashPhoto ? "มีรูปเดิมแล้ว ถ่ายใหม่เฉพาะเมื่อต้องการเปลี่ยน" : "ระบบเทียบกับที่คนขับแจ้ง"}>
              <PhotoInput name="fillDash" required={!r.fillDashPhoto} />
            </Field>
            {r.fillDashPhoto && (
              <div className="mb-3">
                <Files keys={[r.fillDashPhoto]} />
              </div>
            )}
            {/* first: a pump slip read by the AI fills the fields below */}
            <Field
              label="รูปสลิป"
              hint={`${r.slipPhoto ? "มีรูปเดิมแล้ว ถ่ายใหม่เฉพาะเมื่อต้องการเปลี่ยน" : "จำเป็นเมื่อเติมจากปั๊ม"}${process.env.GEMINI_API_KEY ? " · ถ่ายแล้วระบบอ่านและกรอกตัวเลขให้" : ""}`}
            >
              <SlipInput action={`/api/fuel/${r.id}/slip`} current={r.slipPhoto ?? ""} />
            </Field>
            {r.slipPhoto && (
              <div className="mb-3">
                <Files keys={[r.slipPhoto]} />
              </div>
            )}
            <Field label="ลิตร">
              <input type="number" name="liters" step="0.001" min="0" inputMode="decimal" required defaultValue={dec(r.liters) ?? ""} className={inputCls} />
            </Field>
            <Field label="ราคาต่อลิตร (บาท)">
              <input type="number" name="pricePerLiter" step="0.0001" min="0" inputMode="decimal" required defaultValue={dec(r.pricePerLiter) ?? ""} className={inputCls} />
            </Field>
            {/* not pre-filled for a central-tank fill: left blank, the route costs it at litres x price again */}
            <Field label="ยอดเงิน (บาท)" hint="จำเป็นเมื่อเติมจากปั๊ม ถังกลางเว้นว่างได้ (คิดจากลิตร × ราคาต่อลิตร)">
              <input type="number" name="amount" step="0.01" min="0" inputMode="decimal" defaultValue={r.source === "tank" ? "" : (dec(r.amount) ?? "")} className={inputCls} />
            </Field>
            <fieldset className="mb-3">
              <legend className="mb-1 text-sm font-semibold">แหล่งน้ำมัน</legend>
              <div className="flex gap-2">
                {Object.entries(SOURCE).map(([value, label]) => (
                  <label key={value} className="flex flex-1 items-center gap-2 rounded-xl border border-line bg-card transition has-[:checked]:border-brand has-[:checked]:bg-brand-soft has-[:checked]:ring-1 has-[:checked]:ring-brand px-3.5 py-3">
                    <input type="radio" name="source" value={value} required defaultChecked={r.source === value} className="h-5 w-5" />
                    {label}
                  </label>
                ))}
              </div>
            </fieldset>
            {!!suppliers.length && (
              <Field label="ปั๊ม">
                <select name="supplierCode" defaultValue={knownSupplier ? r.supplierCode : ""} className={inputCls}>
                  <option value="">-- ไม่ระบุ --</option>
                  {suppliers.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="ชื่อปั๊ม (ถ้าไม่มีในรายการ)">
              <input name="supplierName" maxLength={120} defaultValue={knownSupplier ? "" : r.supplierName} className={inputCls} />
            </Field>
            <Field label="เลขที่ใบกำกับภาษี">
              <input name="invoice" maxLength={40} defaultValue={r.invoice} className={inputCls} />
            </Field>
            {/* Express dates the PK / H3 and its input VAT by it: a slip bought before midnight and saved after keeps its own date */}
            <Field label="วันที่ในใบกำกับภาษี" hint="เติมจากปั๊ม: วันที่บนสลิป (ไม่ใช่วันที่พิมพ์)">
              <input type="date" name="invoiceDate" max={today} defaultValue={invoiceDate} className={inputCls} />
            </Field>
          </ApiForm>
        </Card>
      ) : (
        <Card title="ข้อมูลการเติม">
          <Info
            rows={[
              ["คนเติม", r.filler?.name ?? "-"],
              ["เวลาเติม", thDateTime(r.filledAt)],
              ["ชั่วโมงเครื่องตอนเติม", readingText(r.engineHours, r.driverHours)],
              ["เลขไมค์ตอนเติม", readingText(r.odometer, r.driverOdometer)],
              ["รูปหน้าปัดตอนเติม", <Files key="filldash" keys={[r.fillDashPhoto]} />],
              ["ลิตร", num(r.liters, 2)],
              ["ราคาต่อลิตร", num(r.pricePerLiter, 4)],
              ["ยอดเงิน", baht(r.amount)],
              ["แหล่งน้ำมัน", r.source ? (SOURCE[r.source] ?? r.source) : "-"],
              ["ปั๊ม", r.supplierName || "-"],
              ["เลขที่ใบกำกับภาษี", r.invoice || "-"],
              ["วันที่ในใบกำกับภาษี", thDate(r.invoiceDate)],
              ["รูปสลิป", <Files key="slip" keys={[r.slipPhoto]} />],
              ["หมายเหตุ Office", r.returnNote || "-"],
            ]}
          />
        </Card>
      )}
    </>
  );
}
