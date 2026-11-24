import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { driverOf, num } from "@/lib/format";
import { thDateTime } from "@/lib/time";
import { Card, Empty, FUEL_STATUS, PageHeader, StatusPill, Notice } from "@/components/ui";

export default async function FillerPage() {
  await requirePage(["filler"]);
  const list = await prisma.fuelRequest.findMany({
    where: { status: { in: ["waiting", "returned"] } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      no: true,
      status: true,
      engineHours: true,
      createdAt: true,
      returnNote: true,
      driverName: true,
      driver: { select: { name: true } },
      vehicle: { select: { code: true, model: true } },
    },
  });
  const sections = [
    { title: "รอเติม", rows: list.filter((r) => r.status === "waiting") },
    { title: "ส่งกลับแก้ไข", rows: list.filter((r) => r.status === "returned") },
  ];

  return (
    <>
      <PageHeader title="รายการรอเติมน้ำมัน" back="/" />
      {sections.map((s) => (
        <Card key={s.title} title={`${s.title} (${s.rows.length})`}>
          {s.rows.length ? (
            <div className="grid gap-2">
              {s.rows.map((r) => (
                <Link key={r.id} href={`/filler/${r.id}`} className="block rounded-2xl border border-line bg-card p-4 shadow-[0_1px_3px_rgb(15_23_42/0.05)] transition hover:border-brand/40 hover:shadow-md active:scale-[0.99]">
                  <div className="flex items-center gap-2">
                    <span className="flex-1 font-semibold">
                      #{r.no} {r.vehicle.code} <span className="font-normal text-muted">{r.vehicle.model}</span>
                    </span>
                    <StatusPill map={FUEL_STATUS} value={r.status} />
                  </div>
                  <div className="mt-1 text-sm text-muted">
                    {driverOf(r)} ชม.เครื่อง {num(r.engineHours)} ขอเมื่อ {thDateTime(r.createdAt)}
                  </div>
                  {r.status === "returned" && (
                    <Notice className="mb-0 mt-2 whitespace-pre-wrap">{r.returnNote || "ส่งกลับให้แก้ไข"}</Notice>
                  )}
                </Link>
              ))}
            </div>
          ) : (
            <Empty>ไม่มีรายการ</Empty>
          )}
        </Card>
      ))}
    </>
  );
}
