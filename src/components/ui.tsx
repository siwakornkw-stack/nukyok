import Link from "next/link";
import { fileUrl } from "@/lib/storage-url";

// Server-safe presentational pieces. Status colours follow the flowchart legend.

// Stroke icons, 24x24 (paths from Lucide, ISC licence).
const ICONS = {
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  fuel: '<path d="M3 22h12"/><path d="M4 9h10"/><path d="M14 22V4a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v18"/><path d="M14 13h2a2 2 0 0 1 2 2v2a2 2 0 0 0 4 0V9.83a2 2 0 0 0-.59-1.42L18 5"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  list: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
  droplet: '<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>',
  check: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
  calendar: '<rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/><path d="m9 16 2 2 4-4"/>',
  truck:
    '<path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.62l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 13h8"/><path d="M8 17h8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  next: '<path d="m9 18 6-6-6-6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  pin: '<path d="M20 10c0 4.99-5.54 10.19-7.4 11.8a1 1 0 0 1-1.2 0C9.54 20.19 4 14.99 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
};
export type IconName = keyof typeof ICONS;

export function Icon({ name, className = "h-5 w-5" }: { name: IconName; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

// The app mark (header, login).
export function Logo({ className = "h-9 w-9" }: { className?: string }) {
  return (
    <span className={`grid shrink-0 place-items-center rounded-xl bg-linear-to-br from-brand to-[#4f46e5] text-white shadow-sm ${className}`}>
      <Icon name="truck" className="h-[55%] w-[55%]" />
    </span>
  );
}

export function AuthShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-linear-to-b from-brand-soft to-bg">
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <Logo className="h-14 w-14" />
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        </div>
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, back, children }: { title: string; back?: string; children?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      {back && (
        <Link
          href={back}
          aria-label="กลับ"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line bg-card text-muted shadow-sm transition hover:bg-hover hover:text-ink"
        >
          <Icon name="back" />
        </Link>
      )}
      <h1 className="min-w-0 flex-1 text-xl font-bold tracking-tight sm:text-2xl">{title}</h1>
      {children}
    </div>
  );
}

