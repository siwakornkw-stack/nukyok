import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, ok, readForm, str } from "@/lib/http";
import { readUpload, removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { readSlip } from "@/lib/slip";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// คนเติม's slip photo, sent as soon as it is taken: kept on the request and read by the AI (lib/slip.ts), so the form
// fills itself. The fill route then compares what is saved with that reading. The answer's `key` names this slip:
// the form posts it back (slipKey), so a save is checked against the slip the filler saw.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["filler"]);
  if ("res" in a) return a.res;
  const id = str((await params).id, 40);
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const file = formFiles(fd, "slip")[0];
  if (!file) return bad("กรุณาถ่ายรูปสลิป");
  const r = await prisma.fuelRequest.findUnique({ where: { id }, select: { status: true, slipPhoto: true } });
  if (!r) return bad("ไม่พบรายการ", 404);
  if (r.status !== "waiting" && r.status !== "returned") return bad(CHANGED);

  let key: string;
  try {
    key = await saveUpload(file, "fuel-slip");
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }
  // Kept before the AI reads it (up to 46 s): from now on the request is being filled, so the driver can no longer
  // cancel it, and the old reading is gone. Only in place of the slip read above (one sent meanwhile from another
  // phone refuses this one). This file goes when it is refused or the write fails (no request shows it); the slip it
  // replaces stays on disk (a returned fill's is the evidence Office reviewed).
  const n = await prisma.fuelRequest.updateMany({
    where: { id, status: { in: ["waiting", "returned"] }, slipPhoto: r.slipPhoto },
    data: { slipPhoto: key, slipRead: Prisma.DbNull },
  }).catch(async (e) => {
    await removeUpload(key);
    throw e;
  });
  if (n.count !== 1) {
    await removeUpload(key);
    return bad(CHANGED);
  }
  const img = await readUpload(key);
  const { read, note } = img ? await readSlip(img.body) : { read: null, note: "" };
  // only onto this slip: another one sent meanwhile (a second phone, another filler) keeps its own reading
  const m = await prisma.fuelRequest.updateMany({
    where: { id, slipPhoto: key, status: { in: ["waiting", "returned"] } },
    data: { slipRead: read ?? Prisma.DbNull },
  });
  if (m.count !== 1) return bad("มีการส่งรูปสลิปอื่นแทนแล้ว หรือรายการถูกเปลี่ยนไปแล้ว รีเฟรชหน้า");
  return ok({ read, note, key });
}
