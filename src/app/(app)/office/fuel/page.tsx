import Link from "next/link";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { baht, driverOf, num } from "@/lib/format";
import { dateRange, isDateKey, thDateTime } from "@/lib/time";
import { Card, Empty, FUEL_STATUS, Field, PageHeader, Pill, StatusPill, Table, chipCls, inputCls } from "@/components/ui";
import { ListFilters, type FilterValues } from "@/components/ListFilters";

const TABS: { key: string; status: string; label: string; orderBy: Prisma.FuelRequestOrderByWithRelationInput; take?: number }[] = [
  { key: "review", status: "filled", label: "รอตรวจ", orderBy: { filledAt: "asc" } },
  { key: "returned", status: "returned", label: "ส่งกลับแก้ไข", orderBy: { filledAt: "asc" } },
  { key: "waiting", status: "waiting", label: "รอเติม", orderBy: { createdAt: "asc" } },
  { key: "approved", status: "approved", label: "อนุมัติแล้ว", orderBy: { filledAt: "desc" }, take: 100 },
  { key: "cancelled", status: "cancelled", label: "ยกเลิก", orderBy: { createdAt: "desc" }, take: 50 },
];

const flagCount = (flags: Prisma.JsonValue) => (Array.isArray(flags) ? flags.length : 0);

export default async function OfficeFuelPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage(["office", "exec", "accounting"]);
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const tab = TABS.find((t) => t.key === one("tab")) ?? TABS[0];
  const vehicles = await prisma.vehicle.findMany({ select: { id: true, code: true, model: true }, orderBy: { code: "asc" } });
  const f: FilterValues = {
    from: isDateKey(one("from")) ? one("from") : "",
    to: isDateKey(one("to")) ? one("to") : "",
    vehicle: vehicles.some((v) => v.id === one("vehicle")) ? one("vehicle") : "",
    q: one("q").trim().slice(0, 50),
  };
  const flagged = one("flagged") === "1";

  // the date shown in the list: when it was filled, else when it was asked for
  const range = dateRange(f.from, f.to);
  const text = { contains: f.q, mode: "insensitive" as const };
  const digits = /^#?\d{1,9}$/.test(f.q) ? Number(f.q.replace("#", "")) : null;
  const where: Prisma.FuelRequestWhereInput = {
    ...(range ? { OR: [{ filledAt: range }, { filledAt: null, createdAt: range }] } : {}),
    ...(f.vehicle ? { vehicleId: f.vehicle } : {}),
    ...(flagged ? { NOT: { flags: { equals: [] } } } : {}),
    ...(f.q
      ? {
          AND: [
            {
              OR: [
                ...(digits !== null ? [{ no: digits }] : []),
                { invoice: text },
                { driver: { name: text } },
                { filler: { name: text } },
                { vehicle: { code: text } },
              ],
            },
          ],
        }
      : {}),
  };
  const [groups, list] = await Promise.all([
    prisma.fuelRequest.groupBy({ by: ["status"], where, _count: { _all: true } }),
    prisma.fuelRequest.findMany({
      where: { ...where, status: tab.status },
      orderBy: tab.orderBy,
      take: tab.take,
      include: { vehicle: { select: { code: true } }, driver: { select: { name: true } }, filler: { select: { name: true } } },
    }),
  ]);
  const counts = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  // flagged first, oldest first within each group (the sort is stable)
  if (tab.key === "review") list.sort((a, b) => Number(flagCount(b.flags) > 0) - Number(flagCount(a.flags) > 0));

  const current = { tab: tab.key === TABS[0].key ? "" : tab.key, ...f, flagged: flagged ? "1" : "" };
  const link = (v: Record<string, string>) => {
    const q = new URLSearchParams(Object.entries(v).filter(([, x]) => x)).toString();
    return `/office/fuel${q ? `?${q}` : ""}`;
  };
  const active = !!(f.from || f.to || f.vehicle || f.q || flagged);

  return (
    <>
      <PageHeader title="ตรวจรายการน้ำมัน" back="/" />
      <ListFilters
        values={f}
        keep={current.tab ? { tab: current.tab } : {}}
        vehicles={vehicles}
        searchLabel="# / ใบกำกับ / คนขับ / คนเติม"
        href={(change) => link(change === null ? { tab: current.tab } : { ...current, ...change })}
        active={active}
      >
        <Field label="ผิดปกติ">
          <select name="flagged" defaultValue={flagged ? "1" : ""} className={inputCls}>
            <option value="">ทั้งหมด</option>
            <option value="1">เฉพาะผิดปกติ</option>
          </select>
        </Field>
      </ListFilters>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link key={t.key} href={link({ ...current, tab: t.key === TABS[0].key ? "" : t.key })} className={chipCls(t.key === tab.key)}>
            {t.label} ({counts[t.status] ?? 0})
          </Link>
        ))}
      </div>
      <Card>
        {list.length ? (
          <Table head={["#", "วันที่", "รถ", "คนขับ", "คนเติม", "ลิตร", "ยอดเงิน", "ผิดปกติ", "สถานะ"]}>
            {list.map((r) => {
              const n = flagCount(r.flags);
              return (
                <tr key={r.id}>
                  <td>
                    <Link href={`/office/fuel/${r.id}`} className="font-semibold text-brand hover:underline">
                      #{r.no}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{thDateTime(r.filledAt ?? r.createdAt)}</td>
                  <td className="whitespace-nowrap">{r.vehicle.code}</td>
                  <td>{driverOf(r)}</td>
                  <td>{r.filler?.name ?? "-"}</td>
                  <td className="whitespace-nowrap text-right">{num(r.liters, 2)}</td>
                  <td className="whitespace-nowrap text-right">{baht(r.amount)}</td>
                  <td>{n > 0 ? <Pill tone="red">{n}</Pill> : "-"}</td>
                  <td>
                    <StatusPill map={FUEL_STATUS} value={r.status} />
                  </td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>{active ? "ไม่พบรายการตามตัวกรอง" : "ไม่มีรายการ"}</Empty>
        )}
        {!!tab.take && list.length === tab.take && <p className="mt-2 text-xs text-muted">แสดง {tab.take} รายการล่าสุด เลือกช่วงวันที่เพื่อดูรายการเก่ากว่านี้</p>}
      </Card>
    </>
  );
}
