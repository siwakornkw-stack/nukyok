import { baht, dec, num } from "@/lib/format";
import { hoursBetween } from "@/lib/time";

// Thresholds of the automatic checks on a fuel fill (ตรวจอัตโนมัติ).
export const FUEL_RULES = {
  lphTolerance: 0.2, // litres per engine hour may exceed the vehicle standard by this fraction
  minHoursBetweenFills: 6, // two fills of one vehicle closer than this (clock hours) are flagged
  tankTolerance: 0.05, // litres may exceed the tank size by this fraction (meter / hose)
  maxKmPerHour: 120, // the odometer cannot grow faster than this per clock hour since the last fill
  amountTolerance: 1, // baht: litres x price may be this far from the amount paid
  readingSlackHours: 0.5, // the filler's engine hours may exceed the driver's by the clock time between them + this
  readingSlackKm: 5, // the filler's odometer may exceed the driver's by maxKmPerHour x that time + this
};

export type FuelFlag = { code: string; text: string };

const signed = (n: number) => `${n > 0 ? "+" : ""}${num(Math.round(n * 10) / 10)}`;

// The reading at the pump next to what the driver typed: "1,236.5 (คนขับแจ้ง 1,235 ต่าง +1.5)".
export function readingText(atPump: { toString(): string } | null, driver: { toString(): string } | null) {
  const p = dec(atPump), d = dec(driver);
  if (p === null) return "-";
  return d === null ? num(p) : `${num(p)} (คนขับแจ้ง ${num(d)} ต่าง ${signed(p - d)})`;
}

// Findings on one fill, compared with the vehicle standard and its previous fill.
// Each check runs only when its inputs exist.
export function fuelFlags(input: {
  liters: number;
  pricePerLiter: number | null;
  amount: number | null;
  engineHours: number;
  odometer: number | null;
  at: Date;
  vehicle: { litersPerHour: number | null; tankLiters: number | null };
  prev: { engineHours: number; odometer: number | null; at: Date } | null;
  workedHours: number | null;
  // what the driver typed when asking; engineHours / odometer above are what the filler read at the pump
  asked: { engineHours: number | null; odometer: number | null; at: Date } | null;
}): FuelFlag[] {
  const { liters, pricePerLiter, amount, engineHours, odometer, at, vehicle, prev, workedHours, asked } = input;
  const R = FUEL_RULES;
  const flags: FuelFlag[] = [];
  const add = (code: string, text: string) => flags.push({ code, text });

  // Meters only go up, and only as fast as the clock (hours) or the vehicle (km) between the two readings.
  if (asked) {
    const clock = hoursBetween(asked.at, at);
    if (asked.engineHours !== null) {
      const d = engineHours - asked.engineHours;
      if (d < 0 || d > clock + R.readingSlackHours)
        add("hours_driver", `ชั่วโมงเครื่องตอนเติม ${num(engineHours)} ต่างจากที่คนขับแจ้ง ${num(asked.engineHours)} (${signed(d)} ชม. ห่างกัน ${num(clock)} ชม.)`);
    }
    if (asked.odometer !== null && odometer !== null) {
      const d = odometer - asked.odometer;
      if (d < 0 || d > R.maxKmPerHour * clock + R.readingSlackKm)
        add("odo_driver", `เลขไมค์ตอนเติม ${num(odometer)} ต่างจากที่คนขับแจ้ง ${num(asked.odometer)} (${signed(d)} กม. ห่างกัน ${num(clock)} ชม.)`);
    }
  }

  if (pricePerLiter !== null && amount !== null) {
    const calc = Math.round(liters * pricePerLiter * 100) / 100;
    if (Math.abs(calc - amount) > R.amountTolerance)
      add("amount_mismatch", `ยอดเงินไม่ตรงกับ ลิตร × ราคาต่อลิตร (คำนวณได้ ${baht(calc)} บาท กรอกไว้ ${baht(amount)} บาท)`);
  }
  if (vehicle.tankLiters && liters > vehicle.tankLiters * (1 + R.tankTolerance))
    add("over_tank", `เติม ${num(liters, 2)} ลิตร เกินขนาดถัง ${num(vehicle.tankLiters, 2)} ลิตร`);

  if (prev) {
    const clock = hoursBetween(prev.at, at);
    const dh = engineHours - prev.engineHours;
    if (dh < 0) add("hours_back", `ชั่วโมงเครื่องย้อนหลัง (${num(engineHours)} น้อยกว่าครั้งก่อน ${num(prev.engineHours)})`);
    if (dh > clock) add("hours_jump", `ชั่วโมงเครื่องเพิ่ม ${num(dh)} ชม. แต่เวลาผ่านไปเพียง ${num(clock)} ชม. นับจากเติมครั้งก่อน`);
    if (odometer !== null && prev.odometer !== null) {
      const dk = odometer - prev.odometer;
      if (dk < 0) add("odo_back", `เลขไมค์ย้อนหลัง (${num(odometer)} น้อยกว่าครั้งก่อน ${num(prev.odometer)})`);
      if (dk > R.maxKmPerHour * clock)
        add("odo_jump", `เลขไมค์เพิ่ม ${num(dk)} กม. ใน ${num(clock)} ชม. (เกิน ${R.maxKmPerHour} กม./ชม.)`);
    }
    if (dh === 0 && liters > 0) add("hours_same", `ชั่วโมงเครื่องเท่าครั้งก่อน (${num(engineHours)}) แต่เติม ${num(liters, 2)} ลิตร`);
    if (dh > 0 && vehicle.litersPerHour) {
      const lph = liters / dh;
      if (lph > vehicle.litersPerHour * (1 + R.lphTolerance))
        add("lph_high", `ใช้น้ำมัน ${num(lph, 2)} ลิตร/ชม. เกินมาตรฐาน ${num(vehicle.litersPerHour, 2)} ลิตร/ชม.`);
    }
    // 1 h of slack: meter rounding, warming up before clock-in
    if (workedHours !== null && dh > workedHours + 1)
      add("hours_over_work", `ชั่วโมงเครื่อง (+${num(dh)}) เกินชั่วโมงทำงานจริงจากเข้า-ออกงาน (${num(workedHours)} ชม.)`);
    if (clock < R.minHoursBetweenFills)
      add("too_frequent", `เติมถี่เกินไป ห่างจากครั้งก่อน ${num(clock)} ชม. (น้อยกว่า ${R.minHoursBetweenFills} ชม.)`);
  }
  return flags;
}

