import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { Card, PageHeader } from "@/components/ui";
import { ActionButton } from "@/components/forms";
import { baht } from "@/lib/format";
import { RepairDetail, repairInclude } from "@/app/(app)/repairs-shared";

// The executive opens this from the LINE message, reads the quotation and decides.
// quotedAt goes with the decision so a page left open while a new quotation came in cannot decide on it.
export default async function ExecRepairPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePage(["exec"]);
  const { id } = await params;
  const r = await prisma.repairRequest.findUnique({ where: { id }, include: repairInclude });
  if (!r) notFound();

  return (
    <>
      <PageHeader title={`แจ้งซ่อม #${r.no}`} back="/exec/repairs" />
      <RepairDetail r={r} />
      {r.status === "approval" && (
        <Card>
          <div className="grid grid-cols-2 gap-3">
            <ActionButton
              action={`/api/repairs/${r.id}/decide`}
              body={{ approve: true, quotedAt: r.quotedAt?.toISOString() }}
              label="อนุมัติ"
              confirm={`อนุมัติค่าซ่อม ${baht(r.quoteAmount)} บาท (รวม VAT)?`}
              primary
            />
            <ActionButton
              action={`/api/repairs/${r.id}/decide`}
              body={{ approve: false, quotedAt: r.quotedAt?.toISOString() }}
              label="ไม่อนุมัติ"
              note={{ prompt: "เหตุผลที่ไม่อนุมัติ", required: true }}
            />
          </div>
        </Card>
      )}
    </>
  );
}
