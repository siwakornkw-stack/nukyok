import { prisma } from "@/lib/db";
import { VAT_FILED_KEY } from "@/lib/express";
import { bad, formStr, ok, readForm } from "@/lib/http";
import { apiUser } from "@/lib/session";
import { bkkDateKey } from "@/lib/time";

// Office: the last month whose VAT return (ภ.พ.30) is filed (FormData { month: "YYYY-MM" }, a month before this one).
// Bills of that month or earlier no longer book their input VAT automatically (vatMonthClosed).
export async function POST(req: Request) {
  const a = await apiUser(["office"]);
  if ("res" in a) return a.res;
  const fd = await readForm(req, 100_000);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const month = formStr(fd, "month", 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month >= bkkDateKey().slice(0, 7)) return bad("เลือกเดือนก่อนเดือนนี้");
  await prisma.appSetting.upsert({ where: { key: VAT_FILED_KEY }, update: { value: month }, create: { key: VAT_FILED_KEY, value: month } });
  return ok();
}
