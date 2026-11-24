import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { EXPRESS_STATUS, R3_STATUS, expressDocs } from "@/lib/express";
import { baht, driverOf, num } from "@/lib/format";
import { thDateTime } from "@/lib/time";
import { readingText, type FuelFlag } from "@/lib/fuel-checks";
import { Card, Files, FUEL_STATUS, Info, PageHeader, StatusPill, Icon } from "@/components/ui";
import { ActionButton } from "@/components/forms";

const SOURCE: Record<string, string> = { pump: "ปั๊ม", tank: "ถังกลาง" };

export default async function OfficeFuelDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requirePage(["office", "exec", "accounting"]);
  const { id } = await params;
  const r = await prisma.fuelRequest.findUnique({
    where: { id },
    include: { driver: { select: { name: true } }, filler: { select: { name: true } }, vehicle: true, express: true },
  });
  if (!r) notFound();
  const flags = (Array.isArray(r.flags) ? r.flags : []) as FuelFlag[];
  const canAct = hasRole(u, "office", "exec") && ["waiting", "filled", "returned"].includes(r.status);
  const api = `/api/fuel/${r.id}/review`;
  const o = r.express;

  return (
    <>
      <PageHeader title={`เติมน้ำมัน #${r.no}`} back="/office/fuel">
        <StatusPill map={FUEL_STATUS} value={r.status} />
      </PageHeader>

      {!!flags.length && (
        <section className="mb-4 rounded-2xl border border-[#FCA5A5] bg-[#FEF2F2] p-4 text-[#7F1D1D]">
          <h2 className="mb-2 flex items-center gap-2 font-semibold">
            <Icon name="alert" className="h-5 w-5" />
            ผิดปกติ {flags.length} รายการ
          </h2>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {flags.map((f) => (
              <li key={f.code}>{f.text}</li>
            ))}
          </ul>
        </section>
      )}

      <Card title="คำขอ">
        <Info
          rows={[
            ["คนขับ", driverOf(r)],
            ["รถ", r.vehicle.model ? `${r.vehicle.code} - ${r.vehicle.model}` : r.vehicle.code],
            ["มาตรฐานรถ", `${num(r.vehicle.litersPerHour, 2)} ลิตร/ชม. ถัง ${num(r.vehicle.tankLiters, 2)} ลิตร`],
            ["ชั่วโมงเครื่อง (คนขับแจ้ง)", num(r.driverHours ?? r.engineHours)],
            ["เลขไมค์ (คนขับแจ้ง)", num(r.driverOdometer)],
            ["ขอเมื่อ", thDateTime(r.createdAt)],
            ["รูปหน้าปัด", <Files key="dash" keys={[r.dashPhoto]} />],
            ["รูปเลขไมค์", <Files key="odo" keys={[r.odoPhoto]} />],
          ]}
        />
      </Card>

      <Card title="การเติม">
        <Info
          rows={[
            ["คนเติม", r.filler?.name ?? "-"],
            ["เวลาเติม", thDateTime(r.filledAt)],
            ["ชั่วโมงเครื่องตอนเติม", r.filledAt ? readingText(r.engineHours, r.driverHours) : "-"],
            ["เลขไมค์ตอนเติม", r.filledAt ? readingText(r.odometer, r.driverOdometer) : "-"],
            ["รูปหน้าปัดตอนเติม", <Files key="filldash" keys={[r.fillDashPhoto]} />],
            ["ลิตร", num(r.liters, 2)],
            ["ราคาต่อลิตร", num(r.pricePerLiter, 4)],
            ["ยอดเงิน", baht(r.amount)],
            ["แหล่งน้ำมัน", r.source ? (SOURCE[r.source] ?? r.source) : "-"],
            ["ปั๊ม", r.supplierName || "-"],
            ["รหัสผู้จำหน่าย Express", r.supplierCode || "-"],
            ["เลขที่ใบกำกับภาษี", r.invoice || "-"],
            ["รูปสลิป", <Files key="slip" keys={[r.slipPhoto]} />],
          ]}
        />
      </Card>

      <Card title="การตรวจ">
        <Info
          rows={[
            ["ตรวจล่าสุดโดย", r.reviewedBy ? `${r.reviewedBy} (${thDateTime(r.reviewedAt)})` : "-"],
            ["หมายเหตุ", <span key="note" className="whitespace-pre-wrap">{r.returnNote || "-"}</span>],
          ]}
        />
      </Card>

      {(o || (r.status === "approved" && r.source === "pump")) && (
        <Card title="Express">
          {o ? (
            <Info
              rows={[
                ["สถานะ", EXPRESS_STATUS[o.status] ?? o.status],
                ["เลขเอกสาร", expressDocs(o) || "-"],
                ["R3", o.r3Status ? (R3_STATUS[o.r3Status] ?? o.r3Status) : "-"],
                [o.status === "manual" ? "หมายเหตุ" : "ข้อผิดพลาด", o.error || "-"],
                ["ข้อผิดพลาด R3", o.r3Error || "-"],
                ["ส่งเมื่อ", `${thDateTime(o.createdAt)} โดย ${o.createdBy}`],
              ]}
            />
          ) : (
            <p>ไม่ได้ส่งเข้า Express</p>
          )}
        </Card>
      )}

      {canAct && (
        <Card>
          <div className="flex flex-wrap gap-2">
            {r.status === "filled" && (
              <>
                <ActionButton
                  action={api}
                  body={{ action: "approve" }}
                  label="อนุมัติ"
                  primary
                  confirm={flags.length ? `มีรายการผิดปกติ ${flags.length} รายการ ยืนยันอนุมัติ #${r.no}?` : `อนุมัติรายการเติมน้ำมัน #${r.no}?`}
                />
                <ActionButton action={api} body={{ action: "return" }} label="ส่งกลับแก้ไข" note={{ prompt: "เหตุผลที่ส่งกลับให้คนเติมแก้ไข", required: true }} />
              </>
            )}
            <ActionButton action={api} body={{ action: "cancel" }} label="ยกเลิก" note={{ prompt: "เหตุผลที่ยกเลิกคำขอนี้", required: true }} />
          </div>
        </Card>
      )}
    </>
  );
}
