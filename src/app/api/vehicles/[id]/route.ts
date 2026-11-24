import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getMasters } from "@/lib/express";
import { bad, formNum, formStr, jsonBody, ok, readForm, str } from "@/lib/http";
import { apiUser } from "@/lib/session";
import { latestHours } from "@/lib/summary";

// "" -> null; NaN, negative, above max or (int) not whole -> undefined = invalid.
function n(fd: FormData, k: string, max: number, int = false) {
  const v = formNum(fd, k);
  if (v === null) return null;
  return Number.isNaN(v) || v < 0 || v > max || (int && !Number.isInteger(v)) ? undefined : v;
}

// /office/vehicles/<id>. JSON { action: "pm-done" } (ActionButton, Office or จัดซื้อ) = service done at the
// latest engine hours; FormData (ApiForm, Office only) = save the master fields.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  const a = await apiUser(json ? ["office", "purchasing"] : ["office"]);
  if ("res" in a) return a.res;
  const { id } = await params;

  if (json) {
    if (str((await jsonBody(req)).action) !== "pm-done") return bad("ไม่รู้จักคำสั่งนี้");
    const hours = (await latestHours()).get(id);
    if (hours === undefined) return bad("ยังไม่มีชั่วโมงเครื่องของรถคันนี้");
    const r = await prisma.vehicle.updateMany({ where: { id }, data: { pmLastHours: hours } });
    if (r.count !== 1) return bad("ไม่พบรถคันนี้", 404);
    return ok({ pmLastHours: hours });
  }

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
  const expressItem = formStr(fd, "expressItem", 20);
  let expressDep = formStr(fd, "expressDep", 20);
  if (expressItem) {
    const it = (await getMasters())?.fuel.items.find((i) => i.code === expressItem);
    if (!it) return bad("ไม่พบรหัสน้ำมันนี้ในข้อมูลจาก Express");
    if (!expressDep) expressDep = it.depCode;
  }
  if (expressDep.length > 4) return bad("แผนก Express ยาวเกิน 4 ตัวอักษร");
  try {
    const r = await prisma.vehicle.updateMany({
      where: { id },
      data: {
        code,
        model: formStr(fd, "model", 100),
        ...nums,
        expressItem,
        expressDep,
        active: fd.get("active") === "1",
        note: formStr(fd, "note", 1000),
      },
    });
    if (r.count !== 1) return bad("ไม่พบรถคันนี้", 404);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad("รหัสรถนี้มีแล้ว");
    throw e;
  }
  return ok();
}
