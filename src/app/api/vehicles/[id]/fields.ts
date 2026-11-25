import { numOrNull, str } from "@/lib/http";

// The vehicle form's fields: a posted value -> what is stored (text trimmed, numbers "" -> null); undefined =
// invalid (NaN, negative, above max, or not whole where it must be).
const text = (max: number) => (v: unknown) => str(v, max);
const number = (max: number, int = false) => (v: unknown) => {
  const n = numOrNull(v);
  return n === null ? null : Number.isNaN(n) || n < 0 || n > max || (int && !Number.isInteger(n)) ? undefined : n;
};
// Decimal columns as their exact text ("8.3"): Prisma sends a JS number as a 16-digit decimal (8.3 ->
// 8.300000000000001), which never equals the stored 8.30 in the update's guard.
const decimal = (max: number) => (v: unknown) => {
  const n = number(max)(v);
  return typeof n === "number" ? String(n) : n;
};
export const FIELDS = {
  code: text(30),
  model: text(100),
  litersPerHour: decimal(1000),
  tankLiters: decimal(100_000),
  pmEveryHours: number(100_000, true),
  pmLastHours: decimal(1_000_000),
  expressItem: text(20),
  expressDep: text(20),
  note: text(1000),
  active: (v: unknown) => v === "1",
};
export type Value = string | number | boolean | null;
// Equal apart from line ends (a textarea may post \r\n).
const same = (a: Value, b: Value) => (typeof a === "string" && typeof b === "string" ? a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n") : a === b);

// What the user changed on the form: data = the new values, where = the values the page loaded for those fields
// (the update is guarded on them). null = a number is invalid.
export function vehicleChanges(posted: (k: string) => unknown, was: Record<string, unknown>) {
  const data: Record<string, Value> = {};
  const where: Record<string, Value> = {};
  for (const [k, read] of Object.entries(FIELDS)) {
    const now = read(posted(k)), before = read(was[k]);
    if (now === undefined || before === undefined) return null;
    if (!same(now, before)) [data[k], where[k]] = [now, before];
  }
  return { data, where };
}
