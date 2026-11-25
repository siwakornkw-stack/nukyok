import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { appLink, notifyOfficeGroup, notifyRoles, notifyUsers } from "./line";
import { getMasters, queueFuelExpress, type ExpressMasters } from "./express";
import { dec, driverOf, num } from "./format";
import { flagCodes, fuelFlags, invoiceKey, replacement, slipFlags, type FuelFlag, type SlipRead } from "./fuel-checks";
import { removeUpload } from "./storage";
import { plateKey } from "./summary";
import { bkkDateKey } from "./time";
import { URGENCY } from "@/components/ui";

// Steps shared by the app's routes and the เลขา AI API (/api/ai/*), so both follow the same rules and send
// the same LINE messages. The caller checked the role; `actor` is who is recorded as having done it.
export type Actor = { id: string; name: string };
export type Result = { error: string; status?: number } | { data: Record<string, unknown> };

const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า";

// One fill as the automatic checks see it: the one being saved, or a saved one checked again.
export type Fill = {
  id: string;
  vehicleId: string;
  driverId: string;
  createdAt: Date;
  driverHours: number | null;
  driverOdometer: number | null;
  vehicle: { code: string; litersPerHour: number | null; tankLiters: number | null };
  read: SlipRead | null; // the AI reading of its slip (pump fills)
  liters: number;
  pricePerLiter: number | null;
  amount: number | null;
  engineHours: number;
  odometer: number | null;
  supplierCode: string;
  invoice: string;
  invoiceDate: string; // YYYY-MM-DD; "" for a central-tank fill
  at: Date; // filledAt
};

type Row = Prisma.FuelRequestGetPayload<{ include: { vehicle: true } }>;

// A saved fill as the checks see it (rows saved before the invoice date was asked: the fill date, as Express books them).
export const fillOf = (r: Row): Fill => ({
  id: r.id,
  vehicleId: r.vehicleId,
  driverId: r.driverId,
  createdAt: r.createdAt,
  driverHours: dec(r.driverHours),
  driverOdometer: dec(r.driverOdometer),
  vehicle: { code: r.vehicle.code, litersPerHour: dec(r.vehicle.litersPerHour), tankLiters: dec(r.vehicle.tankLiters) },
  read: r.source === "pump" ? (r.slipRead as SlipRead | null) : null,
  liters: dec(r.liters) ?? 0,
  pricePerLiter: dec(r.pricePerLiter),
  amount: dec(r.amount),
  engineHours: dec(r.engineHours) ?? 0,
  odometer: dec(r.odometer),
  supplierCode: r.supplierCode,
  invoice: r.invoice,
  invoiceDate: r.source !== "pump" ? "" : r.invoiceDate ? r.invoiceDate.toISOString().slice(0, 10) : bkkDateKey(r.filledAt ?? r.createdAt),
  at: r.filledAt ?? r.createdAt,
});

export const fuelAlertText = (no: number, code: string, flags: FuelFlag[], id: string) =>
  `แจ้งเตือนผิดปกติ เติมน้ำมัน #${no} รถ ${code}\n${flags.map((f) => `- ${f.text}`).join("\n")}\n${appLink(`/office/fuel/${id}`)}`;

// The vehicle's fill before `at`, the baseline of a fill's checks: a returned one too (it was really filled then).
const prevFill = (db: Prisma.TransactionClient, vehicleId: string, id: string, at: Date) =>
  db.fuelRequest.findFirst({
    where: { vehicleId, id: { not: id }, status: { in: ["filled", "returned", "approved"] }, filledAt: { lt: at } },
    orderBy: { filledAt: "desc" },
    select: { no: true, status: true, engineHours: true, odometer: true, filledAt: true },
  });

