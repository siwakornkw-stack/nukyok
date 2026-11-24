import Link from "next/link";
import { rangePresets } from "@/lib/time";
import { Card, Field, btnCls, chipCls, inputCls } from "./ui";

export type FilterValues = { from: string; to: string; vehicle: string; q: string };

// GET form above a list (office fuel, งานซ่อม): date range with quick ranges, vehicle, free-text search and
// the page's own fields (children). `keep` (e.g. the status tab) rides along; `href` links with other values.
export function ListFilters({
  values,
  keep,
  vehicles,
  searchLabel,
  href,
  active,
  children,
}: {
  values: FilterValues;
  keep: Record<string, string>;
  vehicles: { id: string; code: string; model: string }[];
  searchLabel: string;
  href: (change: Partial<FilterValues> | null) => string; // null = clear every filter
  active: boolean;
  children?: React.ReactNode;
}) {
  return (
    <Card>
      <form className="grid grid-cols-2 gap-x-3 sm:grid-cols-3 lg:grid-cols-6 lg:items-end">
        {Object.entries(keep).map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <Field label="ตั้งแต่">
          <input type="date" name="from" defaultValue={values.from} className={inputCls} />
        </Field>
        <Field label="ถึง">
          <input type="date" name="to" defaultValue={values.to} className={inputCls} />
        </Field>
        <Field label="รถ">
          <select name="vehicle" defaultValue={values.vehicle} className={inputCls}>
            <option value="">ทุกคัน</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.code}
                {v.model ? ` (${v.model})` : ""}
              </option>
            ))}
          </select>
        </Field>
        {children}
        <div className="col-span-2 sm:col-span-1">
          <Field label="ค้นหา">
            <input name="q" defaultValue={values.q} maxLength={50} placeholder={searchLabel} className={inputCls} />
          </Field>
        </div>
        <button className={`${btnCls} col-span-2 mb-4 sm:col-span-1 lg:self-end`}>ค้นหา</button>
      </form>
      <div className="flex flex-wrap items-center gap-2">
        {rangePresets().map((p) => (
          <Link key={p.label} href={href({ from: p.from, to: p.to })} className={chipCls(p.from === values.from && p.to === values.to)}>
            {p.label}
          </Link>
        ))}
        {active && (
          <Link href={href(null)} className="ml-auto text-sm font-medium text-brand hover:underline">
            ล้างตัวกรอง
          </Link>
        )}
      </div>
    </Card>
  );
}
