import type { Prisma } from "@prisma/client";
import { Card, Files, Info, Pill, StatusPill, REPAIR_STATUS, URGENCY } from "@/components/ui";
import { EXPRESS_STATUS, expressDocs } from "@/lib/express";
import { baht, driverOf, num } from "@/lib/format";
import { thDate, thDateTime } from "@/lib/time";

// One repair request as the purchasing and exec detail pages show it.
export const repairInclude = {
  vehicle: { select: { code: true, model: true } },
  driver: { select: { name: true } },
  express: true,
} satisfies Prisma.RepairRequestInclude;

type Repair = Prisma.RepairRequestGetPayload<{ include: typeof repairInclude }>;

const multiline = (s: string) => (s ? <span className="whitespace-pre-line">{s}</span> : "-");
const by = (name: string | null, at: Date | null) => `${name ?? "-"} · ${thDateTime(at)}`;

export function RepairDetail({ r }: { r: Repair }) {
  const x = r.express;
  return (
    <>
      <Card title={`แจ้งซ่อม #${r.no}`}>
        <Info
          rows={[
            ["สถานะ", <StatusPill key="status" map={REPAIR_STATUS} value={r.status} />],
            ["ระดับ", <StatusPill key="urgency" map={URGENCY} value={r.urgency} />],
            ["รถ", r.vehicle.model ? `${r.vehicle.code} (${r.vehicle.model})` : r.vehicle.code],
            ["ผู้แจ้ง", driverOf(r)],
            ["วันที่แจ้ง", thDateTime(r.createdAt)],
            ["อาการ", multiline(r.symptom)],
            ["สาเหตุ", multiline(r.cause)],
            ["ไมค์ / ชั่วโมงเครื่อง", num(r.odometer)],
            ["รอบเช็คระยะ", r.pmRound || "-"],
            ["รูปอาการเสีย", <Files key="photos" keys={r.photos} />],
          ]}
        />
      </Card>

      {r.quotedAt && (
        <Card title="ใบเสนอราคา">
          <p className="mb-3 text-3xl font-bold">
            {baht(r.quoteAmount)} <span className="text-base font-normal text-muted">บาท (รวม VAT)</span>
          </p>
          <Info
            rows={[
              ["ไฟล์", <Files key="files" keys={r.quoteFiles} />],
              ["หมายเหตุ", multiline(r.quoteNote)],
              ["โดย", by(r.quotedBy, r.quotedAt)],
            ]}
          />
        </Card>
      )}

      {r.decidedAt && (
        <Card title="ผู้บริหาร">
          <Info
            rows={[
              ["ผล", r.status === "rejected" ? <Pill key="no" tone="red">ไม่อนุมัติ</Pill> : <Pill key="yes" tone="green">อนุมัติ</Pill>],
              ["หมายเหตุ", multiline(r.decisionNote)],
              ["โดย", by(r.decidedBy, r.decidedAt)],
            ]}
          />
        </Card>
      )}

      {r.costedAt && (
        <Card title="ค่าซ่อม">
          <p className="mb-3 text-2xl font-bold">
            {baht(r.costAmount)} <span className="text-base font-normal text-muted">บาท (รวม VAT)</span>
          </p>
          <Info
            rows={[
              ["ร้าน / อู่", [r.supplierCode, r.supplierName].filter(Boolean).join(" ") || "-"],
              ["รหัสค่าซ่อม", r.itemCode || "-"],
              ["เลขที่ใบกำกับภาษี", r.invoice || "-"],
              ["วันที่ในใบกำกับภาษี", thDate(r.invoiceDate)],
              ["รายละเอียด", multiline(r.costDetail)],
              ["บิล / รูป", <Files key="bills" keys={r.billFiles} />],
              ["โดย", by(r.costedBy, r.costedAt)],
            ]}
          />
        </Card>
      )}

      {/* not closedAt: a cancelled job has one too, and every closed job went through done */}
      {(r.doneAt || r.reopenCount > 0) && (
        <Card title="ผลการซ่อม">
          <Info
            rows={[
              ["ซ่อมเสร็จ", thDateTime(r.doneAt)],
              ["ตรวจรับไม่ผ่าน", r.reopenCount ? <span key="reopen">{r.reopenCount} ครั้ง: {multiline(r.reopenNote)}</span> : "-"],
              ["ปิดงาน", thDateTime(r.closedAt)],
            ]}
          />
        </Card>
      )}

      {r.endedBy && (
        <Card title={r.status === "cancelled" ? "ยกเลิกงานซ่อม" : "ปิดงานแทนคนขับ"}>
          <Info
            rows={[
              [r.status === "cancelled" ? "ยกเลิกโดย" : "ปิดงานแทนคนขับโดย", by(r.endedBy, r.closedAt)],
              ["เหตุผล", multiline(r.endNote)],
            ]}
          />
        </Card>
      )}

      {(x || r.costedAt) && (
        <Card title="Express">
          {x ? (
            <Info
              rows={[
                ["สถานะ", EXPRESS_STATUS[x.status] ?? x.status],
                ["เอกสาร", expressDocs(x) || "-"],
                ["ข้อผิดพลาด", x.error || "-"],
              ]}
            />
          ) : (
            <p className="text-sm text-muted">ยังไม่ได้ส่งเข้า Express (จัดซื้อ / Office ส่งได้จากหน้างานซ่อม หรือคีย์ใน Express เอง)</p>
          )}
        </Card>
      )}
    </>
  );
}
