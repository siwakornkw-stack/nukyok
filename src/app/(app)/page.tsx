import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { MENU } from "@/lib/menu";
import { Icon, Notice, type IconName } from "@/components/ui";
import { hasRole } from "@/lib/roles";
import { bkkDateKey, thDateTime } from "@/lib/time";
import { exportToken } from "@/lib/csv";

// Kinds of /api/export (read-only Google Sheets view), each with its own token.
const SHEETS: [string, string][] = [
  ["fuel", "เติมน้ำมัน"],
  ["repairs", "งานซ่อม"],
  ["attendance", "เข้างาน / ออกงาน (ไม่มีพิกัด)"],
  ["vehicles", "ข้อมูลรถ"],
];

const TINT: Partial<Record<IconName, string>> = {
  clock: "bg-[#EFF6FF] text-[#2563EB]",
  fuel: "bg-[#FFF8E1] text-[#B7791F]",
  wrench: "bg-[#FFF1EC] text-[#DD5B2B]",
  list: "bg-[#F5F0FF] text-[#7C3AED]",
  droplet: "bg-[#ECFEFF] text-[#0891B2]",
  check: "bg-[#ECFDF3] text-[#16A34A]",
  calendar: "bg-[#EEF2FF] text-[#4F46E5]",
  truck: "bg-[#F1F5F9] text-[#334155]",
  chart: "bg-[#ECFDF5] text-[#059669]",
  file: "bg-[#F0FDFA] text-[#0D9488]",
  users: "bg-[#FDF2F8] text-[#DB2777]",
};

// Home = the role menu (LIFF links land on /liff first, see src/app/liff).
// Office also sees a recent failed LINE send (src/lib/line.ts), a monthly quota near its limit (cron daily) and the
// Google Sheets formulas of the CSV export (while exportToken gives tokens; a notice while EXPORT_SECRET is refused).
export default async function Home({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const u = await requirePage();
  const items = MENU.filter((m) => m.roles.some((r) => u.roles.includes(r)));
  const office = hasRole(u, "office");
  const base = (process.env.APP_URL || "https://nukyok.phuketnukyok.com").replace(/\/$/, "");
  // No token for any kind while EXPORT_SECRET is unset, or weak in production (exportToken logs each refusal, so one
  // kind is asked first): no formulas ending in "token=" that answer 404.
  const exportOn = office && !!exportToken("fuel");
  const sheets = exportOn ? SHEETS.map(([kind, name]) => [name, `=IMPORTDATA("${base}/api/export/${kind}?token=${exportToken(kind)}")`]) : [];
  const exportRefused = office && !exportOn && !!process.env.EXPORT_SECRET;
  const settings = office ? await prisma.appSetting.findMany({ where: { key: { in: ["line_last_error", "line_quota"] } } }) : [];
  const setting = (key: string) => (settings.find((s) => s.key === key)?.value ?? {}) as Record<string, unknown>;
  const lineErr = setting("line_last_error");
  const errAt = typeof lineErr.at === "string" ? new Date(lineErr.at) : null;
  const errRecent = errAt !== null && new Date().getTime() - errAt.getTime() < 24 * 3_600_000;
  const quota = setting("line_quota");
  // cron daily writes it at 18:05, so until then on the 1st it still holds last month's figure
  const quotaThisMonth = typeof quota.at === "string" && bkkDateKey(new Date(quota.at)).slice(0, 7) === bkkDateKey().slice(0, 7);
  const quotaHigh = quotaThisMonth && typeof quota.limit === "number" && typeof quota.used === "number" && quota.used >= quota.limit * 0.8;
  return (
    <>
      <div className="mb-5">
        <p className="text-sm text-muted">
          {new Intl.DateTimeFormat("th-TH", { timeZone: "Asia/Bangkok", weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(new Date())}
        </p>
        <h1 className="text-2xl font-bold tracking-tight">สวัสดี {u.name.split(" ")[0] || u.displayName}</h1>
      </div>
      {sp.denied && <Notice>ไม่มีสิทธิ์เข้าหน้านั้น</Notice>}
      {errRecent && (
        <Notice tone="danger">
          ส่ง LINE ไม่สำเร็จล่าสุด {thDateTime(errAt)}: {String(lineErr.message ?? "")}
        </Notice>
      )}
      {quotaHigh && (
        <Notice>
          โควตา LINE เดือนนี้ใช้ไป {String(quota.used)}/{String(quota.limit)}
        </Notice>
      )}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {items.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className="group flex min-h-32 flex-col justify-between gap-4 rounded-2xl border border-line bg-card p-4 shadow-[0_1px_3px_rgb(15_23_42/0.05)] transition hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-md active:scale-[0.98]"
          >
            <span className={`grid h-12 w-12 place-items-center rounded-xl ${TINT[m.icon] ?? TINT.truck}`}>
              <Icon name={m.icon} className="h-6 w-6" />
            </span>
            <span className="flex items-end justify-between gap-2 font-semibold leading-snug">
              {/* "งานซ่อม (ใบเสนอราคา / ค่าซ่อม)": the part in brackets as a small second line */}
              <span>
                {m.label.split(" (")[0]}
                {m.label.includes(" (") && <span className="block text-xs font-normal text-muted">{m.label.split(" (")[1].replace(/\)$/, "")}</span>}
              </span>
              <Icon name="next" className="h-4 w-4 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
            </span>
          </Link>
        ))}
      </div>
      {!!sheets.length && (
        <details className="mt-6 rounded-2xl border border-line bg-card p-4 text-sm">
          <summary className="cursor-pointer font-semibold">สูตร Google Sheets (ดูข้อมูลอย่างเดียว)</summary>
          <p className="mt-2 text-muted">
            วางสูตรในช่อง A1 ของชีต สูตรแต่ละอันเปิดได้เฉพาะข้อมูลชุดของตัวเอง และทุกคนที่เปิดชีตได้จะเห็นสูตรนี้ จึงแชร์ชีตให้เฉพาะคนที่ควรเห็นข้อมูลชุดนั้น
          </p>
          <dl className="mt-3 space-y-3">
            {sheets.map(([name, formula]) => (
              <div key={name}>
                <dt className="font-medium">{name}</dt>
                <dd className="mt-1 select-all break-all rounded-lg bg-hover px-2 py-1.5 font-mono text-xs">{formula}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
      {exportRefused && (
        <Notice className="mt-6">
          ปิดการ export ไป Google Sheets อยู่: EXPORT_SECRET ในเซิร์ฟเวอร์สั้นกว่า 16 ตัวอักษร เป็นค่าตัวอย่าง หรือขึ้นต้นด้วย dev- ให้ผู้ดูแลระบบตั้งค่าใหม่ (openssl rand -hex 32) แล้วคัดลอกสูตรใหม่จากหน้านี้
        </Notice>
      )}
      {/* static page in public/ (not a Next route): a plain link */}
      <p className="mt-6 flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
        <a href="/flowchart.html" className="font-medium text-brand hover:underline">
          ดู Flowchart การทำงานแยกตามบทบาท
        </a>
        <Link href="/ai" className="font-medium text-brand hover:underline">
          เชื่อมต่อเลขา AI
        </Link>
      </p>
    </>
  );
}
