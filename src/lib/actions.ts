import "server-only";
import { prisma } from "./db";
import { appLink, notifyOfficeGroup, notifyRoles, notifyUsers } from "./line";
import { queueFuelExpress } from "./express";
import { dec, driverOf, num } from "./format";
import { URGENCY } from "@/components/ui";

// Steps shared by the app's routes and the เลขา AI API (/api/ai/*), so both follow the same rules and send
// the same LINE messages. The caller checked the role; `actor` is who is recorded as having done it.
export type Actor = { id: string; name: string };
export type Result = { error: string; status?: number } | { data: Record<string, unknown> };

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// Office / ผู้บริหาร: approve a filled request (queues the Express PK + H3), return it to the filler, or cancel it.
export async function reviewFuel(actor: Actor, id: string, action: string, note: string): Promise<Result> {
  const now = new Date();
  if (action === "approve") {
    const result = await prisma.$transaction(async (tx) => {
      const n = await tx.fuelRequest.updateMany({ where: { id, status: "filled" }, data: { status: "approved", reviewedBy: actor.name, reviewedAt: now } });
      if (n.count !== 1) return null;
      // read after the guarded write: exactly the values that were approved
      const f = await tx.fuelRequest.findUniqueOrThrow({ where: { id }, include: { vehicle: { select: { expressItem: true, expressDep: true } } } });
      return queueFuelExpress(
        tx,
        {
          id,
          source: f.source,
          supplierCode: f.supplierCode,
          invoice: f.invoice,
          liters: dec(f.liters) ?? 0,
          pricePerLiter: dec(f.pricePerLiter) ?? 0,
          amount: dec(f.amount) ?? 0,
          filledAt: f.filledAt ?? now,
          vehicle: f.vehicle,
        },
        actor.name
      );
    });
    if (!result) return { error: CHANGED };
    return { data: { express: result.queued ? "queued" : result.reason, ...(result.queued ? {} : { notice: `อนุมัติแล้ว ไม่ได้ส่งเข้า Express: ${result.reason}` }) } };
  }

  if (action !== "return" && action !== "cancel") return { error: "คำสั่งไม่ถูกต้อง" };
  if (!note) return { error: "ต้องกรอกเหตุผล" };

  if (action === "return") {
    const n = await prisma.fuelRequest.updateMany({
      where: { id, status: "filled" },
      data: { status: "returned", returnNote: note, reviewedBy: actor.name, reviewedAt: now },
    });
    if (n.count !== 1) return { error: CHANGED };
    const r = await prisma.fuelRequest.findUniqueOrThrow({ where: { id }, select: { no: true, fillerId: true } });
    if (r.fillerId) await notifyUsers([r.fillerId], `ส่งกลับให้แก้ไข เติมน้ำมัน #${r.no}: ${note}\n${appLink(`/filler/${id}`)}`);
    return { data: {} };
  }

  const n = await prisma.fuelRequest.updateMany({
    where: { id, status: { in: ["waiting", "filled", "returned"] } },
    data: { status: "cancelled", returnNote: note, reviewedBy: actor.name, reviewedAt: now },
  });
  if (n.count !== 1) return { error: CHANGED };
  const r = await prisma.fuelRequest.findUniqueOrThrow({ where: { id }, select: { no: true, driverId: true } });
  await notifyUsers([r.driverId], `ยกเลิกคำขอเติมน้ำมัน #${r.no}: ${note}`);
  return { data: {} };
}