// The other pump fill matching `where` that holds the same purchase as f (replacement()): a replacement tax invoice
// and the one it cancels, either way round. Booking both books the purchase and claims its VAT twice. Looked up by
// the last 4 characters of the invoice keys, then compared whole.
async function replacementPair(db: Prisma.TransactionClient, f: { id: string; invoice: string; replaces: string }, where: Prisma.FuelRequestWhereInput) {
  const mine = invoiceKey(f.invoice), theirs = invoiceKey(f.replaces);
  const or: Prisma.FuelRequestWhereInput[] = [];
  if (theirs.length >= 6) or.push({ invoice: { endsWith: theirs.slice(-4), mode: "insensitive" } });
  if (mine.length >= 6) or.push({ slipRead: { path: ["replaces"], string_ends_with: mine.slice(-4) } });
  if (!or.length) return null;
  const rows = await db.fuelRequest.findMany({
    where: { AND: [where, { id: { not: f.id }, source: "pump", OR: or }] },
    select: { no: true, invoice: true, slipRead: true },
  });
  for (const o of rows) {
    const how = replacement(f, { invoice: o.invoice, replaces: (o.slipRead as SlipRead | null)?.replaces ?? "" });
    if (how) return { no: o.no, how };
  }
  return null;
}

// The automatic checks (ตรวจอัตโนมัติ): against the vehicle's previous fill and the hours its drivers clocked in
// since, the same invoice on another request, the slip and its tax IDs, and the other request of a replacement tax
// invoice.
export async function checkFill(f: Fill, m: ExpressMasters | null): Promise<FuelFlag[]> {
  // A fill Office returned is still the baseline (it was really filled then), flagged as such: this fill cannot be
  // approved until that one is corrected or cancelled, and is checked again then (recheckNext).
  const prev = await prevFill(prisma, f.vehicleId, f.id, f.at);
  let workedHours: number | null = null;
  if (prev?.filledAt) {
    const from = prev.filledAt.getTime();
    // Whoever drove it: the drivers who asked fuel for this vehicle in the last 30 days.
    // ponytail: no vehicle on attendance; a regular driver's hours on another vehicle make the check lenient.
    const drivers = await prisma.fuelRequest.findMany({
      where: { vehicleId: f.vehicleId, createdAt: { gte: new Date(f.at.getTime() - 30 * 86_400_000) } },
      distinct: ["driverId"],
      select: { driverId: true },
    });
    const shifts = await prisma.attendance.findMany({
      where: { userId: { in: [...new Set([f.driverId, ...drivers.map((d) => d.driverId)])] }, inAt: { lt: f.at }, OR: [{ outAt: null }, { outAt: { gt: prev.filledAt } }] },
      select: { inAt: true, outAt: true },
    });
    // only the part of each shift inside [previous fill, this fill]; a shift never clocked out counts at most 14 h
    workedHours = shifts.reduce((sum, s) => {
      const start = Math.max(s.inAt.getTime(), from);
      const end = Math.min(s.outAt ? s.outAt.getTime() : s.inAt.getTime() + 14 * 3_600_000, f.at.getTime());
      return sum + Math.max(0, end - start) / 3_600_000;
    }, 0);
  }
  const flags = fuelFlags({
    liters: f.liters,
    pricePerLiter: f.pricePerLiter,
    amount: f.amount,
    engineHours: f.engineHours,
    odometer: f.odometer,
    at: f.at,
    vehicle: f.vehicle,
    prev: prev?.filledAt ? { engineHours: dec(prev.engineHours)!, odometer: dec(prev.odometer), at: prev.filledAt } : null,
    workedHours,
    asked: { engineHours: f.driverHours, odometer: f.driverOdometer, at: f.createdAt },
  });
  if (prev?.status === "returned")
    flags.push({ code: "prev_returned", text: `เทียบกับการเติมครั้งก่อน #${prev.no} ที่ Office ส่งกลับแก้ไขอยู่: อนุมัติได้เมื่อแก้หรือยกเลิก #${prev.no} แล้ว ระบบตรวจรายการนี้ซ้ำให้` });
  // the same tax invoice on another request: a slip used twice
  const twin = f.invoice
    ? await prisma.fuelRequest.findFirst({ where: { id: { not: f.id }, invoice: f.invoice, status: { not: "cancelled" } }, select: { no: true } })
    : null;
  if (twin) flags.push({ code: "invoice_dup", text: `เลขที่ใบกำกับ ${f.invoice} ซ้ำกับคำขอ #${twin.no}` });
  // the buyer must be the company (COMPANY_TAX_ID), the seller the pump picked (its tax ID in the Express masters)
  const company = (process.env.COMPANY_TAX_ID ?? "").replace(/\D/g, "");
  flags.push(
    ...slipFlags(f.read, {
      liters: f.liters,
      pricePerLiter: f.pricePerLiter,
      amount: f.amount,
      invoice: f.invoice,
      invoiceDate: f.invoiceDate,
      vehicleCode: f.vehicle.code,
      date: bkkDateKey(f.at),
      companyTaxId: company.length === 13 ? company : "",
      supplierTaxId: (m?.fuel.suppliers.find((s) => s.code === f.supplierCode)?.taxId ?? "").replace(/\D/g, ""),
    })
  );
  // one purchase on two requests: only one of them is booked (reviewFuel holds the approval of the other)
  const replaces = f.read?.replaces ?? "";
  const pair = await replacementPair(prisma, { id: f.id, invoice: f.invoice, replaces }, { status: { not: "cancelled" } });
  if (pair)
    flags.push({
      code: "replace_pair",
      text:
        pair.how === "replaces"
          ? `ใบกำกับนี้ออกแทนใบเลขที่ ${replaces} ของคำขอ #${pair.no}: ซื้อครั้งเดียวกัน ลงบัญชีได้ใบเดียว (กันลงบัญชีและเคลมภาษีซ้ำ)`
          : `ใบกำกับ ${f.invoice} ถูกยกเลิกและออกใบแทนแล้วในคำขอ #${pair.no}: ซื้อครั้งเดียวกัน ลงบัญชีได้ใบเดียว (กันลงบัญชีและเคลมภาษีซ้ำ)`,
    });
  return flags;
}

