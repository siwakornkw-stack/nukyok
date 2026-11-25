import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bad, formNum, formStr, ok, readForm } from "@/lib/http";
import { apiUser } from "@/lib/session";
import { samePlate } from "@/lib/summary";

// "" -> null; NaN, negative, above max or (int) not whole -> undefined = invalid.
function n(fd: FormData, k: string, max: number, int = false) {
  const v = formNum(fd, k);
  if (v === null) return null;
  return Number.isNaN(v) || v < 0 || v > max || (int && !Number.isInteger(v)) ? undefined : v;
}

// Office adds a vehicle (FormData from /office/vehicles).
export async function POST(req: Request) {
  const a = await apiUser(["office"]);
  if ("res" in a) return a.res;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const code = formStr(fd, "code", 30);
  if (!code) return bad("กรอกรหัส / ทะเบียนรถ");
  const nums = {
    litersPerHour: n(fd, "litersPerHour", 1000),
    tankLiters: n(fd, "tankLiters", 100_000),
    pmEveryHours: n(fd, "pmEveryHours", 100_000, true),
    pmLastHours: n(fd, "pmLastHours", 1_000_000),
  };
  if (Object.values(nums).includes(undefined)) return bad("ตัวเลขไม่ถูกต้อง (ต้องไม่ติดลบ และรอบเช็คระยะต้องเป็นจำนวนเต็ม)");
  // one truck, one record: a driver may already have added it as "ผบ 1234" when Office types "ผบ-1234"
  const dup = await samePlate(code);
  if (dup) return bad(`ทะเบียนนี้ซ้ำกับรถ ${dup} ที่มีอยู่แล้ว (ไม่นับตัวพิมพ์เล็ก-ใหญ่ เว้นวรรค จุด และขีด)`);
  try {
    const v = await prisma.vehicle.create({ data: { code, model: formStr(fd, "model", 100), ...nums } });
    return ok({ redirect: `/office/vehicles/${v.id}` });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad("รหัสรถนี้มีแล้ว");
    throw e;
  }
}
