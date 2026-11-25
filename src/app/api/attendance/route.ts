import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { apiUser } from "@/lib/session";
import { removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { bkkDateKey, dateOnly, OPEN_SHIFT_HOURS } from "@/lib/time";

// เข้างาน / ออกงาน. FormData: action (in | out), photo, lat, lng.
// Open shift = no ออกงาน yet and today's (Bangkok) shift or clocked in less than OPEN_SHIFT_HOURS ago
// (shiftOpen in lib/time, used by the pages). An older shift without ออกงาน is left as it is (ลืมออกงาน)
// and does not block the next เข้างาน. One shift per person per Bangkok day (unique userId + workDate): once
// today's is in, the next เข้างาน is tomorrow, and the page says so instead of offering it. Every refusal comes
// before the photo is saved, or takes it back off the disk.
const TODAY_IN = "วันนี้กดเข้างานไปแล้ว (บันทึกได้วันละ 1 รอบ)";

export async function POST(req: Request) {
  const a = await apiUser(["driver"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const fd = await readForm(req);
  const action = fd ? formStr(fd, "action", 5) : "";
  if (!fd || (action !== "in" && action !== "out")) return bad("ข้อมูลไม่ถูกต้อง");
  const photo = formFiles(fd, "photo")[0];
  if (!photo) return bad("ต้องแนบรูปถ่าย");
  // GPS is optional; kept only as an in-range pair (NaN fails the range check).
  const lat = formNum(fd, "lat");
  const lng = formNum(fd, "lng");
  const gps = lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  const now = new Date();
  const today = dateOnly(bkkDateKey(now));
  const open = await prisma.attendance.findFirst({
    where: {
      userId: u.id,
      outAt: null,
      OR: [{ inAt: { gt: new Date(now.getTime() - OPEN_SHIFT_HOURS * 3_600_000) } }, { workDate: today }],
    },
    orderBy: { inAt: "desc" },
    select: { id: true },
  });
  if (action === "out" && !open) return bad("ต้องกดเข้างานก่อน");
  if (action === "in") {
    if (await prisma.attendance.findUnique({ where: { userId_workDate: { userId: u.id, workDate: today } }, select: { id: true } })) return bad(TODAY_IN);
    if (open) return bad("ยังไม่ได้ออกงานของรอบก่อน กดออกงานก่อน");
  }

  let key: string;
  try {
    key = await saveUpload(photo, "attendance");
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }

  // After the checks above, no open shift means เข้างาน.
  try {
    if (!open) {
      await prisma.attendance.create({
        data: { userId: u.id, workDate: today, inAt: now, inPhoto: key, inLat: gps ? lat : null, inLng: gps ? lng : null },
      });
    } else {
      const r = await prisma.attendance.updateMany({
        where: { id: open.id, outAt: null },
        data: { outAt: now, outPhoto: key, outLat: gps ? lat : null, outLng: gps ? lng : null },
      });
      if (r.count !== 1) {
        await removeUpload(key);
        return bad("รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
      }
    }
  } catch (e) {
    await removeUpload(key);
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad(TODAY_IN);
    throw e;
  }
  return ok({ redirect: "/driver/attendance" });
}
