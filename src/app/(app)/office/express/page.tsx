import Link from "next/link";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { EXPRESS_STATUS, R3_STATUS, agentSilent, expressDocs, expressInvoice, getMasters } from "@/lib/express";
import { baht } from "@/lib/format";
import { thDateTime } from "@/lib/time";
import { Card, Empty, PageHeader, Pill, Table, type Tone, chipCls } from "@/components/ui";
import { ActionButton } from "@/components/forms";

export const dynamic = "force-dynamic";

const TONE: Record<string, Tone> = { queued: "yellow", written: "green", error: "red", cancelled: "gray", manual: "gray" };
const R3_TONE: Record<string, Tone> = { queued: "yellow", waiting: "orange", force: "yellow", error: "red", done: "green" };

export default async function ExpressPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  await requirePage(["office", "accounting"]);
  const f = (await searchParams).f === "problem" ? "problem" : "all";
  const [m, orders, problems, unsent] = await Promise.all([
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
  ]);

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
              น้ำมัน (PK + H3): {m.fuel.writer ? <Pill tone="green">เปิดใช้</Pill> : <Pill tone="gray">ปิด</Pill>} ปั๊ม {m.fuel.suppliers.length} ราย, รหัสรถ{" "}
              {m.fuel.items.length} รายการ
            </li>
            <li>
              ซ่อม (PO + RR): {m.repair.writer ? <Pill tone="green">เปิดใช้</Pill> : <Pill tone="gray">ปิด</Pill>} ร้าน / อู่ {m.repair.suppliers.length} ราย,
              รหัสค่าซ่อม {m.repair.items.length} รายการ
            </li>
          </ul>
        ) : (
          <p className="text-sm text-muted">ยังไม่มีข้อมูลจากเครื่อง Office: ติดตั้งชุด nukyok-office-agent (install.cmd) บนเครื่องที่มี Express</p>
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
              const p = o.payload as { amount?: number; invoice?: string };
              const req = o.kind === "fuel" ? o.fuelRequest : o.repairRequest;
              const href = o.kind === "fuel" ? `/office/fuel/${o.fuelRequestId}` : `/purchasing/repairs/${o.repairRequestId}`;
              const dup = !!o.r3Error?.startsWith("อาจซ้ำ");
              return (
                <tr key={o.id}>
                  <td>
                    <Link href={href} className="font-medium text-brand hover:underline">
                      {o.kind === "fuel" ? "น้ำมัน" : "ซ่อม"} #{req?.no}
                    </Link>
                    <div className="text-xs text-muted">
                      {req?.vehicle.code} · บิล {p.invoice || "-"}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">{thDateTime(o.createdAt)}</td>
                  <td className="text-right">{baht(p.amount ?? null)}</td>
                  <td className="whitespace-nowrap">{expressDocs(o) || "-"}</td>
                  <td>
                    <Pill tone={TONE[o.status] ?? "gray"}>{EXPRESS_STATUS[o.status] ?? o.status}</Pill>
                    {o.error && <div className={`mt-1 max-w-xs text-xs ${o.status === "manual" ? "text-muted" : "text-[#B91C1C]"}`}>{o.error}</div>}
                  </td>
                  <td>
                    {o.r3Status ? <Pill tone={R3_TONE[o.r3Status] ?? "gray"}>{R3_STATUS[o.r3Status] ?? o.r3Status}</Pill> : "-"}
                    {o.r3Error && <div className="mt-1 max-w-xs text-xs text-[#B91C1C]">{o.r3Error}</div>}
                  </td>
                  <td className="space-y-1">
                    {(o.status === "error" || (o.r3Status === "error" && o.poNo)) && (
                      <ActionButton action="/api/express/retry" body={{ id: o.id }} label="ลองใหม่" confirm="ส่งกลับเข้าคิวให้เครื่อง Office ลองใหม่?" />
                    )}
                    {dup && (
                      <ActionButton
                        action="/api/express/retry"
                        body={{ id: o.id, force: true }}
                        label="ยืนยันว่าไม่ซ้ำ"
                        confirm="ตรวจใน Express แล้วว่าบรรทัดยอดเท่ากันเป็นบิลอื่น ไม่ใช่บิลนี้?"
                      />
                    )}
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
