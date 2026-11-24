import Link from "next/link";
import { prisma } from "@/lib/db";
import { baht, dec, num } from "@/lib/format";
import { FUEL_RULES } from "@/lib/fuel-checks";
import { hasRole } from "@/lib/roles";
import { requirePage } from "@/lib/session";
import { COSTED, vehicleCosts } from "@/lib/summary";
import { bkkDateKey, bkkStart, isDateKey, rangePresets, shiftMonth as shift, thDate } from "@/lib/time";
import { Card, Empty, Field, PageHeader, Table, btnCls, chipCls, inputCls } from "@/components/ui";

const monthStart = (ym: string) => bkkStart(`${ym}-01`);
const dayBefore = (key: string) => bkkDateKey(new Date(bkkStart(key).getTime() - 1));
const shortMonth = (ym: string) => new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", month: "short", year: "2-digit" }).format(monthStart(ym));
const whole = (n: number) => Math.round(n).toLocaleString("th-TH");
const DAY = 86_400_000;
const MAX_DAYS = 400; // the longest range one page load reads

const SORTS = { total: "ต้นทุนรวม", fuel: "ค่าน้ำมัน", repair: "ค่าซ่อม", perHour: "บาท/ชม.", lph: "ลิตร/ชม.", hours: "ชม.ทำงาน" } as const;
type SortKey = keyof typeof SORTS;

function Stat({ label, value, sub, color = "" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-[0_1px_3px_rgb(15_23_42/0.05)]">
      <div className="text-xs text-muted">{label}</div>
      <div className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted">{sub}</div>}
    </div>
  );
}

