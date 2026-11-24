import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { Card, Empty, PageHeader, StatusPill, FUEL_STATUS, REPAIR_STATUS, URGENCY } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { thDateTime } from "@/lib/time";

// รายการของฉัน: the driver's repairs (with the vehicle check after a repair) and fuel requests.
export default async function MyRequestsPage() {
  const u = await requirePage(["driver"]);
  const [repairs, fuels] = await Promise.all([
    prisma.repairRequest.findMany({ where: { driverId: u.id }, include: { vehicle: { select: { code: true } } }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.fuelRequest.findMany({ where: { driverId: u.id }, include: { vehicle: { select: { code: true } } }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  return (
    <>
      <PageHeader title="รายการของฉัน" back="/" />
      <Card title="แจ้งซ่อม">
        {repairs.length ? (
          <ul className="divide-y divide-line">
            {repairs.map((r) => (
              <li key={r.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">
                    #{r.no} รถ {r.vehicle.code}
                  </span>
                  <StatusPill map={REPAIR_STATUS} value={r.status} />
                  <StatusPill map={URGENCY} value={r.urgency} />
                </div>
                <p className="mt-1 line-clamp-2 text-sm">{r.symptom}</p>
                <p className="text-xs text-muted">{thDateTime(r.createdAt)}</p>
                {r.status === "done" && (
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <ActionButton
                      action={`/api/repairs/${r.id}/accept`}
                      body={{ pass: true }}
                      label="ตรวจรับรถ ผ่าน"
                      confirm={`ยืนยันตรวจรับรถ ${r.vehicle.code} ซ่อมเรียบร้อยแล้ว?`}
                      primary
                    />
                    <ActionButton
                      action={`/api/repairs/${r.id}/accept`}
                      body={{ pass: false }}
                      label="ไม่ผ่าน"
                      note={{ prompt: "ซ่อมไม่เรียบร้อยเพราะ", required: true }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีรายการแจ้งซ่อม</Empty>
        )}
      </Card>
      <Card title="เติมน้ำมัน">
        {fuels.length ? (
          <ul className="divide-y divide-line">
            {fuels.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 py-3">
                <span className="font-semibold">
                  #{f.no} รถ {f.vehicle.code}
                </span>
                <StatusPill map={FUEL_STATUS} value={f.status} />
                <span className="ml-auto text-xs text-muted">{thDateTime(f.createdAt)}</span>
                {f.status === "waiting" && (
                  <ActionButton action={`/api/fuel/${f.id}/cancel`} label="ยกเลิก" confirm={`ยกเลิกคำขอเติมน้ำมัน #${f.no}?`} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Empty>ยังไม่มีรายการเติมน้ำมัน</Empty>
        )}
      </Card>
    </>
  );
}
