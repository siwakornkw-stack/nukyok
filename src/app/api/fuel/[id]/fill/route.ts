import { prisma } from "@/lib/db";
import { apiUser } from "@/lib/session";
import { bad, formFiles, formNum, formStr, ok, readForm } from "@/lib/http";
import { saveUpload, UploadError } from "@/lib/storage";
import { appLink, notifyOfficeGroup } from "@/lib/line";
import { getMasters } from "@/lib/express";
import { dec } from "@/lib/format";
import { fuelFlags, slipFlags, type SlipRead } from "@/lib/fuel-checks";
import { bkkDateKey } from "@/lib/time";
import { Prisma } from "@prisma/client";

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// คนเติม records the fill (or fixes one Office returned); the auto checks run here.
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
  if (source === "pump") {
    if (price === null || amount === null) return bad("เติมจากปั๊ม ต้องกรอกราคาต่อลิตรและยอดเงิน");
    if (!slip && !r.slipPhoto) return bad("กรุณาถ่ายรูปสลิป");
  } else if (price === null) return bad("เติมจากถังกลาง ต้องกรอกราคาต่อลิตร");
  // a central-tank fill without the amount is costed at litres x price
  if (amount === null) amount = Math.round(liters * price * 100) / 100;

  const supplierCode = formStr(fd, "supplierCode", 20);
  let supplierName = formStr(fd, "supplierName", 120);
  if (supplierCode) {
    const s = (await getMasters())?.fuel.suppliers.find((x) => x.code === supplierCode);
    if (!s) return bad("ไม่พบปั๊มนี้ในรายการ Express");
    supplierName = s.name;
  }

  let slipPhoto = r.slipPhoto, fillDashPhoto = r.fillDashPhoto;
  try {
    if (slip) slipPhoto = await saveUpload(slip, "fuel-slip");
    if (fillDash) fillDashPhoto = await saveUpload(fillDash, "fuel-dash");
  } catch (e) {
    if (e instanceof UploadError) return bad(e.message);
    throw e;
  }

  // Compare with the vehicle's previous fill and the driver's clock-in hours since then.
  // A fill Office returned keeps the time it was really filled (Express bill date, clock checks).
  const now = r.status === "returned" && r.filledAt ? r.filledAt : new Date();
  const prev = await prisma.fuelRequest.findFirst({
    where: { vehicleId: r.vehicleId, id: { not: r.id }, status: { in: ["filled", "returned", "approved"] }, filledAt: { lt: now } },
    orderBy: { filledAt: "desc" },
    select: { engineHours: true, odometer: true, filledAt: true },
  });
  let workedHours: number | null = null;
  if (prev?.filledAt) {
    const from = prev.filledAt.getTime();
    // Whoever drove it: the drivers who asked fuel for this vehicle in the last 30 days.
    // ponytail: no vehicle on attendance; a regular driver's hours on another vehicle make the check lenient.
    const drivers = await prisma.fuelRequest.findMany({
      where: { vehicleId: r.vehicleId, createdAt: { gte: new Date(now.getTime() - 30 * 86_400_000) } },
      distinct: ["driverId"],
      select: { driverId: true },
    });
    const shifts = await prisma.attendance.findMany({
      where: { userId: { in: [...new Set([r.driverId, ...drivers.map((d) => d.driverId)])] }, inAt: { lt: now }, OR: [{ outAt: null }, { outAt: { gt: prev.filledAt } }] },
      select: { inAt: true, outAt: true },
    });
    // only the part of each shift inside [previous fill, now]; a shift never clocked out counts at most 14 h
    workedHours = shifts.reduce((sum, s) => {
      const start = Math.max(s.inAt.getTime(), from);
      const end = Math.min(s.outAt ? s.outAt.getTime() : s.inAt.getTime() + 14 * 3_600_000, now.getTime());
      return sum + Math.max(0, end - start) / 3_600_000;
    }, 0);
  }
  // the same tax invoice on another request: a slip used twice
  const invoice = formStr(fd, "invoice", 40);
  const twin = invoice
    ? await prisma.fuelRequest.findFirst({ where: { id: { not: r.id }, invoice, status: { not: "cancelled" } }, select: { no: true } })
    : null;
  const flags = fuelFlags({
    liters,
    pricePerLiter: price,
    amount,
    engineHours,
    odometer,
    at: now,
    vehicle: { litersPerHour: dec(r.vehicle.litersPerHour), tankLiters: dec(r.vehicle.tankLiters) },
    prev: prev?.filledAt ? { engineHours: dec(prev.engineHours)!, odometer: dec(prev.odometer), at: prev.filledAt } : null,
    workedHours,
    asked: { engineHours: dec(r.driverHours), odometer: dec(r.driverOdometer), at: r.createdAt },
  });
  if (twin) flags.push({ code: "invoice_dup", text: `เลขที่ใบกำกับ ${invoice} ซ้ำกับคำขอ #${twin.no}` });
  // the AI reading belongs to the slip sent to /slip; a slip attached here instead has not been read
  flags.push(
    ...slipFlags(source === "pump" && !slip ? (r.slipRead as SlipRead | null) : null, {
      liters: typedLiters!,
      pricePerLiter: price,
      amount,
      invoice,
      vehicleCode: r.vehicle.code,
      date: bkkDateKey(now),
    })
  );

  const n = await prisma.fuelRequest.updateMany({
    where: { id: r.id, status: r.status },
    data: {
      status: "filled",
      fillerId: u.id,
      filledAt: now,
      liters,
      pricePerLiter: price,
      amount,
      source,
      supplierCode,
      supplierName,
      invoice,
      slipPhoto,
      ...(slip ? { slipRead: Prisma.DbNull } : {}),
      odometer,
      engineHours,
      fillDashPhoto,
      flags,
    },
  });
  if (n.count !== 1) return bad(CHANGED);

  if (flags.length)
    await notifyOfficeGroup(
      `แจ้งเตือนผิดปกติ เติมน้ำมัน #${r.no} รถ ${r.vehicle.code}\n${flags.map((f) => `- ${f.text}`).join("\n")}\n${appLink(`/office/fuel/${r.id}`)}`
    );
  return ok({ redirect: "/filler" });
}
