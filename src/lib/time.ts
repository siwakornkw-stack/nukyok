// Everything user-facing is Bangkok time; the server may run in UTC.
const TZ = "Asia/Bangkok";

// "2026-11-09" (Bangkok calendar date)
export const bkkDateKey = (d: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);

// 0-23 in Bangkok
export const bkkHour = (d: Date = new Date()) =>
  Number(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(d));

// A Bangkok date key as the UTC-midnight Date that a @db.Date column stores.
export const dateOnly = (key: string) => new Date(`${key}T00:00:00Z`);

// Start of a Bangkok date as an instant (00:00 +07:00).
export const bkkStart = (key: string) => new Date(`${key}T00:00:00+07:00`);

export const isDateKey = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));

export const thDate = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("th-TH", { timeZone: TZ, day: "numeric", month: "short", year: "2-digit" }).format(d) : "-";

export const thDateTime = (d: Date | null | undefined) =>
  d
    ? new Intl.DateTimeFormat("th-TH", { timeZone: TZ, day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d)
    : "-";

export const thTime = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat("th-TH", { timeZone: TZ, hour: "2-digit", minute: "2-digit" }).format(d) : "-";

export const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 3_600_000;

// A shift without ออกงาน stays open (ออกงาน closes it, เข้างาน waits) all through its own Bangkok day
// and for OPEN_SHIFT_HOURS after เข้างาน (a night shift); after both it is ลืมออกงาน.
// /api/attendance runs the same rule as a query.
export const OPEN_SHIFT_HOURS = 16;
export const shiftOpen = (s: { workDate: Date; inAt: Date }, now = new Date()) =>
  s.inAt.getTime() > now.getTime() - OPEN_SHIFT_HOURS * 3_600_000 || s.workDate.getTime() === dateOnly(bkkDateKey(now)).getTime();

// "2026-11" + k months
export const shiftMonth = (ym: string, k: number) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + k, 1)).toISOString().slice(0, 7);

// Quick date ranges for the dashboard and list filters (Bangkok dates, `to` inclusive).
export function rangePresets(today = bkkDateKey()) {
  const m = today.slice(0, 7);
  return [
    { label: "เดือนนี้", from: `${m}-01`, to: today },
    { label: "เดือนที่แล้ว", from: `${shiftMonth(m, -1)}-01`, to: bkkDateKey(new Date(bkkStart(`${m}-01`).getTime() - 1)) },
    { label: "3 เดือน", from: `${shiftMonth(m, -2)}-01`, to: today },
    { label: "ปีนี้", from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
}

// { gte, lt } for a from / to pair of date keys (either may be empty), or undefined when both are.
export function dateRange(from: string, to: string) {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: bkkStart(from) } : {}), ...(to ? { lt: new Date(bkkStart(to).getTime() + 86_400_000) } : {}) };
}