// ผู้บริหาร decides on the quotation. quotedAt names the quotation that was seen: a newer one makes this fail.
export async function decideRepair(actor: Actor, id: string, approve: boolean, note: string, quotedAt: Date): Promise<Result> {
  if (!approve && !note) return { error: "กรอกเหตุผลที่ไม่อนุมัติ" };
  const r = await prisma.repairRequest.findUnique({ where: { id }, select: { no: true, driverId: true, vehicle: { select: { code: true } } } });
  if (!r) return { error: "ไม่พบรายการ", status: 404 };
  const res = await prisma.repairRequest.updateMany({
    where: { id, status: "approval", quotedAt },
    data: { status: approve ? "approved" : "rejected", decidedBy: actor.name, decidedAt: new Date(), decisionNote: note },
  });
  if (res.count !== 1) return { error: CHANGED };

  if (approve) {
    await notifyRoles(["purchasing"], `อนุมัติซ่อม #${r.no} แล้ว ลงรายละเอียดค่าซ่อม\n${appLink(`/purchasing/repairs/${id}`)}`);
  } else {
    // Purchasing too: a rejected job can get a new quotation (e.g. a re-quote while the garage is already working).
    const msg = `ไม่อนุมัติซ่อม #${r.no} รถ ${r.vehicle.code}: ${note}\n`;
    await notifyUsers([r.driverId], msg + appLink("/driver/my"));
    await notifyRoles(["purchasing"], msg + appLink(`/purchasing/repairs/${id}`));
  }
  return { data: {} };
}

const LEVELS = ["urgent", "normal", "canwait"];

// What a driver form says about the vehicle and who drove. vehicleId "new" = not in the list: newCode / newModel typed.
export type DriverForm = { vehicleId: string; newCode?: string; newModel?: string; driverName?: string };

// The listed vehicle, or the typed plate: the same as a listed one ignoring case, spaces, dashes and dots is that
// vehicle; otherwise it is added for Office to complete (L/h, tank, service, Express code). `added` = just added.
async function pickVehicle(x: DriverForm, by: string): Promise<{ error: string } | { id: string; code: string; model: string; added: boolean }> {
  const select = { id: true, code: true, model: true };
  if (x.vehicleId !== "new") {
    const v = x.vehicleId ? await prisma.vehicle.findFirst({ where: { id: x.vehicleId, active: true }, select }) : null;
    return v ? { ...v, added: false } : { error: "กรุณาเลือกรถ" };
  }
  const code = (x.newCode ?? "").replace(/\s+/g, " ").trim(), model = (x.newModel ?? "").trim();
  if (!code || code.length > 30) return { error: "กรอกทะเบียน / รหัสรถ ไม่เกิน 30 ตัวอักษร" };
  if (!model || model.length > 100) return { error: "กรอกรุ่นรถ ไม่เกิน 100 ตัวอักษร" };
  const key = (s: string) => s.toUpperCase().replace(/[\s.-]/g, "");
  // ponytail: reads every vehicle to compare plates loosely; fine for a fleet, a normalized column if it ever is not
  const same = (await prisma.vehicle.findMany({ select: { ...select, active: true } })).find((v) => key(v.code) === key(code));
  if (same) return same.active ? { id: same.id, code: same.code, model: same.model, added: false } : { error: `รถ ${same.code} ถูกปิดใช้งานแล้ว ติดต่อ Office` };
  const v = await prisma.vehicle.upsert({ where: { code }, create: { code, model, note: `คนขับเพิ่มเอง (${by})` }, update: {}, select });
  return { ...v, added: true };
}

// Office completes a vehicle a driver added (told once the request it came with is saved).
const announceVehicle = (v: { id: string; code: string; model: string; added: boolean }, by: string) =>
  v.added && notifyOfficeGroup(`คนขับเพิ่มรถใหม่: ${v.code} (${v.model}) โดย ${by}\nกรอก ลิตร/ชม., ความจุถัง, รอบเช็คระยะ และรหัส Express\n${appLink(`/office/vehicles/${v.id}`)}`);

// The name typed on the form, kept only when it is not the sender's own.
const typedDriver = (actor: Actor, typed = "") => {
  const t = typed.replace(/\s+/g, " ").trim();
  return t && t !== actor.name ? t : "";
};