// The fill at `at` was returned, corrected or cancelled: the vehicle's next fill had been checked against its old
// figures. That one is checked again while it waits for Office (one already approved stays as approved), and Office
// hears of findings it did not have. A page that showed the old flags can no longer approve it (flagCodes).
export async function recheckNext(vehicleId: string, id: string, at: Date, m: ExpressMasters | null) {
  const next = await prisma.fuelRequest.findFirst({
    where: { vehicleId, id: { not: id }, status: { in: ["filled", "returned", "approved"] }, filledAt: { gt: at } },
    orderBy: { filledAt: "asc" },
    include: { vehicle: true },
  });
  if (next?.status !== "filled") return;
  const flags = await checkFill(fillOf(next), m);
  // reviewedAt: not returned and filled again meanwhile (that save ran its own checks)
  const n = await prisma.fuelRequest.updateMany({ where: { id: next.id, status: "filled", reviewedAt: next.reviewedAt }, data: { flags } });
  const had = new Set((Array.isArray(next.flags) ? next.flags : []).map((f) => (f as FuelFlag | null)?.code));
  const added = flags.filter((f) => !had.has(f.code));
  if (n.count === 1 && added.length) await notifyOfficeGroup(fuelAlertText(next.no, next.vehicle.code, added, next.id));
}

