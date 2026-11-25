import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getMasters, knownDepartments } from "@/lib/express";
import { baht, dec, num } from "@/lib/format";
import { hasRole } from "@/lib/roles";
import { requirePage } from "@/lib/session";
import { latestHours, PM_STATE, pmState, vehicleCosts } from "@/lib/summary";
import { bkkDateKey, bkkStart, thDate, thDateTime } from "@/lib/time";
import { Card, Empty, Field, Info, PageHeader, Pill, REPAIR_STATUS, StatusPill, Table, inputCls } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/forms";

// หน้าสินทรัพย์ต่อคัน: master data, fuel / repair history, engine hours and cost totals.
export default async function VehiclePage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requirePage(["office", "exec", "purchasing", "accounting"]);
  const { id } = await params;
  const v = await prisma.vehicle.findUnique({ where: { id } });
  if (!v) notFound();
  const office = hasRole(u, "office");

  const today = bkkDateKey();
  const year = Number(today.slice(0, 4));
  const monthStart = bkkStart(`${today.slice(0, 7)}-01`);
  const nextMonth = bkkStart(`${new Date(Date.UTC(year, Number(today.slice(5, 7)), 1)).toISOString().slice(0, 7)}-01`);
  const approved = { vehicleId: id, status: "approved" };
  const [fuel, repairs, hoursAll, monthCosts, yearCosts, before, inMonth, masters] = await Promise.all([
    // one extra row so the oldest shown fill still has a previous one for ลิตร/ชม.
    prisma.fuelRequest.findMany({
      where: { vehicleId: id, status: { in: ["filled", "approved"] } },
      orderBy: { filledAt: "desc" },
      take: 101,
      select: { id: true, no: true, filledAt: true, liters: true, amount: true, engineHours: true, flags: true },
    }),
    prisma.repairRequest.findMany({
      where: { vehicleId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true, no: true, createdAt: true, symptom: true, status: true, costAmount: true },
    }),
    latestHours(),
    vehicleCosts(monthStart, nextMonth),
    vehicleCosts(bkkStart(`${year}-01-01`), bkkStart(`${year + 1}-01-01`)),
    // ใช้ไปเดือนนี้ as on the cost page: readings Office approved, by fill time (not the highest ever: one typo
    // would zero or inflate it), from the last one before the month (else the month's first) to the month's last
    prisma.fuelRequest.findFirst({ where: { ...approved, filledAt: { lt: monthStart } }, orderBy: { filledAt: "desc" }, select: { engineHours: true } }),
    prisma.fuelRequest.findMany({ where: { ...approved, filledAt: { gte: monthStart, lt: nextMonth } }, orderBy: { filledAt: "asc" }, select: { engineHours: true } }),
    // every role: the card shows the item and the department bills are booked to
    getMasters(),
  ]);

  const hours = hoursAll.get(id);
  const pm = pmState(v, hours);
  const shown = fuel.slice(0, 100);
  const last = dec(inMonth[inMonth.length - 1]?.engineHours);
  const base = dec(before?.engineHours) ?? dec(inMonth[0]?.engineHours);
  const usedThisMonth = last !== null && base !== null ? Math.max(0, last - base) : null;
  const zero = { fuel: 0, liters: 0, repair: 0 };
  const totals: [string, typeof zero][] = [
    ["เดือนนี้", monthCosts.get(id) ?? zero],
    ["ปีนี้", yearCosts.get(id) ?? zero],
  ];
  const items = masters?.fuel.items ?? [];
  const item = items.find((i) => i.code === v.expressItem);
  const deps = masters ? knownDepartments(masters) : null;
  // what bills are booked to: the department typed for this vehicle, else its fuel item's own
  const dep = v.expressDep || item?.depCode || "";
  const depNote = !dep || !deps ? "" : !deps.has(dep) ? " (ไม่พบใน Express)" : deps.get(dep) ? ` ${deps.get(dep)}` : "";
  // what the form loaded, posted back with it: the route writes only the fields the user changed
  const loaded = {
    code: v.code,
    model: v.model,
    litersPerHour: dec(v.litersPerHour),
    tankLiters: dec(v.tankLiters),
    pmEveryHours: v.pmEveryHours,
    pmLastHours: dec(v.pmLastHours),
    expressItem: v.expressItem,
    expressDep: v.expressDep,
    note: v.note,
    active: v.active ? "1" : "",
  };

  return (
    <>
      <PageHeader title={`รถ ${v.code}`} back="/office/vehicles" />

      <Card>
        <Info
          rows={[
            ["รุ่น", v.model || "-"],
            ["ลิตร/ชม. มาตรฐาน", num(v.litersPerHour, 2)],
            ["ความจุถัง (ลิตร)", num(v.tankLiters, 2)],
            ["รอบเช็คระยะ", v.pmEveryHours ? `ทุก ${num(v.pmEveryHours, 0)} ชม.` : "-"],
            ["เช็คล่าสุดที่", v.pmLastHours !== null ? `${num(v.pmLastHours)} ชม.` : "-"],
            ["ชม.เครื่องล่าสุด", num(hours)],
            [
              "เช็คระยะครั้งถัดไป",
              pm ? (
                <>
                  {num(pm.due)} ชม. <StatusPill map={PM_STATE} value={pm.state} />
                </>
              ) : v.pmEveryHours && v.pmLastHours === null ? (
                "ไม่ทราบ (ยังไม่ได้กรอกเช็คล่าสุดที่)"
              ) : (
                "-"
              ),
            ],
            ["Express รหัสน้ำมัน", v.expressItem ? `${v.expressItem}${item ? ` ${item.desc}` : masters ? " (ไม่พบใน Express)" : ""}` : "-"],
            ["แผนก Express", dep ? `${dep}${depNote}${v.expressDep ? "" : " (ตามรหัสน้ำมัน)"}` : v.expressItem ? "(ตามรหัสน้ำมัน)" : "-"],
            ["สถานะ", v.active ? "ใช้งาน" : "ไม่ใช้งาน"],
            ["หมายเหตุ", v.note || "-"],
          ]}
        />
        {hasRole(u, "office", "purchasing") && hours !== undefined && (
          <div className="mt-4">
            <ActionButton
              action={`/api/vehicles/${v.id}`}
              body={{ action: "pm-done", hours }}
              label="บันทึกเช็คระยะแล้ว"
              confirm={`บันทึกว่าเช็คระยะแล้วที่ ชม.เครื่อง ${num(hours)}?`}
            />
          </div>
        )}
      </Card>

      <Card title="ค่าใช้จ่าย">
        <Table head={["ช่วง", "น้ำมัน (บาท)", "ลิตร", "ค่าซ่อม (บาท)", "รวม (บาท)"]}>
          {totals.map(([label, c]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{baht(c.fuel)}</td>
              <td>{num(c.liters)}</td>
              <td>{baht(c.repair)}</td>
              <td className="font-semibold">{baht(c.fuel + c.repair)}</td>
            </tr>
          ))}
        </Table>
        <p className="mt-2 text-xs text-muted">น้ำมันนับรายการที่อนุมัติแล้วตามวันที่เติม ค่าซ่อมนับตามวันที่บันทึกค่าซ่อม</p>
      </Card>

      <Card title="ชั่วโมงเครื่อง">
        <Info
          rows={[
            ["ในรายการเติมด้านล่าง", shown.length ? `${num(shown[shown.length - 1].engineHours)} ถึง ${num(shown[0].engineHours)} ชม.` : "-"],
            ["ใช้ไปเดือนนี้", usedThisMonth !== null ? `${num(usedThisMonth)} ชม.` : "-"],
          ]}
        />
      </Card>

      <Card title="ประวัติเติมน้ำมัน (ล่าสุด 100 ครั้ง)">
        {shown.length ? (
          <Table head={["วันที่เติม", "เลขที่", "ลิตร", "ยอดเงิน", "ชม.เครื่อง", v.litersPerHour !== null ? `ลิตร/ชม. (มาตรฐาน ${num(v.litersPerHour, 2)})` : "ลิตร/ชม.", "ผิดปกติ"]}>
            {shown.map((f, i) => {
              const prev = fuel[i + 1];
              const used = prev ? (dec(f.engineHours) ?? 0) - (dec(prev.engineHours) ?? 0) : 0;
              const liters = dec(f.liters);
              const flags = Array.isArray(f.flags) ? f.flags.length : 0;
              return (
                <tr key={f.id}>
                  <td className="whitespace-nowrap">{thDateTime(f.filledAt)}</td>
                  <td>#{f.no}</td>
                  <td>{num(liters, 2)}</td>
                  <td>{baht(f.amount)}</td>
                  <td>{num(f.engineHours)}</td>
                  <td>{used > 0 && liters !== null ? num(liters / used, 2) : "-"}</td>
                  <td>{flags ? <Pill tone="red">{flags}</Pill> : "-"}</td>
                </tr>
              );
            })}
          </Table>
        ) : (
          <Empty>ยังไม่มีการเติมน้ำมัน</Empty>
        )}
      </Card>

      <Card title="ประวัติแจ้งซ่อม">
        {repairs.length ? (
          <Table head={["เลขที่", "วันที่แจ้ง", "อาการ", "สถานะ", "ค่าซ่อม"]}>
            {repairs.map((r) => (
              <tr key={r.id}>
                <td>#{r.no}</td>
                <td className="whitespace-nowrap">{thDate(r.createdAt)}</td>
                <td>{r.symptom}</td>
                <td>
                  <StatusPill map={REPAIR_STATUS} value={r.status} />
                </td>
                <td>{baht(r.costAmount)}</td>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty>ยังไม่มีการแจ้งซ่อม</Empty>
        )}
      </Card>

      {office && (
        <Card title="แก้ไขข้อมูลรถ">
          <ApiForm action={`/api/vehicles/${v.id}`}>
            <input type="hidden" name="was" value={JSON.stringify(loaded)} />
            <Field label="รหัส / ทะเบียนรถ">
              <input name="code" required maxLength={30} defaultValue={v.code} className={inputCls} />
            </Field>
            <Field label="รุ่น">
              <input name="model" maxLength={100} defaultValue={v.model} className={inputCls} />
            </Field>
            <Field label="ลิตร/ชม. มาตรฐาน">
              <input name="litersPerHour" type="number" inputMode="decimal" min="0" step="0.01" defaultValue={dec(v.litersPerHour) ?? ""} className={inputCls} />
            </Field>
            <Field label="ความจุถัง (ลิตร)">
              <input name="tankLiters" type="number" inputMode="decimal" min="0" step="0.01" defaultValue={dec(v.tankLiters) ?? ""} className={inputCls} />
            </Field>
            <Field label="รอบเช็คระยะ (ชม.)">
              <input name="pmEveryHours" type="number" inputMode="numeric" min="0" step="1" defaultValue={v.pmEveryHours ?? ""} className={inputCls} />
            </Field>
            <Field label="เช็คล่าสุดที่ (ชม.เครื่อง)" hint="ว่างไว้ = ไม่ทราบ ระบบยังไม่เตือนเช็คระยะของคันนี้">
              <input name="pmLastHours" type="number" inputMode="decimal" min="0" step="0.1" defaultValue={dec(v.pmLastHours) ?? ""} className={inputCls} />
            </Field>
            <Field label="รหัสน้ำมันใน Express" hint={masters ? undefined : "ยังไม่มีข้อมูลจาก Express (เครื่อง Office ยังไม่ส่งมา)"}>
              <select name="expressItem" defaultValue={v.expressItem} className={inputCls}>
                <option value="">ไม่ระบุ</option>
                {v.expressItem && !item && <option value={v.expressItem}>{v.expressItem} (ไม่พบใน Express)</option>}
                {items.map((i) => (
                  <option key={i.code} value={i.code}>
                    {i.code} - {i.desc}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="แผนก Express"
              hint={`${item ? `ว่างไว้ = ใช้แผนกของ ${item.code} ใน Express: ${item.depCode || "-"}` : "ว่างไว้ = ใช้แผนกของรหัสน้ำมันที่เลือก"} (ทั้งน้ำมันและค่าซ่อม ตัวพิมพ์เล็ก-ใหญ่ต้องตรงกับ Express)`}
            >
              <input name="expressDep" maxLength={4} defaultValue={v.expressDep} placeholder={item?.depCode} list="express-deps" autoComplete="off" className={inputCls} />
              {deps && (
                <datalist id="express-deps">
                  {[...deps].map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </datalist>
              )}
            </Field>
            <Field label="หมายเหตุ">
              <textarea name="note" rows={2} maxLength={1000} defaultValue={v.note} className={inputCls} />
            </Field>
            <label className="mb-4 flex items-center gap-2">
              <input type="checkbox" name="active" value="1" defaultChecked={v.active} className="h-5 w-5" />
              ใช้งานอยู่
            </label>
          </ApiForm>
        </Card>
      )}
    </>
  );
}