// คนขับแจ้งซ่อม -> quote. `upload` saves the photos once everything else checked out.
export async function openRepair(
  actor: Actor,
  x: DriverForm & { symptom: string; cause: string; odometer: number | null; pmRound: string; urgency: string; fromPm: boolean },
  upload: () => Promise<string[]>
): Promise<Result> {
  if (x.symptom.length < 3 || x.symptom.length > 1000) return { error: "กรอกอาการ 3-1000 ตัวอักษร" };
  if (x.cause.length > 1000) return { error: "สาเหตุยาวเกิน 1000 ตัวอักษร" };
  if (Number.isNaN(x.odometer) || (x.odometer !== null && (x.odometer < 0 || x.odometer >= 1e10))) return { error: "ไมค์ / ชั่วโมงเครื่อง ไม่ถูกต้อง" };
  if (x.pmRound.length > 100) return { error: "รอบเช็คระยะยาวเกิน 100 ตัวอักษร" };
  if (!LEVELS.includes(x.urgency)) return { error: "เลือกระดับความเร่งด่วน" };
  const driverName = typedDriver(actor, x.driverName);
  const by = driverOf({ driverName, driver: actor });
  const vehicle = await pickVehicle(x, by);
  if ("error" in vehicle) return vehicle;

  const photos = await upload();
  const r = await prisma.repairRequest.create({
    data: { driverId: actor.id, driverName, vehicleId: vehicle.id, symptom: x.symptom, cause: x.cause, odometer: x.odometer, pmRound: x.pmRound, photos, urgency: x.urgency, fromPm: x.fromPm },
  });
  await announceVehicle(vehicle, by);

  const noPhoto = photos.length ? "" : " (แจ้งผ่านเลขา AI ไม่มีรูป)";
  await notifyRoles(
    ["purchasing"],
    `แจ้งซ่อม #${r.no} รถ ${vehicle.code} (${URGENCY[x.urgency][0]})${noPhoto}\nอาการ: ${x.symptom}\n${appLink(`/purchasing/repairs/${r.id}`)}`
  );
  if (x.urgency === "urgent") {
    await notifyRoles(["exec"], `ด่วน รถหยุดงาน: แจ้งซ่อม #${r.no} รถ ${vehicle.code}\nอาการ: ${x.symptom}\n${appLink(`/exec/repairs/${r.id}`)}`);
  }
  return { data: { id: r.id, no: r.no } };
}

// คนขับ asks for fuel -> the fillers are told. `upload` saves the dashboard photo ("" = none, via เลขา AI) and the
// odometer photo (null = no odometer typed).
export async function requestFuel(
  actor: Actor,
  x: DriverForm & { hours: number | null; odometer?: number | null },
  upload: () => Promise<{ dashPhoto: string; odoPhoto: string | null }>
): Promise<Result> {
  if (x.hours === null || !(x.hours > 0 && x.hours < 1_000_000)) return { error: "กรอกชั่วโมงเครื่องให้ถูกต้อง" };
  const odometer = x.odometer ?? null;
  if (odometer !== null && !(odometer >= 0 && odometer < 100_000_000)) return { error: "เลขไมค์ไม่ถูกต้อง" };
  const driverName = typedDriver(actor, x.driverName);
  const by = driverOf({ driverName, driver: actor });
  const vehicle = await pickVehicle(x, by);
  if ("error" in vehicle) return vehicle;
  const { dashPhoto, odoPhoto } = await upload();
  const r = await prisma.fuelRequest.create({
    data: { driverId: actor.id, driverName, vehicleId: vehicle.id, engineHours: x.hours, driverHours: x.hours, driverOdometer: odometer, dashPhoto, odoPhoto },
  });
  const odo = odometer === null ? "" : ` ไมค์ ${num(odometer)}`;
  await notifyRoles(
    ["filler"],
    `ขอเติมน้ำมัน #${r.no} รถ ${vehicle.code} ชม.เครื่อง ${num(x.hours)}${odo} โดย ${by}${dashPhoto ? "" : " ไม่มีรูปหน้าปัด"}\n${appLink(`/filler/${r.id}`)}`
  );
  await announceVehicle(vehicle, by);
  return { data: { id: r.id, no: r.no, vehicleId: vehicle.id } };
}