// Office / ผู้บริหาร: approve a filled request (queues the Express PK + H3), return it to the filler, or cancel it.
// seen: the version the approver looked at, its reviewedAt (null = never returned; every return sets it) and the codes
// of the flags shown (flagCodes; a re-check changes them): a fill returned and filled again, or checked again, after
// the page was made cannot be approved from it. The AI route passes the version it reads and pins the amount instead.
// Held (not approved) while the vehicle's previous fill is sent back, or while the other request of a replacement tax
// invoice is approved (that one is cancelled first). Cancel takes a waiting, filled or returned request, and an
// approved one the office PC has nothing of to write (no order, its order cancelled, or keyed in Express by hand).
export async function reviewFuel(actor: Actor, id: string, action: string, note: string, seen: { reviewedAt: Date | null; flags: string }): Promise<Result> {
  const now = new Date();
  if (action === "approve") {
    const result = await prisma.$transaction(async (tx) => {
      const f = await tx.fuelRequest.findUnique({ where: { id }, include: { vehicle: { select: { expressItem: true, expressDep: true } } } });
      if (!f || f.status !== "filled" || f.reviewedAt?.getTime() !== seen.reviewedAt?.getTime() || flagCodes(f.flags) !== seen.flags) return null;
      // Its checks compared it with the vehicle's previous fill: one sent back may hold the wrong readings. It is
      // checked again once that one is corrected or cancelled (recheckNext).
      const prev = f.filledAt ? await prevFill(tx, f.vehicleId, id, f.filledAt) : null;
      if (prev?.status === "returned")
        return { held: `การเติมครั้งก่อนของรถคันนี้ #${prev.no} ถูกส่งกลับแก้ไขอยู่ รายการนี้ตรวจเทียบกับตัวเลขของ #${prev.no}: อนุมัติได้เมื่อแก้หรือยกเลิก #${prev.no} แล้ว (ระบบตรวจรายการนี้ซ้ำให้)` };
      // One purchase on two requests (a replacement tax invoice and the one it cancels): only one is booked and
      // counted in the costs. The other one holds this one while it is approved, whatever its Express order: it is
      // cancelled first (below, once nothing of it is in Express).
      const replaces = (f.slipRead as SlipRead | null)?.replaces ?? "";
      const pair = f.source === "pump" ? await replacementPair(tx, { id, invoice: f.invoice, replaces }, { status: "approved" }) : null;
      if (pair)
        return {
          held:
            pair.how === "replaces"
              ? `ใบกำกับนี้ออกแทนใบเลขที่ ${replaces} ของคำขอ #${pair.no} ที่อนุมัติแล้ว ซื้อครั้งเดียวกัน ลงบัญชีได้ใบเดียว: จะลงใบนี้แทน ให้ยกเลิกเอกสารของ #${pair.no} ใน Express (ถ้ามี) และกดยกเลิกรายการ Express ของ #${pair.no} ที่หน้า Express ก่อน (ถ้ามี ยกเว้นรายการที่คีย์เองแล้ว: ยกเลิกไปพร้อมคำขอ) แล้วยกเลิกคำขอ #${pair.no} ที่หน้าเติมน้ำมัน #${pair.no} จากนั้นจึงอนุมัติรายการนี้ ถ้าไม่ใช้ใบนี้ ให้ยกเลิกรายการนี้`
              : `ใบกำกับ ${f.invoice} ของรายการนี้ถูกยกเลิกและออกใบแทนแล้วในคำขอ #${pair.no} ที่อนุมัติแล้ว ซื้อครั้งเดียวกัน ลงบัญชีได้ใบเดียว: ให้ยกเลิกรายการนี้`,
        };
      // Guarded on the version read above: a filled fill changes only by a return (which sets reviewedAt) or a
      // re-check (flags), so what is queued below is exactly what was approved.
      const n = await tx.fuelRequest.updateMany({
        where: { id, status: "filled", reviewedAt: seen.reviewedAt, flags: { equals: f.flags as Prisma.InputJsonValue } },
        data: { status: "approved", reviewedBy: actor.name, reviewedAt: now },
      });
      if (n.count !== 1) return null;
      return queueFuelExpress(
        tx,
        {
          id,
          source: f.source,
          supplierCode: f.supplierCode,
          invoice: f.invoice,
          invoiceDate: f.invoiceDate,
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
    if ("held" in result) return { error: result.held };
    if (!result.queued) return { data: { express: result.reason, notice: `อนุมัติแล้ว ไม่ได้ส่งเข้า Express: ${result.reason}` } };
    return { data: { express: "queued", ...(result.note ? { notice: `อนุมัติแล้ว: ${result.note}` } : {}) } };
  }

  if (action !== "return" && action !== "cancel") return { error: "คำสั่งไม่ถูกต้อง" };
  if (!note) return { error: "ต้องกรอกเหตุผล" };

  if (action === "return") {
    const n = await prisma.fuelRequest.updateMany({
      where: { id, status: "filled" },
      data: { status: "returned", returnNote: note, reviewedBy: actor.name, reviewedAt: now },
    });
    if (n.count !== 1) return { error: CHANGED };
    const r = await prisma.fuelRequest.findUniqueOrThrow({ where: { id }, select: { no: true, fillerId: true, vehicleId: true, filledAt: true } });
    if (r.fillerId) await notifyUsers([r.fillerId], `ส่งกลับให้แก้ไข เติมน้ำมัน #${r.no}: ${note}\n${appLink(`/filler/${id}`)}`);
    // the vehicle's next fill was checked against these readings: flagged, and held from approval until they are fixed
    if (r.filledAt) await recheckNext(r.vehicleId, id, r.filledAt, await getMasters());
    return { data: {} };
  }

  const r = await prisma.fuelRequest.findUnique({
    where: { id },
    select: {
      no: true,
      status: true,
      driverId: true,
      fillerId: true,
      vehicleId: true,
      filledAt: true,
      vehicle: { select: { code: true } },
      express: { select: { status: true, error: true } },
    },
  });
  if (!r) return { error: "ไม่พบรายการ", status: 404 };
  // An approved fill (e.g. the one a replacement tax invoice takes the place of) only while the office PC has nothing
  // of it to write: no order, its order cancelled, or keyed in Express by hand ("manual": that order is cancelled with
  // it, staff void the PK / H3 in Express). Cancelled, it leaves the costs and no longer holds the other one.
  const approved = r.status === "approved";
  const o = r.express;
  if (approved && o && o.status !== "cancelled" && o.status !== "manual")
    return { error: `เติมน้ำมัน #${r.no} อนุมัติแล้วและมีรายการ Express อยู่: ยกเลิกเอกสารใน Express (ถ้ามี) และกดยกเลิกรายการนั้นที่หน้า Express ก่อน แล้วจึงยกเลิกคำขอนี้` };
  if (!approved && !["waiting", "filled", "returned"].includes(r.status)) return { error: CHANGED };
  const data = { status: "cancelled", returnNote: note, reviewedBy: actor.name, reviewedAt: now };
  const done = !approved
    ? (await prisma.fuelRequest.updateMany({ where: { id, status: r.status }, data })).count === 1
    : await prisma.$transaction(async (tx) => {
        // An order inserted for it meanwhile (/api/express/queue-fuel) holds a key-share lock on this row (its foreign
        // key) until it commits: FOR UPDATE waits for it, then the guard below (a new snapshot) sees that order and
        // refuses. queue-fuel must take this lock before it reads the fill, or one that read it before this commits
        // still inserts its order after.
        await tx.$queryRaw`SELECT 1 FROM "FuelRequest" WHERE "id" = ${id} FOR UPDATE`;
        const n = await tx.fuelRequest.updateMany({ where: { id, status: "approved", express: o ? { is: { status: o.status } } : { is: null } }, data });
        if (n.count !== 1) return false;
        if (o?.status !== "manual") return true;
        const m = await tx.expressOrder.updateMany({
          where: { fuelRequestId: id, status: "manual" },
          data: { status: "cancelled", error: `ยกเลิกพร้อมคำขอโดย ${actor.name}: ${note} (เดิม ${o.error || "คีย์ใน Express เอง"})` },
        });
        // nothing changes a manual order: never expected, it rolls the cancel back
        if (m.count !== 1) throw new Error(`fuel request ${id}: its manual Express order changed`);
        return true;
      });
  if (!done) return { error: CHANGED };
  await notifyUsers([r.driverId], `ยกเลิกคำขอเติมน้ำมัน #${r.no}: ${note}`);
  // Every filler was sent a waiting request, and a returned one waits on its filler: they hear it is off.
  if (r.status === "waiting") await notifyRoles(["filler"], `ยกเลิกคำขอเติมน้ำมัน #${r.no} รถ ${r.vehicle.code} ไม่ต้องเติม: ${note}`);
  if (r.status === "returned" && r.fillerId) await notifyUsers([r.fillerId], `ยกเลิกคำขอเติมน้ำมัน #${r.no} รถ ${r.vehicle.code} ไม่ต้องแก้ไข: ${note}`);
  // a filled one was the baseline of the vehicle's next fill: that one is checked again against the fill before it
  if (r.filledAt) await recheckNext(r.vehicleId, id, r.filledAt, await getMasters());
  if (approved && o?.status === "manual") return { data: { notice: `ยกเลิกแล้ว: PK / H3 ของ #${r.no} ที่คีย์ไว้เองยังอยู่ใน Express ให้ยกเลิกเอกสารนั้นใน Express ด้วย` } };
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
  // ponytail: reads every vehicle to compare plates loosely; fine for a fleet, a normalized column if it ever is not
  const same = (await prisma.vehicle.findMany({ select: { ...select, active: true } })).find((v) => plateKey(v.code) === plateKey(code));
  if (same) return same.active ? { id: same.id, code: same.code, model: same.model, added: false } : { error: `รถ ${same.code} ถูกปิดใช้งานแล้ว ติดต่อ Office` };
  const v = await prisma.vehicle.upsert({ where: { code }, create: { code, model, note: `คนขับเพิ่มเอง (${by})` }, update: {}, select });
  return { ...v, added: true };
}

// Office completes a vehicle a driver added, told as soon as it is added: the request it came with may still be
// refused (a missing photo), and once the driver sends again the plate is found as an existing vehicle.
const announceVehicle = (v: { id: string; code: string; model: string; added: boolean }, by: string) =>
  v.added && notifyOfficeGroup(`คนขับเพิ่มรถใหม่: ${v.code} (${v.model}) โดย ${by}\nกรอก ลิตร/ชม., ความจุถัง, รอบเช็คระยะ และรหัส Express\n${appLink(`/office/vehicles/${v.id}`)}`);

// The name typed on the form, kept only when it is not the sender's own.
const typedDriver = (actor: Actor, typed = "") => {
  const t = typed.replace(/\s+/g, " ").trim();
  return t && t !== actor.name ? t : "";
};

// คนขับแจ้งซ่อม -> quote. `upload` saves the photos once everything else checked out (and takes back the ones it
// saved when one of them is refused); a report that cannot be stored takes them back too.
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
  await announceVehicle(vehicle, by);

  const photos = await upload();
  const r = await prisma.repairRequest.create({
    data: { driverId: actor.id, driverName, vehicleId: vehicle.id, symptom: x.symptom, cause: x.cause, odometer: x.odometer, pmRound: x.pmRound, photos, urgency: x.urgency, fromPm: x.fromPm },
  }).catch(async (e) => {
    await Promise.all(photos.map(removeUpload)); // no report points to them
    throw e;
  });

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
// odometer photo (null = no odometer typed); a request that cannot be stored takes them back.
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
  await announceVehicle(vehicle, by);
  const { dashPhoto, odoPhoto } = await upload();
  const r = await prisma.fuelRequest.create({
    data: { driverId: actor.id, driverName, vehicleId: vehicle.id, engineHours: x.hours, driverHours: x.hours, driverOdometer: odometer, dashPhoto, odoPhoto },
  }).catch(async (e) => {
    await Promise.all([dashPhoto, odoPhoto ?? ""].map(removeUpload)); // no request points to them
    throw e;
  });
  const odo = odometer === null ? "" : ` ไมค์ ${num(odometer)}`;
  await notifyRoles(
    ["filler"],
    `ขอเติมน้ำมัน #${r.no} รถ ${vehicle.code} ชม.เครื่อง ${num(x.hours)}${odo} โดย ${by}${dashPhoto ? "" : " ไม่มีรูปหน้าปัด"}\n${appLink(`/filler/${r.id}`)}`
  );
  return { data: { id: r.id, no: r.no, vehicleId: vehicle.id } };
}