export function Card({ title, children, className = "" }: { title?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={`mb-4 rounded-2xl border border-line bg-card p-4 shadow-[0_1px_3px_rgb(15_23_42/0.05)] sm:p-5 ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-muted">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-hover">
        <Icon name="inbox" className="h-6 w-6" />
      </span>
      <p>{children}</p>
    </div>
  );
}

// Callout for warnings / errors / hints.
const NOTICE = {
  warn: "border-[#FCD34D] bg-[#FFFBEB] text-[#78350F]",
  danger: "border-[#FCA5A5] bg-[#FEF2F2] text-[#7F1D1D]",
  info: "border-[#BFDBFE] bg-[#EFF6FF] text-[#1E3A8A]",
};
export function Notice({ tone = "warn", className = "", children }: { tone?: keyof typeof NOTICE; className?: string; children: React.ReactNode }) {
  return (
    <div role={tone === "danger" ? "alert" : undefined} className={`mb-4 flex gap-2.5 rounded-xl border px-3.5 py-2.5 text-sm ${NOTICE[tone]} ${className}`}>
      <Icon name={tone === "info" ? "info" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

// Label + value rows for detail views.
export function Info({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="break-words font-medium">{v ?? "-"}</dd>
        </div>
      ))}
    </dl>
  );
}

const TONES = {
  yellow: ["bg-[#FFF8E1] text-[#8A5A00] ring-[#F5B800]/30", "bg-[#F5B800]"],
  blue: ["bg-[#EFF6FF] text-[#1E40AF] ring-[#3B82F6]/25", "bg-[#3B82F6]"],
  orange: ["bg-[#FFF3E8] text-[#9A3412] ring-[#F97316]/25", "bg-[#F97316]"],
  green: ["bg-[#ECFDF3] text-[#166534] ring-[#22C55E]/25", "bg-[#22C55E]"],
  gray: ["bg-[#F1F5F9] text-[#475569] ring-[#94A3B8]/30", "bg-[#94A3B8]"],
  purple: ["bg-[#F5F0FF] text-[#5B21B6] ring-[#8B5CF6]/25", "bg-[#8B5CF6]"],
  red: ["bg-[#FEF2F2] text-[#991B1B] ring-[#EF4444]/25", "bg-[#EF4444]"],
  pink: ["bg-[#FDF2F8] text-[#9D174D] ring-[#EC4899]/25", "bg-[#EC4899]"],
} as const;
export type Tone = keyof typeof TONES;

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const [cls, dot] = TONES[tone];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${cls}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {children}
    </span>
  );
}

export const FUEL_STATUS: Record<string, [string, Tone]> = {
  waiting: ["รอเติม", "yellow"],
  filled: ["เติมแล้ว", "blue"],
  returned: ["ส่งกลับแก้ไข", "orange"],
  approved: ["อนุมัติแล้ว", "green"],
  cancelled: ["ยกเลิก", "gray"],
};

export const REPAIR_STATUS: Record<string, [string, Tone]> = {
  quote: ["รอใบเสนอราคา", "yellow"],
  approval: ["รออนุมัติ", "purple"],
  rejected: ["ไม่อนุมัติ", "red"],
  approved: ["อนุมัติแล้ว รอค่าซ่อม", "purple"],
  repairing: ["กำลังซ่อม", "blue"],
  done: ["ซ่อมเสร็จ รอตรวจรับ", "pink"],
  closed: ["ปิดงาน", "green"],
  cancelled: ["ยกเลิก", "gray"],
};

export const URGENCY: Record<string, [string, Tone]> = {
  urgent: ["ด่วน (รถหยุดงาน)", "red"],
  normal: ["ปกติ", "blue"],
  canwait: ["รอได้", "gray"],
};

export function StatusPill({ map, value }: { map: Record<string, [string, Tone]>; value: string }) {
  const [label, tone] = map[value] ?? [value, "gray"];
  return <Pill tone={tone}>{label}</Pill>;
}

// Filter tabs above a list (status / problem filters).
export const chipCls = (active: boolean) =>
  `whitespace-nowrap rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
    active ? "bg-brand text-white shadow-sm" : "bg-card text-ink ring-1 ring-inset ring-line hover:bg-hover"
  }`;

// Thumbnails of stored photos / PDFs, each opening the full file.
export function Files({ keys }: { keys: (string | null | undefined)[] }) {
  const list = keys.filter((k): k is string => !!k);
  if (!list.length) return <span className="text-muted">-</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {list.map((k) =>
        k.endsWith(".pdf") ? (
          <a
            key={k}
            href={fileUrl(k)}
            target="_blank"
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-xl border border-line bg-hover text-xs font-semibold text-muted transition hover:text-ink"
          >
            <Icon name="file" className="h-6 w-6" />
            PDF
          </a>
        ) : (
          <a key={k} href={fileUrl(k)} target="_blank" className="overflow-hidden rounded-xl border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fileUrl(k)} alt="" loading="lazy" decoding="async" className="h-20 w-20 object-cover transition hover:scale-105" />
          </a>
        )
      )}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            {head.map((h) => (
              <th key={h} className="whitespace-nowrap px-2.5 py-2.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-line [&>tr:last-child]:border-0 [&>tr:hover]:bg-hover/60 [&_td]:px-2.5 [&_td]:py-2.5 [&_td]:align-top">
          {children}
        </tbody>
      </table>
    </div>
  );
}

export const inputCls =
  "w-full rounded-xl border border-line bg-card px-3.5 py-2.5 text-base outline-none transition placeholder:text-muted/60 focus:border-brand focus:ring-4 focus:ring-brand/15 disabled:bg-hover";
export const btnCls =
  "rounded-xl bg-brand px-4 py-3 text-center font-semibold text-white shadow-sm transition hover:bg-brand-dark active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100";
export const btn2Cls =
  "rounded-xl border border-line bg-card px-4 py-3 text-center font-medium text-ink transition hover:bg-hover active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
