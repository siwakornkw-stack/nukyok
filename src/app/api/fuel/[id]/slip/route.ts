import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, ok, readForm, str } from "@/lib/http";
import { readUpload, saveUpload, UploadError } from "@/lib/storage";
import { readSlip } from "@/lib/slip";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// คนเติม's slip photo, sent as soon as it is taken: kept on the request and read by the AI (lib/slip.ts), so the form
// fills itself. The fill route then compares what is saved with that reading.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["filler"]);
  if ("res" in a) return a.res;
  const id = str((await params).id, 40);
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const file = formFiles(fd, "slip")[0];
  if (!file) return bad("กรุณาถ่ายรูปสลิป");
  const r = await prisma.fuelRequest.findUnique({ where: { id }, select: { status: true } });
  if (!r) return bad("ไม่พบรายการ", 404);
  if (r.status !== "waiting" && r.status !== "returned") return bad(CHANGED);

  let key: string;
  try {
    key = await saveUpload(file, "fuel-slip");
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }
  const img = await readUpload(key);
  const { read, note } = img ? await readSlip(img.body) : { read: null, note: "" };
  const n = await prisma.fuelRequest.updateMany({
    where: { id, status: { in: ["waiting", "returned"] } },
    data: { slipPhoto: key, slipRead: read ?? Prisma.DbNull },
  });
  if (n.count !== 1) return bad(CHANGED);
  return ok({ read, note });
}
