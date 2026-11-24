import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { Card, Empty, PageHeader, StatusPill, REPAIR_STATUS, URGENCY } from "@/components/ui";
import { baht } from "@/lib/format";
import { thDate } from "@/lib/time";

const include = { vehicle: { select: { code: true } } } satisfies Prisma.RepairRequestInclude;
type Row = Prisma.RepairRequestGetPayload<{ include: typeof include }>;

function Item({ r }: { r: Row }) {
  const amount = r.costAmount ?? r.quoteAmount;
  return (
    <li>
      <Link href={`/exec/repairs/${r.id}`} className="block py-3 hover:bg-hover">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">
            #{r.no} รถ {r.vehicle.code}
          </span>
          <StatusPill map={URGENCY} value={r.urgency} />
          <StatusPill map={REPAIR_STATUS} value={r.status} />
          {amount !== null && <span className="ml-auto font-semibold">{baht(amount)} บาท (รวม VAT)</span>}
        </div>
        <p className="mt-1 truncate text-sm">{r.symptom}</p>
        <p className="text-xs text-muted">{thDate(r.createdAt)}</p>
      </Link>
    </li>
  );
}

// อนุมัติงานซ่อม: waiting for approval (oldest first), then the latest 50 others.
export default async function ExecRepairsPage() {
  await requirePage(["exec"]);
  const [waiting, others] = await Promise.all([
    prisma.repairRequest.findMany({ where: { status: "approval" }, include, orderBy: { createdAt: "asc" } }),
    prisma.repairRequest.findMany({ where: { status: { not: "approval" } }, include, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);
  return (
    <>
      <PageHeader title="อนุมัติงานซ่อม" back="/" />
      <Card title={`รออนุมัติ (${waiting.length})`}>
        {waiting.length ? (
          <ul className="divide-y divide-line">
            {waiting.map((r) => (
              <Item key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <Empty>ไม่มีรายการรออนุมัติ</Empty>
        )}
      </Card>
      <Card title="รายการล่าสุด">
        {others.length ? (
          <ul className="divide-y divide-line">
            {others.map((r) => (
              <Item key={r.id} r={r} />
            ))}
          </ul>
        ) : (
          <Empty>ไม่มีรายการ</Empty>
        )}
      </Card>
    </>
  );
}
