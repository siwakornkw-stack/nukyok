import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { getMasters, knownDepartments } from "@/lib/express";
import { bad, formStr, jsonBody, numOrNull, ok, readForm, str } from "@/lib/http";
import { apiUser } from "@/lib/session";
import { latestHours, samePlate } from "@/lib/summary";
import { FIELDS, vehicleChanges } from "./fields";

function parseWas(s: string): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(s);
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// /office/vehicles/<id>. JSON { action: "pm-done", hours } (ActionButton, Office or จัดซื้อ) = service done at the
// engine hours the button showed and the user confirmed; FormData (ApiForm, Office only) = save the master fields.
// The form posts what it loaded (was, JSON) next to what is typed: only fields the user changed are written, each
// guarded on its loaded value, so a page left open cannot put back service hours (pm-done, a service repair
// accepted / closed) or an Express item someone changed meanwhile.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const json = (req.headers.get("content-type") ?? "").includes("application/json");
  const a = await apiUser(json ? ["office", "purchasing"] : ["office"]);
  if ("res" in a) return a.res;
  const { id } = await params;

  if (json) {
    const b = await jsonBody(req);
    if (str(b.action) !== "pm-done") return bad("ไม่รู้จักคำสั่งนี้");
    // Saved only while the reading the user confirmed is still the latest: a page left open must not put back an
    // older one (a service repair may have saved a newer one), and a crafted post cannot save any other number.
    const hours = (await latestHours()).get(id);
    if (hours === undefined) return bad("ยังไม่มีชั่วโมงเครื่องของรถคันนี้");
    if (numOrNull(b.hours) !== hours) return bad("ชั่วโมงเครื่องล่าสุดเปลี่ยนไปแล้ว รีเฟรชหน้าแล้วลองใหม่", 409);
    const r = await prisma.vehicle.updateMany({ where: { id }, data: { pmLastHours: hours } });
    if (r.count !== 1) return bad("ไม่พบรถคันนี้", 404);
    return ok({ pmLastHours: hours });
  }

  const fd = await readForm(req, 200_000);
  if (!fd) return bad("ข้อมูลไม่ถูกต้อง");
  const was = parseWas(formStr(fd, "was", 10_000));
  if (!was) return bad("ข้อมูลไม่ครบ รีเฟรชหน้าแล้วลองใหม่");
  const changes = vehicleChanges((k) => fd.get(k), was);
  if (!changes) return bad("ตัวเลขไม่ถูกต้อง (ต้องไม่ติดลบ และรอบเช็คระยะต้องเป็นจำนวนเต็ม)");
  const { data, where } = changes;

  if ("code" in data) {
    if (!data.code) return bad("กรอกรหัส / ทะเบียนรถ");
    const dup = await samePlate(String(data.code), id);
    if (dup) return bad(`ทะเบียนนี้ซ้ำกับรถ ${dup} ที่มีอยู่แล้ว (ไม่นับตัวพิมพ์เล็ก-ใหญ่ เว้นวรรค จุด และขีด)`);
  }
  // The department is stored only as typed; blank = the fuel item's own, taken when a bill is queued.
  let notice = "";
  if ("expressItem" in data || "expressDep" in data) {
    const m = await getMasters();
    const item = String(data.expressItem ?? "");
    if (item && !m?.fuel.items.some((i) => i.code === item)) return bad("ไม่พบรหัสน้ำมันนี้ในข้อมูลจาก Express");
    if ("expressDep" in data) {
      const dep = String(data.expressDep);
      if (dep.length > 4) return bad("แผนก Express ยาวเกิน 4 ตัวอักษร");
      if (dep && m && !knownDepartments(m).has(dep)) return bad(`ไม่พบแผนก ${dep} ใน Express (ตัวพิมพ์เล็ก-ใหญ่ต้องตรงกัน)`);
    } else {
      // A new item, department box untouched: a department filled in from the old item before (equal to its own, or
      // the old item is unknown, so nobody can tell) gives way to the new item's own. The notice names it, so a
      // department typed on purpose can be typed again. Without a new item (cleared) the department stays.
      const wasDep = FIELDS.expressDep(was.expressDep);
      const oldItem = m?.fuel.items.find((i) => i.code === FIELDS.expressItem(was.expressItem));
      const it = m?.fuel.items.find((i) => i.code === item);
      if (it?.depCode && wasDep && (!oldItem || wasDep === oldItem.depCode)) {
        [data.expressDep, where.expressDep] = ["", wasDep];
        if (it.depCode !== wasDep)
          notice = `แผนก Express ต่อจากนี้: ${it.depCode}${it.depName ? ` ${it.depName}` : ""} ตามรหัสน้ำมัน ${it.code} (เดิม ${wasDep}) ถ้าต้องการแผนกอื่นให้พิมพ์ในช่องแผนก Express แล้วบันทึกอีกครั้ง`;
      }
    }
  }

  if (!Object.keys(data).length) return ok();
  try {
    const r = await prisma.vehicle.updateMany({ where: { id, ...where } as Prisma.VehicleWhereInput, data: data as Prisma.VehicleUpdateManyMutationInput });
    if (r.count !== 1) return (await prisma.vehicle.count({ where: { id } })) ? bad("ข้อมูลรถถูกแก้ไปแล้วระหว่างนี้ รีเฟรชหน้าแล้วแก้ใหม่", 409) : bad("ไม่พบรถคันนี้", 404);
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return bad("รหัสรถนี้มีแล้ว");
    throw e;
  }
  return ok(notice ? { notice } : {});
}
