import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { removeUpload, saveUpload, UploadError } from "@/lib/storage";
import { notifyOfficeGroup } from "@/lib/line";
import { getMasters } from "@/lib/express";
import { checkFill, fillOf, fuelAlertText, recheckNext } from "@/lib/actions";
import { invoiceDateError, type SlipRead } from "@/lib/fuel-checks";
import { dateOnly } from "@/lib/time";
import { Prisma } from "@prisma/client";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// คนเติม records the fill (or fixes one Office returned); the auto checks (checkFill in lib/actions) run here.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const a = await apiUser(["filler"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const { id } = await params;
  const fd = await readForm(req);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const r = await prisma.fuelRequest.findUnique({ where: { id }, include: { vehicle: true } });
  if (!r) return bad("ไม่พบรายการ", 404);
  if (r.status !== "waiting" && r.status !== "returned") return bad(CHANGED);

  // slips print 3 decimals; kept to 2 like the Express PK / H3 writer (scripts/express) books them
  const typedLiters = formNum(fd, "liters");
  const liters = typedLiters === null ? null : Math.round(typedLiters * 100) / 100;
  const price = formNum(fd, "pricePerLiter");
  let amount = formNum(fd, "amount");
  const odometer = formNum(fd, "odometer");
  const engineHours = formNum(fd, "engineHours"); // read again by the filler at the pump (the driver's stays in driverHours)
  const source = formStr(fd, "source");
  if (engineHours === null || !(engineHours > 0 && engineHours < 1_000_000)) return bad("กรอกชั่วโมงเครื่องให้ถูกต้อง");
  if (liters === null || !(liters > 0 && liters <= 5000)) return bad("จำนวนลิตรต้องมากกว่า 0 และไม่เกิน 5,000");
  if (source !== "pump" && source !== "tank") return bad("กรุณาเลือกแหล่งน้ำมัน");
  if (price !== null && !(price > 0 && price < 1000)) return bad("ราคาต่อลิตรไม่ถูกต้อง");
  if (amount !== null && !(amount > 0 && amount < 10_000_000)) return bad("ยอดเงินไม่ถูกต้อง");
  if (odometer !== null && !(odometer >= 0 && odometer < 100_000_000)) return bad("เลขไมค์ไม่ถูกต้อง");
  if (odometer === null && r.driverOdometer !== null) return bad("คนขับแจ้งเลขไมค์ไว้ กรอกเลขไมค์ตอนเติมด้วย");
  const fillDash = formFiles(fd, "fillDash")[0];
  if (!fillDash && !r.fillDashPhoto) return bad("กรุณาถ่ายรูปหน้าปัดตอนเติม");
  const slip = formFiles(fd, "slip")[0];
  // The slip this form was filled against (SlipInput's slipKey): "sending" while a new one is still on its way, another
  // key when a newer one was sent meanwhile (a second phone, another filler). A slip attached to this form replaces it.
  if (!slip) {
    const seen = formStr(fd, "slipKey", 100);
    if (seen === "sending") return bad("รอให้ส่งรูปสลิปเสร็จก่อน แล้วกดบันทึกอีกครั้ง");
    if (seen !== (r.slipPhoto ?? "")) return bad("รูปสลิปถูกเปลี่ยนไปแล้ว รีเฟรชหน้าแล้วตรวจตัวเลขอีกครั้ง");
  }
  if (source === "pump") {
    if (price === null || amount === null) return bad("เติมจากปั๊ม ต้องกรอกราคาต่อลิตรและยอดเงิน");
    if (!slip && !r.slipPhoto) return bad("กรุณาถ่ายรูปสลิป");
  } else if (price === null) return bad("เติมจากถังกลาง ต้องกรอกราคาต่อลิตร");
  // a central-tank fill without the amount is costed at litres x price
  if (amount === null) amount = Math.round(liters * price * 100) / 100;
  // The date on the tax invoice: Express books the PK / H3 on it. A central-tank fill has no invoice.
  const invoiceDate = source === "pump" ? formStr(fd, "invoiceDate", 10) : "";
  const dateError = source === "pump" ? invoiceDateError(invoiceDate) : null;
  if (dateError) return bad(dateError);

  const supplierCode = formStr(fd, "supplierCode", 20);
  let supplierName = formStr(fd, "supplierName", 120);
  const m = await getMasters();
  if (supplierCode) {
    const s = m?.fuel.suppliers.find((x) => x.code === supplierCode);
    if (!s) return bad("ไม่พบปั๊มนี้ในรายการ Express");
    supplierName = s.name;
  }
  const invoice = formStr(fd, "invoice", 40);

  // A fill Office returned keeps the time it was really filled (Express bill date of older rows, clock checks).
  const at = r.status === "returned" && r.filledAt ? r.filledAt : new Date();
  const flags = await checkFill(
    {
      ...fillOf(r),
      // the AI reading belongs to the slip sent to /slip; a slip attached here instead has not been read
      read: source === "pump" && !slip ? (r.slipRead as SlipRead | null) : null,
      liters,
      pricePerLiter: price,
      amount,
      engineHours,
      odometer,
      supplierCode,
      invoice,
      invoiceDate,
      at,
    },
    m
  );

  // The photos sent with the form, saved last and kept only by the save below: one refused, or the save refused or
  // failed, takes back every photo saved for it (no request shows them). The ones a save replaces stay on disk (those
  // of a returned fill are the evidence Office reviewed).
  const fresh: string[] = [];
  const takeBack = () => Promise.all(fresh.map(removeUpload));
  let slipPhoto = r.slipPhoto, fillDashPhoto = r.fillDashPhoto;
  try {
    if (slip) fresh.push((slipPhoto = await saveUpload(slip, "fuel-slip")));
    if (fillDash) fresh.push((fillDashPhoto = await saveUpload(fillDash, "fuel-dash")));
  } catch (e) {
    await takeBack();
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }

  const n = await prisma.fuelRequest.updateMany({
    // slipPhoto: still the slip these checks read (one sent meanwhile makes the filler check and save again)
    where: { id: r.id, status: r.status, slipPhoto: r.slipPhoto },
    data: {
      status: "filled",
      fillerId: u.id,
      filledAt: at,
      liters,
      pricePerLiter: price,
      amount,
      source,
      supplierCode,
      supplierName,
      invoice,
      invoiceDate: invoiceDate ? dateOnly(invoiceDate) : null,
      ...(slip ? { slipPhoto, slipRead: Prisma.DbNull } : {}),
      odometer,
      engineHours,
      fillDashPhoto,
      flags,
    },
  }).catch(async (e) => {
    await takeBack();
    throw e;
  });
  if (n.count !== 1) {
    await takeBack();
    return bad(CHANGED);
  }

  if (flags.length) await notifyOfficeGroup(fuelAlertText(r.no, r.vehicle.code, flags, r.id));
  if (r.status === "returned") await recheckNext(r.vehicleId, r.id, at, m);
  return ok({ redirect: "/filler" });
}
