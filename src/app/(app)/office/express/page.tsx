import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { EXPRESS_STATUS, R3_STATUS, agentSilent, expressDocs, expressInvoice, getMasters, thMonth, vatClosedThrough, vatFiledThrough } from "@/lib/express";
import { baht } from "@/lib/format";
import { bkkDateKey, dateOnly, isDateKey, shiftMonth, thDate, thDateTime } from "@/lib/time";
import { Card, Empty, Field, PageHeader, Pill, Table, type Tone, chipCls, inputCls } from "@/components/ui";
import { ActionButton, ApiForm } from "@/components/forms";

export const dynamic = "force-dynamic";

const TONE: Record<string, Tone> = { queued: "yellow", written: "green", error: "red", cancelled: "gray", manual: "gray" };
const R3_TONE: Record<string, Tone> = { queued: "yellow", waiting: "orange", force: "yellow", error: "red", done: "green", manual: "gray" };

export default async function ExpressPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const u = await requirePage(["office", "accounting"]);
  const office = hasRole(u, "office"); // closes orders and sets the filed VAT month
  const f = (await searchParams).f === "problem" ? "problem" : "all";
  const [m, orders, problems, unsent, unsentRepairs, queued, filed] = await Promise.all([
    getMasters(),
    prisma.expressOrder.findMany({
      where: f === "problem" ? { OR: [{ status: "error" }, { r3Status: "error" }] } : {},
      orderBy: { createdAt: "desc" },
      take: 200,
      include: { fuelRequest: { select: { no: true, vehicle: { select: { code: true } } } }, repairRequest: { select: { no: true, vehicle: { select: { code: true } } } } },
    }),
    prisma.expressOrder.count({ where: { OR: [{ status: "error" }, { r3Status: "error" }] } }),
    // approved pump fills that were not queued at approval (the reason was shown to the approver only)
    // and not marked "คีย์เองแล้ว" (that creates a "manual" order)
    prisma.fuelRequest.findMany({
      where: { status: "approved", source: "pump", express: { is: null } },
      orderBy: { filledAt: "desc" },
      take: 100,
      select: { id: true, no: true, filledAt: true, createdAt: true, amount: true, invoice: true, vehicle: { select: { code: true } } },
    }),
    // costed repairs that were not queued when the cost was saved (the reason went to that person and accounting
    // only): sent from the repair page, or marked "คีย์เองแล้ว"
    prisma.repairRequest.findMany({
      where: { costedAt: { not: null }, express: { is: null } },
      orderBy: { costedAt: "desc" },
      take: 100,
      select: { id: true, no: true, costedAt: true, costAmount: true, invoice: true, supplierName: true, vehicle: { select: { code: true } } },
    }),
    prisma.expressOrder.groupBy({ by: ["kind"], where: { status: "queued" }, _count: true }),
    vatFiledThrough(),
  ]);
  // Bills waiting for a writer that is off: the next masters (within 15 minutes) turn them into errors.
  const stranded = (kind: string) => queued.find((g) => g.kind === kind)?._count ?? 0;
  const closed = vatClosedThrough(filed);
  const thisMonth = bkkDateKey().slice(0, 7);
  const months = Array.from({ length: 12 }, (_, i) => shiftMonth(thisMonth, -1 - i));

  return (
    <>
      <PageHeader title="Express (PK / H3 / R3, PO / RR)" back="/" />
      <Card title="เครื่อง Office (Express)">
        {m ? (
          <ul className="space-y-1 text-sm">
            <li>
              ส่งข้อมูลล่าสุด: {thDateTime(new Date(m.at))}{" "}
              {agentSilent(m) && <Pill tone="red">ขาดการติดต่อ ตรวจเครื่อง Office</Pill>}
            </li>
            <li>
              น้ำมัน (PK + H3, R3): {m.fuel.writer ? <Pill tone="green">เปิดใช้</Pill> : <Pill tone="gray">ปิด</Pill>} ปั๊ม {m.fuel.suppliers.length} ราย, รหัสรถ{" "}
              {m.fuel.items.length} รายการ{" "}
              {!m.fuel.writer && stranded("fuel") > 0 && <Pill tone="red">ค้างในคิว {stranded("fuel")} รายการ ทั้งที่ปิดการเขียน</Pill>}
            </li>
            <li>
              ซ่อม (PO + RR): {m.repair.writer ? <Pill tone="green">เปิดใช้</Pill> : <Pill tone="gray">ปิด</Pill>} ร้าน / อู่ {m.repair.suppliers.length} ราย,
              รหัสค่าซ่อม {m.repair.items.length} รายการ{" "}
              {!m.repair.writer && stranded("repair") > 0 && <Pill tone="red">ค้างในคิว {stranded("repair")} รายการ ทั้งที่ปิดการเขียน</Pill>}
            </li>
          </ul>
        ) : (
          <p className="text-sm text-muted">ยังไม่มีข้อมูลจากเครื่อง Office: ติดตั้งชุด nukyok-office-agent (install.cmd) บนเครื่องที่มี Express</p>
        )}
      </Card>
      <Card title="เดือนภาษี (ภ.พ.30)">
        <p className="text-sm">
          บิลที่ลงวันที่ถึงเดือน <b>{thMonth(closed)}</b> ไม่ลงภาษีซื้ออัตโนมัติแล้ว: น้ำมันเปิดเฉพาะ PK (คีย์ H3 เอง) ค่าซ่อมที่มี VAT คีย์ PO / RR เอง
          โดยลงภาษีซื้อในเดือนที่ยังเปิด
        </p>
        <p className="mt-1 text-xs text-muted">
          เดือนที่แล้วปิดเองเมื่อเลยวันที่ 15{filed ? ` · บันทึกไว้ว่ายื่นแล้วถึง ${thMonth(filed)}` : ""}
        </p>
        {office && (
          <ApiForm
            action="/api/express/vat-month"
            submit="บันทึกเดือนที่ยื่นแล้ว"
            confirm="ยืนยันว่ายื่น ภ.พ.30 ของเดือนที่เลือกแล้ว? บิลของเดือนนั้นและก่อนหน้าจะไม่ลงภาษีซื้ออัตโนมัติอีก"
            className="mt-3"
          >
            <Field label="ยื่น ภ.พ.30 แล้วถึงเดือน">
              <select name="month" defaultValue={months.includes(filed) ? filed : months[0]} className={inputCls}>
                {months.map((x) => (
                  <option key={x} value={x}>
                    {thMonth(x)}
                  </option>
                ))}
              </select>
            </Field>
          </ApiForm>
        )}
      </Card>
      {unsent.length > 0 && (
        <Card title="เติมน้ำมันที่อนุมัติแล้วแต่ยังไม่ได้ส่งเข้า Express">
          <Table head={["#", "วันที่", "รถ", "ยอด", "บิล", ""]}>
            {unsent.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/office/fuel/${r.id}`} className="font-medium text-brand hover:underline">
                    #{r.no}
                  </Link>
                </td>
                <td className="whitespace-nowrap">{thDateTime(r.filledAt ?? r.createdAt)}</td>
                <td className="whitespace-nowrap">{r.vehicle.code}</td>
                <td className="text-right">{baht(r.amount)}</td>
                <td>{r.invoice || "-"}</td>
                <td>
                  <div className="flex flex-wrap gap-2">
                    {/* Express holds the invoice without its leading Thai letters: show the number to search for */}
                    <ActionButton
                      action="/api/express/queue-fuel"
                      body={{ id: r.id }}
                      label="ส่งเข้า Express"
                      confirm={`ค้นเลขที่ใบกำกับ ${expressInvoice(r.invoice) ?? (r.invoice || "-")} ใน Express ก่อน ถ้ามีอยู่แล้ว (คีย์เองไปแล้ว) อย่าส่ง ให้กด "คีย์เองแล้ว" แทน ไม่เช่นนั้น PK / H3 จะซ้ำ\n\nค้นแล้วไม่พบ: ส่งเติมน้ำมัน #${r.no} เข้าคิวให้เครื่อง Office เขียนลง Express?`}
                    />
                    <ActionButton
                      action="/api/express/queue-fuel"
                      body={{ id: r.id, manual: true }}
                      label="คีย์เองแล้ว"
                      confirm={`ยืนยันว่าเติมน้ำมัน #${r.no} (ใบกำกับ ${r.invoice || "-"}) คีย์ใน Express เองแล้ว? เครื่อง Office จะไม่เขียนรายการนี้ลง Express`}
                    />
                  </div>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {unsentRepairs.length > 0 && (
        <Card title="ค่าซ่อมที่บันทึกแล้ว แต่ยังไม่มี PO / RR ใน Express">
          <p className="mb-2 text-xs text-muted">ส่งเข้า Express จากหน้างานซ่อม (กดที่ #) หรือถ้าคีย์ใน Express เองแล้ว กด &quot;คีย์เองแล้ว&quot;</p>
          <Table head={["#", "บันทึกค่าซ่อม", "รถ", "ร้าน / อู่", "ยอด", "บิล", ""]}>
            {unsentRepairs.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/purchasing/repairs/${r.id}`} className="font-medium text-brand hover:underline">
                    #{r.no}
                  </Link>
                </td>
                <td className="whitespace-nowrap">{thDateTime(r.costedAt)}</td>
                <td className="whitespace-nowrap">{r.vehicle.code}</td>
                <td>{r.supplierName || "-"}</td>
                <td className="text-right">{baht(r.costAmount)}</td>
                <td>{r.invoice || "-"}</td>
                <td>
                  <ActionButton
                    action="/api/express/repair-manual"
                    body={{ id: r.id }}
                    label="คีย์เองแล้ว"
                    confirm={`ยืนยันว่าค่าซ่อม #${r.no} (ใบกำกับ ${r.invoice || "-"}) คีย์ใน Express เองแล้ว? เครื่อง Office จะไม่เขียนรายการนี้ลง Express`}
                  />
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      <div className="mb-4 flex flex-wrap gap-2">
        <Link href="/office/express" className={chipCls(f === "all")}>
          ทั้งหมด
        </Link>
        <Link href="/office/express?f=problem" className={chipCls(f === "problem")}>
          ไม่สำเร็จ ({problems})
        </Link>
      </div>
      <Card>
        {!orders.length ? (
          <Empty>ไม่มีรายการ</Empty>
        ) : (
          <Table head={["รายการ", "ส่งเมื่อ", "ยอด", "เอกสาร", "สถานะ", "R3", ""]}>
            {orders.map((o) => {
              const p = o.payload as { amount?: number; invoice?: string; date?: string };
              const req = o.kind === "fuel" ? o.fuelRequest : o.repairRequest;
              const href = o.kind === "fuel" ? `/office/fuel/${o.fuelRequestId}` : `/purchasing/repairs/${o.repairRequestId}`;
              // ยืนยันว่าไม่ซ้ำ: an R3 held because a line of the same amount is in that day's R3, or (Office only) a fuel
              // bill held because the pump's tax invoice is in another H3 / PK (one invoice split over vehicles)
              const dupR3 = !!o.r3Error?.startsWith("อาจซ้ำ");
              const dupFuel = office && o.kind === "fuel" && o.status === "error" && !!o.error?.startsWith("อาจซ้ำ");
              const settled = o.status === "manual" || o.status === "cancelled";
              return (
                <tr key={o.id}>
                  <td>
                    <Link href={href} className="font-medium text-brand hover:underline">
                      {o.kind === "fuel" ? "น้ำมัน" : "ซ่อม"} #{req?.no}
                    </Link>
                    <div className="text-xs text-muted">
                      {req?.vehicle.code} · บิล {p.invoice || "-"}
                      {isDateKey(p.date) ? ` ลงวันที่ ${thDate(dateOnly(p.date))}` : ""}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{thDateTime(o.createdAt)}</td>
                  <td className="text-right">{baht(p.amount ?? null)}</td>
                  <td className="whitespace-nowrap">{expressDocs(o) || "-"}</td>
                  <td>
                    <Pill tone={TONE[o.status] ?? "gray"}>{EXPRESS_STATUS[o.status] ?? o.status}</Pill>
                    {o.error && <div className={`mt-1 max-w-xs text-xs ${settled ? "text-muted" : "text-[#B91C1C]"}`}>{o.error}</div>}
                  </td>
                  <td>
                    {o.r3Status ? <Pill tone={R3_TONE[o.r3Status] ?? "gray"}>{R3_STATUS[o.r3Status] ?? o.r3Status}</Pill> : "-"}
                    {o.r3Error && <div className={`mt-1 max-w-xs text-xs ${o.r3Status === "manual" ? "text-muted" : "text-[#B91C1C]"}`}>{o.r3Error}</div>}
                  </td>
                  <td>
                    <div className="flex flex-wrap gap-1">
                      {(o.status === "error" || (o.r3Status === "error" && o.poNo)) && (
                        <ActionButton
                          action="/api/express/retry"
                          body={{ id: o.id }}
                          label="ลองใหม่"
                          confirm={
                            o.status === "error"
                              ? "ตรวจใน Express ก่อนว่ายังไม่มีบิลนี้ แล้วส่งกลับเข้าคิว (สร้างจากข้อมูลรถ / บิลปัจจุบัน) ให้เครื่อง Office ลองใหม่?"
                              : "ส่ง R3 กลับเข้าคิวให้เครื่อง Office ลองใหม่?"
                          }
                        />
                      )}
                      {(dupR3 || dupFuel) && (
                        <ActionButton
                          action="/api/express/retry"
                          body={{ id: o.id, force: true }}
                          label="ยืนยันว่าไม่ซ้ำ"
                          confirm={
                            dupFuel
                              ? "ตรวจใน Express แล้วว่าเอกสารของใบกำกับนี้เป็นของรถคันอื่น / บิลอื่น และยังไม่มีบิลนี้? เครื่อง Office จะเปิด PK / H3 ของบิลนี้แยกให้"
                              : "ตรวจใน Express แล้วว่าบรรทัดยอดเท่ากันเป็นบิลอื่น ไม่ใช่บิลนี้?"
                          }
                        />
                      )}
                      {/* seen / seenR3: the state drawn here; close refuses a row that changed since (a stale page) */}
                      {office && (o.status === "error" || (o.status === "written" && o.r3Status === "error")) && (
                        <ActionButton
                          action="/api/express/close"
                          body={{ id: o.id, action: "manual", seen: o.status, seenR3: o.r3Status }}
                          label={o.status === "error" ? "คีย์เองแล้ว" : "ทำ R3 เองแล้ว"}
                          note={{ prompt: `${o.status === "error" ? "คีย์รายการนี้ใน Express เองแล้ว" : "ทำ R3 ของรายการนี้ใน Express เองแล้ว"}: หมายเหตุ เช่น เลขที่เอกสาร (ไม่บังคับ)` }}
                        />
                      )}
                      {/* not while its R3 is queued for the office PC (close refuses it) */}
                      {office && (o.status === "error" || (o.status === "written" && o.r3Status !== "queued" && o.r3Status !== "force")) && (
                        <ActionButton
                          action="/api/express/close"
                          body={{ id: o.id, action: "cancel", seen: o.status, seenR3: o.r3Status }}
                          label="ยกเลิก"
                          note={{ prompt: "เหตุผลที่ยกเลิก (บิลทดสอบ / ผิดรายการ): เอกสารที่เขียนลง Express แล้วต้องยกเลิกใน Express เองด้วย", required: true }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