// Cost per vehicle over a date range: fuel (approved fills by fill time), repairs (saved costs), engine hours
// worked, litres per hour against the vehicle's standard, cost per engine hour, and a 6-month trend.
export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const u = await requirePage(["office", "exec", "accounting"]);
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const today = bkkDateKey();
  const thisMonth = today.slice(0, 7);

  // ?from&to, or ?month=2026-11 from older links; default this month so far
  const month = /^\d{4}-\d{2}$/.test(one("month")) ? one("month") : "";
  let from = isDateKey(one("from")) ? one("from") : month ? `${month}-01` : `${thisMonth}-01`;
  let to = isDateKey(one("to")) ? one("to") : month ? dayBefore(`${shift(month, 1)}-01`) : today;
  if (to < from) [from, to] = [to, from];
  if (bkkStart(to).getTime() - bkkStart(from).getTime() > MAX_DAYS * DAY) from = bkkDateKey(new Date(bkkStart(to).getTime() - MAX_DAYS * DAY));
  const start = bkkStart(from);
  const end = new Date(bkkStart(to).getTime() + DAY);
  const sort: SortKey = one("sort") in SORTS ? (one("sort") as SortKey) : "total";

  const vehicles = await prisma.vehicle.findMany({ select: { id: true, code: true, model: true, active: true, litersPerHour: true }, orderBy: { code: "asc" } });
  const picked = vehicles.some((v) => v.id === one("vehicle")) ? one("vehicle") : "";
  const only = picked ? { vehicleId: picked } : {};
  const trendMonths = Array.from({ length: 6 }, (_, i) => shift(to.slice(0, 7), i - 5)); // oldest first, ends at the month of `to`

  const [fills, before, repairs, trend] = await Promise.all([
    prisma.fuelRequest.findMany({
      where: { status: "approved", filledAt: { gte: start, lt: end }, ...only },
      orderBy: { filledAt: "asc" },
      select: { vehicleId: true, liters: true, amount: true, source: true, engineHours: true, flags: true },
    }),
    // the last checked reading before the range: where the hours worked in it start
    prisma.$queryRaw<{ vehicleId: string; engineHours: { toString(): string } }[]>`
      SELECT DISTINCT ON ("vehicleId") "vehicleId", "engineHours" FROM "FuelRequest"
      WHERE "status" = 'approved' AND "filledAt" < ${start} ORDER BY "vehicleId", "filledAt" DESC`,
    prisma.repairRequest.findMany({
      where: { status: { in: COSTED }, costedAt: { gte: start, lt: end }, ...only },
      orderBy: { costAmount: "desc" },
      select: { id: true, no: true, vehicleId: true, symptom: true, supplierName: true, costAmount: true, costedAt: true, vehicle: { select: { code: true } } },
    }),
    Promise.all(trendMonths.map((m) => vehicleCosts(monthStart(m), monthStart(shift(m, 1))))),
  ]);

  const baseHours = new Map(before.map((b) => [b.vehicleId, dec(b.engineHours) ?? 0]));
  type Agg = { fuel: number; liters: number; pump: number; tank: number; fills: number; flagged: number; repair: number; repairs: number; first?: number; last?: number; firstLiters: number };
  const agg = new Map<string, Agg>();
  const get = (id: string) => {
    let a = agg.get(id);
    if (!a) agg.set(id, (a = { fuel: 0, liters: 0, pump: 0, tank: 0, fills: 0, flagged: 0, repair: 0, repairs: 0, firstLiters: 0 }));
    return a;
  };
  for (const f of fills) {
    const a = get(f.vehicleId);
    const liters = dec(f.liters) ?? 0;
    const amount = dec(f.amount) ?? 0;
    const h = dec(f.engineHours);
    a.fuel += amount;
    a.liters += liters;
    a.fills++;
    if (f.source === "tank") a.tank += amount;
    else a.pump += amount;
    if (Array.isArray(f.flags) && f.flags.length) a.flagged++;
    if (h !== null) {
      if (a.first === undefined) [a.first, a.firstLiters] = [h, liters];
      a.last = h;
    }
  }
  for (const r of repairs) {
    const a = get(r.vehicleId);
    a.repair += dec(r.costAmount) ?? 0;
    a.repairs++;
  }

  const rows = vehicles
    .filter((v) => !picked || v.id === picked)
    .map((v) => {
      const a = agg.get(v.id) ?? get(v.id);
      const base = baseHours.get(v.id);
      const startHours = base ?? a.first;
      const hours = a.last !== undefined && startHours !== undefined ? Math.max(0, a.last - startHours) : 0;
      // without a reading before the range, the first fill's litres went into hours worked before it
      const burnt = base !== undefined ? a.liters : a.liters - a.firstLiters;
      const total = a.fuel + a.repair;
      const std = dec(v.litersPerHour);
      const lph = hours > 0 ? burnt / hours : null;
      return { ...v, ...a, hours, burnt, total, std, lph, perHour: hours > 0 ? total / hours : null, over: lph !== null && !!std && lph > std * (1 + FUEL_RULES.lphTolerance) };
    })
    .filter((r) => picked || r.active || r.total > 0 || r.liters > 0)
    .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || a.code.localeCompare(b.code));

  const sum = rows.reduce(
    (s, r) => ({
      fuel: s.fuel + r.fuel,
      liters: s.liters + r.liters,
      pump: s.pump + r.pump,
      tank: s.tank + r.tank,
      fills: s.fills + r.fills,
      flagged: s.flagged + r.flagged,
      repair: s.repair + r.repair,
      repairs: s.repairs + r.repairs,
      hours: s.hours + r.hours,
      // per-hour figures only from vehicles that have hours worked in the range
      burnt: s.burnt + (r.hours > 0 ? r.burnt : 0),
      costWithHours: s.costWithHours + (r.hours > 0 ? r.total : 0),
    }),
    { fuel: 0, liters: 0, pump: 0, tank: 0, fills: 0, flagged: 0, repair: 0, repairs: 0, hours: 0, burnt: 0, costWithHours: 0 }
  );
  const total = sum.fuel + sum.repair;
  const max = Math.max(0, ...rows.map((r) => r.total));

  const months = trendMonths.map((m, i) => {
    let fuel = 0;
    let repair = 0;
    for (const [id, c] of trend[i]) {
      if (picked && id !== picked) continue;
      fuel += c.fuel;
      repair += c.repair;
    }
    return { m, fuel, repair, total: fuel + repair, inRange: m >= from.slice(0, 7) && m <= to.slice(0, 7) };
  });
  const monthMax = Math.max(0, ...months.map((t) => t.total));

  const href = (p: { from: string; to: string }) =>
    `/office/costs?${new URLSearchParams({ ...p, ...(picked ? { vehicle: picked } : {}), ...(sort !== "total" ? { sort } : {}) })}`;
  const presets = rangePresets(today);
  const range = `${thDate(start)} - ${thDate(new Date(end.getTime() - 1))}`;
  const repairHref = (id: string) => (hasRole(u, "office", "accounting") ? `/purchasing/repairs/${id}` : `/exec/repairs/${id}`);

  return (
    <>
      <PageHeader title="Dashboard ต้นทุนต่อคัน" back="/" />

      <Card>
        <form className="grid grid-cols-2 gap-x-3 sm:grid-cols-[1fr_1fr_1.4fr_1fr_auto] sm:items-end">
          <Field label="ตั้งแต่">
            <input type="date" name="from" defaultValue={from} max={today} className={inputCls} />
          </Field>
          <Field label="ถึง">
            <input type="date" name="to" defaultValue={to} max={today} className={inputCls} />
          </Field>
          <div className="col-span-2 sm:col-span-1">
            <Field label="รถ">
              <select name="vehicle" defaultValue={picked} className={inputCls}>
                <option value="">ทุกคัน</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.code}
                    {v.model ? ` (${v.model})` : ""}
                    {v.active ? "" : " - เลิกใช้"}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="เรียงตาม">
            <select name="sort" defaultValue={sort} className={inputCls}>
              {Object.entries(SORTS).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Field>
          <button className={`${btnCls} mb-4 self-end`}>ดู</button>
        </form>
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <Link key={p.label} href={href(p)} className={chipCls(p.from === from && p.to === to)}>
              {p.label}
            </Link>
          ))}
        </div>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="ต้นทุนรวม (บาท)" value={baht(total)} sub={range} color="text-brand" />
        <Stat label="ค่าน้ำมัน (บาท)" value={baht(sum.fuel)} sub={`ปั๊ม ${whole(sum.pump)} · ถังกลาง ${whole(sum.tank)}`} color="text-[#B7791F]" />
        <Stat label="ค่าซ่อม (บาท)" value={baht(sum.repair)} sub={`${sum.repairs} งาน`} color="text-[#DD5B2B]" />
        <Stat label="ลิตร" value={num(sum.liters)} sub={`เติม ${sum.fills} ครั้ง`} color="text-[#0891B2]" />
        <Stat label="ชม.ทำงาน" value={num(sum.hours)} sub="จากชั่วโมงเครื่อง" />
        <Stat label="ต้นทุนต่อชม. (บาท)" value={sum.hours > 0 ? baht(sum.costWithHours / sum.hours) : "-"} sub="เฉลี่ยคันที่มีชม.ทำงาน" />
        <Stat label="ลิตรต่อชม." value={sum.hours > 0 ? num(sum.burnt / sum.hours, 2) : "-"} sub="เฉลี่ยคันที่มีชม.ทำงาน" />
        <Stat
          label="เติมที่ระบบเตือนผิดปกติ"
          value={`${sum.flagged} ครั้ง`}
          sub={sum.fills ? `${Math.round((sum.flagged / sum.fills) * 100)}% ของการเติม` : undefined}
          color={sum.flagged ? "text-[#B91C1C]" : ""}
        />
      </div>

      <Card title={`ต้นทุนต่อคัน ${range}`}>
        {rows.length ? (
          <Table head={["รถ", "ชม.ทำงาน", "ลิตร", "ลิตร/ชม.", "น้ำมัน (บาท)", "ค่าซ่อม (บาท)", "รวม (บาท)", "บาท/ชม.", ""]}>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap">
                  <Link href={`/office/vehicles/${r.id}`} className="font-semibold text-brand hover:underline">
                    {r.code}
                  </Link>
                  {r.model && <span className="block text-xs text-muted">{r.model}</span>}
                </td>
                <td className="tabular-nums">{r.hours ? num(r.hours) : "-"}</td>
                <td className="tabular-nums">{num(r.liters)}</td>
                <td className="whitespace-nowrap tabular-nums">
                  <span className={r.over ? "font-semibold text-[#B91C1C]" : ""}>{r.lph !== null ? num(r.lph, 2) : "-"}</span>
                  {r.std ? <span className="block text-xs text-muted">มาตรฐาน {num(r.std, 2)}</span> : null}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {baht(r.fuel)}
                  {r.fills > 0 && (
                    <span className="block text-xs text-muted">
                      {r.fills} ครั้ง{r.flagged ? <span className="text-[#B91C1C]"> · ผิดปกติ {r.flagged}</span> : null}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap tabular-nums">
                  {baht(r.repair)}
                  {r.repairs > 0 && <span className="block text-xs text-muted">{r.repairs} งาน</span>}
                </td>
                <td className="font-semibold tabular-nums">{baht(r.total)}</td>
                <td className="tabular-nums">{r.perHour !== null ? baht(r.perHour) : "-"}</td>
                <td className="w-1/5 min-w-24 align-middle">
                  <div className="flex h-2.5 overflow-hidden rounded-full" style={{ width: `${max > 0 ? (r.total / max) * 100 : 0}%` }}>
                    <div className="bg-[#F5B800]" style={{ width: `${r.total ? (r.fuel / r.total) * 100 : 0}%` }} />
                    <div className="flex-1 bg-[#F97316]" />
                  </div>
                </td>
              </tr>
            ))}
            {rows.length > 1 && (
              <tr className="font-semibold">
                <td>รวม</td>
                <td className="tabular-nums">{num(sum.hours)}</td>
                <td className="tabular-nums">{num(sum.liters)}</td>
                <td className="tabular-nums">{sum.hours > 0 ? num(sum.burnt / sum.hours, 2) : "-"}</td>
                <td className="tabular-nums">{baht(sum.fuel)}</td>
                <td className="tabular-nums">{baht(sum.repair)}</td>
                <td className="tabular-nums">{baht(total)}</td>
                <td className="tabular-nums">{sum.hours > 0 ? baht(sum.costWithHours / sum.hours) : "-"}</td>
                <td />
              </tr>
            )}
          </Table>
        ) : (
          <Empty>ยังไม่มีรถ</Empty>
        )}
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#F5B800]" />
            น้ำมัน
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-[#F97316]" />
            ค่าซ่อม
          </span>
          <span className="flex items-center gap-1.5">
            <span className="font-semibold text-[#B91C1C]">ตัวแดง</span> ลิตร/ชม. เกินมาตรฐาน {Math.round(FUEL_RULES.lphTolerance * 100)}%
          </span>
        </div>
        <p className="mt-2 text-xs text-muted">
          น้ำมันนับรายการที่อนุมัติแล้วตามวันที่เติม ค่าซ่อมนับงานที่บันทึกค่าซ่อมแล้วตามวันที่บันทึก ชม.ทำงาน = ชั่วโมงเครื่องครั้งล่าสุดในช่วง
          ลบครั้งล่าสุดก่อนช่วง (ตามที่คนเติมตรวจกับรูปหน้าปัด)
        </p>
      </Card>

      <Card title={`แนวโน้ม 6 เดือน${picked ? ` (${vehicles.find((v) => v.id === picked)?.code})` : " (ทุกคัน)"}`}>
        <div className="flex h-48 items-stretch gap-2 sm:gap-4">
          {months.map((t) => (
            <div key={t.m} className={`flex flex-1 flex-col items-center gap-1.5 ${t.inRange ? "" : "opacity-50"}`}>
              <div className="h-4 text-[10px] tabular-nums text-muted sm:text-xs">{t.total ? whole(t.total) : ""}</div>
              <div className="flex w-full flex-1 items-end justify-center">
                <div
                  className="flex w-full max-w-12 flex-col overflow-hidden rounded-t-lg"
                  style={{ height: `${monthMax > 0 ? Math.max(t.total ? 2 : 0, (t.total / monthMax) * 100) : 0}%` }}
                  title={`น้ำมัน ${baht(t.fuel)} / ค่าซ่อม ${baht(t.repair)}`}
                >
                  <div className="bg-[#F97316]" style={{ height: `${t.total ? (t.repair / t.total) * 100 : 0}%` }} />
                  <div className="flex-1 bg-[#F5B800]" />
                </div>
              </div>
              <div className={`text-xs ${t.inRange ? "font-semibold" : "text-muted"}`}>{shortMonth(t.m)}</div>
            </div>
          ))}
        </div>
        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted">ดูตัวเลข</summary>
          <div className="mt-2">
            <Table head={["เดือน", "น้ำมัน (บาท)", "ค่าซ่อม (บาท)", "รวม (บาท)"]}>
              {months.map((t) => (
                <tr key={t.m}>
                  <td className="whitespace-nowrap">{shortMonth(t.m)}</td>
                  <td className="tabular-nums">{baht(t.fuel)}</td>
                  <td className="tabular-nums">{baht(t.repair)}</td>
                  <td className="tabular-nums">{baht(t.total)}</td>
                </tr>
              ))}
            </Table>
          </div>
        </details>
      </Card>

      <Card title={`ค่าซ่อมในช่วงนี้ (${repairs.length} งาน)`}>
        {repairs.length ? (
          <>
            <Table head={["วันที่", "รถ", "งานซ่อม", "ร้าน / อู่", "ค่าซ่อม (บาท)"]}>
              {repairs.slice(0, 10).map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{thDate(r.costedAt)}</td>
                  <td className="whitespace-nowrap">{r.vehicle.code}</td>
                  <td>
                    <Link href={repairHref(r.id)} className="font-medium text-brand hover:underline">
                      #{r.no}
                    </Link>{" "}
                    {r.symptom}
                  </td>
                  <td>{r.supplierName || "-"}</td>
                  <td className="font-semibold tabular-nums">{baht(r.costAmount)}</td>
                </tr>
              ))}
            </Table>
            {repairs.length > 10 && <p className="mt-2 text-xs text-muted">แสดง 10 งานที่แพงที่สุดจาก {repairs.length} งาน</p>}
          </>
        ) : (
          <Empty>ไม่มีค่าซ่อมในช่วงนี้</Empty>
        )}
      </Card>
    </>
  );
}
