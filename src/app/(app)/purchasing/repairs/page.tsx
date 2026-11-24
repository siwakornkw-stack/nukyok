import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { Card, Empty, Field, PageHeader, StatusPill, Table, REPAIR_STATUS, URGENCY, chipCls, inputCls } from "@/components/ui";
import { ListFilters, type FilterValues } from "@/components/ListFilters";
import { baht, driverOf } from "@/lib/format";
import { dateRange, isDateKey, thDate } from "@/lib/time";

const TABS = ["quote", "approval", "approved", "repairing", "done", "closed", "rejected", "cancelled"];
const HISTORY = ["closed", "rejected", "cancelled"];
const LATEST = 100;

// งานซ่อม by status, filtered by date reported / vehicle / urgency / search. Open work: urgent first, then
// oldest. Closed / rejected / cancelled: the latest 100.
export default async function PurchasingRepairsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage(["purchasing", "office", "accounting"]);
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const tab = TABS.includes(one("status")) ? one("status") : "quote";
  const history = HISTORY.includes(tab);
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, code: true, model: true }, orderBy: { code: "asc" } });
  const f: FilterValues = {
    from: isDateKey(one("from")) ? one("from") : "",
    to: isDateKey(one("to")) ? one("to") : "",
    vehicle: vehicles.some((v) => v.id === one("vehicle")) ? one("vehicle") : "",
    q: one("q").trim().slice(0, 50),
  };
  const urgency = one("urgency") in URGENCY ? one("urgency") : "";

  const range = dateRange(f.from, f.to);
  const text = { contains: f.q, mode: "insensitive" as const };
  const digits = /^#?\d{1,9}$/.test(f.q) ? Number(f.q.replace("#", "")) : null;
  const where: Prisma.RepairRequestWhereInput = {
    ...(range ? { createdAt: range } : {}),
    ...(f.vehicle ? { vehicleId: f.vehicle } : {}),
    ...(urgency ? { urgency } : {}),
    ...(f.q
      ? {
          OR: [
            ...(digits !== null ? [{ no: digits }] : []),
            { symptom: text },
            { driver: { name: text } },
            { vehicle: { code: text } },
            { supplierName: text },
            { invoice: text },
          ],
        }
      : {}),
  };
  const [counts, rows] = await Promise.all([
    prisma.repairRequest.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.repairRequest.findMany({
      where: { ...where, status: tab },
      include: { vehicle: { select: { code: true } }, driver: { select: { name: true } } },
      orderBy: { createdAt: history ? "desc" : "asc" },
      take: history ? LATEST : undefined,
    }),
  ]);
  if (!history) rows.sort((a, b) => Number(b.urgency === "urgent") - Number(a.urgency === "urgent"));
  const count = Object.fromEntries(counts.map((c) => [c.status, c._count._all]));

  const current = { status: tab === "quote" ? "" : tab, ...f, urgency };
  const link = (v: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(v).filter(([, x]) => x)).toString();
    return `/purchasing/repairs${q ? `?${q}` : ""}`;
  };
  const active = !!(f.from || f.to || f.vehicle || f.q || urgency);

  return (
    <>
      <PageHeader title="งานซ่อม" back="/" />
      <ListFilters
        values={f}
        keep={current.status ? { status: current.status } : {}}
        vehicles={vehicles}
        searchLabel="# / อาการ / ผู้แจ้ง / ร้าน / ใบกำกับ"
        href={(change) => link(change === null ? { status: current.status } : { ...current, ...change })}
        active={active}
      >
        <Field label="ระดับ">
          <select name="urgency" defaultValue={urgency} className={inputCls}>
            <option value="">ทุกระดับ</option>
            {Object.entries(URGENCY).map(([k, [label]]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </ListFilters>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((s) => (
          <Link key={s} href={link({ ...current, status: s === "quote" ? "" : s })} className={chipCls(s === tab)}>
            {REPAIR_STATUS[s][0]} ({count[s] ?? 0})
          </Link>
        ))}
      </div>
      <Card>
        {rows.length ? (
          <Table head={["#", "วันที่", "รถ", "ผู้แจ้ง", "อาการ", "ระดับ", "สถานะ", "ยอด"]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/purchasing/repairs/${r.id}`} className="font-semibold text-brand hover:underline">
                    #{r.no}
                  </Link>
                </td>
                <td className="whitespace-nowrap">{thDate(r.createdAt)}</td>
                <td className="whitespace-nowrap">{r.vehicle.code}</td>
                <td>{driverOf(r)}</td>
                <td>
                  <div className="max-w-56 truncate" title={r.symptom}>
                    {r.symptom}
                  </div>
                </td>
                <td>
                  <StatusPill map={URGENCY} value={r.urgency} />
                </td>
                <td>
                  <StatusPill map={REPAIR_STATUS} value={r.status} />
                </td>
                <td className="whitespace-nowrap">{baht(r.costAmount ?? r.quoteAmount)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>{active ? "ไม่พบรายการตามตัวกรอง" : "ไม่มีรายการ"}</Empty>
        )}
        {history && rows.length === LATEST && <p className="mt-2 text-xs text-muted">แสดง {LATEST} รายการล่าสุด เลือกช่วงวันที่เพื่อดูรายการเก่ากว่านี้</p>}
      </Card>
    </>
  );
}
