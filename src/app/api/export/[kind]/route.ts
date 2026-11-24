import { createHash, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { csv } from "@/lib/csv";
import { dec, driverOf } from "@/lib/format";
import { latestHours, PM_STATE, pmState } from "@/lib/summary";
import { hoursBetween } from "@/lib/time";
import { FUEL_STATUS, REPAIR_STATUS, URGENCY } from "@/components/ui";

// Read-only Google Sheets view: =IMPORTDATA("<APP_URL>/api/export/fuel?token=<EXPORT_TOKEN>").
// No session; the token is the key. Latest 5000 rows, Bangkok times, plain numbers.
type Row = (string | number | null | undefined)[];

const LIMIT = 5000;

// "YYYY-MM-DD HH:mm" in Bangkok (UTC+7, no daylight saving)
const at = (d: Date | null | undefined) => (d ? new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ") : "");
const label = (map: Record<string, [string, unknown]>, v: string) => map[v]?.[0] ?? v;
const coords = (lat: number | null, lng: number | null) => (lat !== null && lng !== null ? `${lat},${lng}` : "");
// flags: [{ code, text }] -> "text; text"
const flagText = (j: unknown) =>
  Array.isArray(j) ? j.map((x) => (x as { text?: unknown } | null)?.text).filter((t) => typeof t === "string").join("; ") : "";

async function table(kind: string): Promise<Row[] | null> {
  if (kind === "fuel") {
    const list = await prisma.fuelRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      include: { vehicle: { select: { code: true } }, driver: { select: { name: true } }, filler: { select: { name: true } } },
    });
    return [
      ["เลขที่", "สถานะ", "วันที่ขอ", "รถ", "คนขับ", "ชม.เครื่อง", "วันที่เติม", "คนเติม", "เติมจาก", "ปั๊ม", "ลิตร", "ราคาต่อลิตร", "ยอดเงิน", "เลขที่ใบกำกับ", "เลขไมค์", "ผิดปกติ", "ตรวจเมื่อ"],
      ...list.map((f) => [
        f.no,
        label(FUEL_STATUS, f.status),
        at(f.createdAt),
        f.vehicle.code,
        driverOf(f),
        dec(f.engineHours),
        at(f.filledAt),
        f.filler?.name,
        f.source === "pump" ? "ปั๊ม" : f.source === "tank" ? "ถังกลาง" : "",
        f.supplierName,
        dec(f.liters),
        dec(f.pricePerLiter),
        dec(f.amount),
        f.invoice,
        dec(f.odometer),
        flagText(f.flags),
        at(f.reviewedAt),
      ]),
    ];
  }
  if (kind === "repairs") {
    const list = await prisma.repairRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: LIMIT,
      include: { vehicle: { select: { code: true } }, driver: { select: { name: true } } },
    });
    return [
      [
        "เลขที่", "สถานะ", "วันที่แจ้ง", "รถ", "คนแจ้ง", "อาการ", "สาเหตุ", "ความเร่งด่วน", "ไมค์ / ชม.เครื่อง", "รอบเช็คระยะ", "จากเช็คระยะ",
        "ราคาเสนอ", "วันที่เสนอราคา", "ผู้บริหารพิจารณาเมื่อ", "หมายเหตุผู้บริหาร", "ค่าซ่อม", "รายละเอียดค่าซ่อม", "ร้าน / อู่", "เลขที่ใบกำกับ",
        "วันที่บันทึกค่าซ่อม", "ซ่อมเสร็จ", "ปิดงาน", "เหตุผลยกเลิก / ปิดงานแทนคนขับ",
      ],
      ...list.map((r) => [
        r.no,
        label(REPAIR_STATUS, r.status),
        at(r.createdAt),
        r.vehicle.code,
        driverOf(r),
        r.symptom,
        r.cause,
        label(URGENCY, r.urgency),
        dec(r.odometer),
        r.pmRound,
        r.fromPm ? "ใช่" : "",
        dec(r.quoteAmount),
        at(r.quotedAt),
        at(r.decidedAt),
        r.decisionNote,
        dec(r.costAmount),
        r.costDetail,
        r.supplierName,
        r.invoice,
        at(r.costedAt),
        at(r.doneAt),
        at(r.closedAt), // a cancelled job's cancel time too
        r.endNote,
      ]),
    ];
  }
  if (kind === "attendance") {
    const list = await prisma.attendance.findMany({ orderBy: { inAt: "desc" }, take: LIMIT, include: { user: { select: { name: true } } } });
    return [
      ["วันที่", "ชื่อ", "เข้างาน", "ออกงาน", "ชั่วโมง", "พิกัดเข้างาน", "พิกัดออกงาน"],
      ...list.map((a) => [
        a.workDate.toISOString().slice(0, 10),
        a.user.name,
        at(a.inAt),
        at(a.outAt),
        a.outAt ? Math.round(hoursBetween(a.inAt, a.outAt) * 100) / 100 : "",
        coords(a.inLat, a.inLng),
        coords(a.outLat, a.outLng),
      ]),
    ];
  }
  if (kind === "vehicles") {
    const [list, hours] = await Promise.all([prisma.vehicle.findMany({ orderBy: { code: "asc" }, take: LIMIT }), latestHours()]);
    return [
      ["รหัส", "รุ่น", "ลิตร/ชม. มาตรฐาน", "ความจุถัง", "รอบเช็คระยะ (ชม.)", "เช็คล่าสุดที่ (ชม.)", "ชม.เครื่องล่าสุด", "ครบรอบถัดไปที่ (ชม.)", "สถานะเช็คระยะ", "Express รหัส", "Express แผนก", "ใช้งาน", "หมายเหตุ"],
      ...list.map((v) => {
        const pm = pmState(v, hours.get(v.id));
        return [
          v.code,
          v.model,
          dec(v.litersPerHour),
          dec(v.tankLiters),
          v.pmEveryHours,
          dec(v.pmLastHours),
          hours.get(v.id),
          pm?.due,
          pm ? PM_STATE[pm.state][0] : "",
          v.expressItem,
          v.expressDep,
          v.active ? "ใช่" : "ไม่",
          v.note,
        ];
      }),
    ];
  }
  return null;
}

export async function GET(req: Request, { params }: { params: Promise<{ kind: string }> }) {
  const want = process.env.EXPORT_TOKEN;
  if (!want) return new Response("not found", { status: 404 });
  const digest = (s: string) => createHash("sha256").update(s).digest();
  if (!timingSafeEqual(digest(new URL(req.url).searchParams.get("token") ?? ""), digest(want))) return new Response("forbidden", { status: 403 });
  const rows = await table((await params).kind);
  if (!rows) return new Response("not found", { status: 404 });
  return new Response(csv(rows), { headers: { "Content-Type": "text/csv; charset=utf-8", "Cache-Control": "no-store" } });
}