// What the AI read from a slip photo (src/lib/slip.ts): text as printed, "" / null when not readable.
export type SlipRead = {
  invoice: string;
  replaces: string; // the earlier invoice a replacement slip cancels
  date: string; // YYYY-MM-DD
  plate: string;
  liters: number | null;
  pricePerLiter: number | null;
  amount: number | null;
  station: string;
  buyerTaxId: string;
};

const slipText = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const slipNum = (v: unknown) => {
  const n = Number(slipText(v, 30).replace(/,/g, ""));
  return slipText(v, 30) && Number.isFinite(n) && n > 0 ? n : null;
};

// The model's JSON answer -> SlipRead; null when it is not JSON or holds nothing a slip would.
export function parseSlip(raw: string): SlipRead | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const j = o as Record<string, unknown>;
  // a Buddhist-era year the model did not convert
  const d = slipText(j.date, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const read: SlipRead = {
    invoice: slipText(j.invoice, 40),
    replaces: slipText(j.replaces, 40),
    date: d ? `${Number(d[1]) > 2400 ? Number(d[1]) - 543 : d[1]}-${d[2]}-${d[3]}` : "",
    plate: slipText(j.plate, 40),
    liters: slipNum(j.liters),
    pricePerLiter: slipNum(j.pricePerLiter),
    amount: slipNum(j.amount),
    station: slipText(j.station, 120),
    buyerTaxId: slipText(j.buyerTaxId, 30).replace(/\D/g, ""),
  };
  return read.liters !== null || read.amount !== null || read.invoice ? read : null;
}

// "81-2991 ภูเก็ต" holds "81-2991"; "ต2610..." is "2610..." (case, spaces, dashes, a Thai prefix ignored)
const plateKey = (s: string) => s.toUpperCase().replace(/[\s.-]/g, "");
const invoiceKey = (s: string) => s.toUpperCase().replace(/[^0-9A-Z]/g, "");

// The saved fill against the AI reading of its slip, the vehicle's code and the fill date (Bangkok YYYY-MM-DD).
export function slipFlags(
  read: SlipRead | null,
  x: { liters: number; pricePerLiter: number | null; amount: number | null; invoice: string; vehicleCode: string; date: string }
): FuelFlag[] {
  if (!read) return [];
  const flags: FuelFlag[] = [];
  const add = (code: string, text: string) => flags.push({ code, text });
  const off = (a: number | null, b: number | null, tolerance: number) => a !== null && b !== null && Math.abs(a - b) > tolerance;
  if (off(read.liters, x.liters, 0.01)) add("slip_liters", `ลิตรไม่ตรงสลิป (สลิป ${num(read.liters, 3)} กรอก ${num(x.liters, 3)})`);
  if (off(read.pricePerLiter, x.pricePerLiter, 0.005)) add("slip_price", `ราคาต่อลิตรไม่ตรงสลิป (สลิป ${num(read.pricePerLiter, 4)} กรอก ${num(x.pricePerLiter, 4)})`);
  if (off(read.amount, x.amount, 0.5)) add("slip_amount", `ยอดเงินไม่ตรงสลิป (สลิป ${baht(read.amount)} กรอก ${baht(x.amount)})`);
  if (read.invoice && invoiceKey(read.invoice) !== invoiceKey(x.invoice)) add("slip_invoice", `เลขที่ใบกำกับไม่ตรงสลิป (สลิป ${read.invoice} กรอก ${x.invoice || "-"})`);
  if (read.plate && !plateKey(read.plate).includes(plateKey(x.vehicleCode))) add("slip_plate", `ทะเบียนบนสลิป ${read.plate} ไม่ตรงกับรถ ${x.vehicleCode}`);
  if (read.date && read.date !== x.date) add("slip_date", `วันที่บนสลิป ${read.date.split("-").reverse().join("/")} ไม่ใช่วันที่เติม`);
  if (read.replaces) add("slip_replaces", `สลิปเป็นใบกำกับฉบับแทน ยกเลิกเลขที่ ${read.replaces} (ห้ามใช้ใบเดิม)`);
  return flags;
}
