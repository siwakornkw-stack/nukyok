import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePage } from "@/lib/session";
import { hasRole } from "@/lib/roles";
import { getMasters } from "@/lib/express";
import { baht } from "@/lib/format";
import { Card, Field, PageHeader, inputCls, Notice } from "@/components/ui";
import { ActionButton, ApiForm, PhotoInput } from "@/components/forms";
import { RepairDetail, repairInclude } from "@/app/(app)/repairs-shared";

// The quotation: the first one (quote) and a new one (approved / rejected, "ขออนุมัติใหม่").
// seen: quotedAt of the quotation this page shows ("" for none); the route refuses the form if another came in since.
function QuoteForm({ id, seen, submit }: { id: string; seen: string; submit: string }) {
  return (
    <ApiForm action={`/api/repairs/${id}/quote`} submit={submit}>
      <input type="hidden" name="seen" value={seen} />
      <Field label="ยอดใบเสนอราคา (บาท รวม VAT)">
        <input name="quoteAmount" type="number" inputMode="decimal" step="0.01" min="0.01" required className={inputCls} />
      </Field>
      <Field label="หมายเหตุ">
        <textarea name="quoteNote" maxLength={1000} rows={2} className={inputCls} />
      </Field>
      <Field label="ไฟล์ใบเสนอราคา (รูป / PDF)">
        <PhotoInput name="quoteFiles" multiple required pdf />
      </Field>
    </ApiForm>
  );
}

// One repair. Accounting only reads; จัดซื้อ acts on it by status; Office may also cancel or close it.
export default async function PurchasingRepairPage({ params }: { params: Promise<{ id: string }> }) {
  const u = await requirePage(["purchasing", "office", "accounting"]);
  const { id } = await params;
  const r = await prisma.repairRequest.findUnique({ where: { id }, include: repairInclude });
  if (!r) notFound();
  const act = hasRole(u, "purchasing");
  const manage = hasRole(u, "purchasing", "office");
  const m = act && r.status === "approved" ? await getMasters() : null;
  const seen = r.quotedAt?.toISOString() ?? "";

  return (
    <>
      <PageHeader title={`แจ้งซ่อม #${r.no}`} back={`/purchasing/repairs?status=${r.status}`} />
      <RepairDetail r={r} />

      {act && r.status === "quote" && (
        <Card title="ลงใบเสนอราคา">
          <QuoteForm id={r.id} seen={seen} submit="ส่งขออนุมัติผู้บริหาร" />
        </Card>
      )}

      {act && r.status === "approved" && (
        <Card title="ลงรายละเอียดค่าซ่อม">
          {!m && (
            <Notice className="mb-3">ยังไม่มีข้อมูลจาก Express: บันทึกได้ แต่จะไม่เปิด PO อัตโนมัติ</Notice>
          )}
          <ApiForm action={`/api/repairs/${r.id}/cost`} submit="บันทึกค่าซ่อม เริ่มซ่อม">
            {m && (
              <Field label="ร้าน / อู่ (ผู้จำหน่ายใน Express)">
                <select name="supplierCode" defaultValue="" className={inputCls}>
                  <option value="">ไม่มีในรายการ</option>
                  {m.repair.suppliers.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} - {s.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={m ? "ชื่อร้าน / อู่ (ถ้าไม่มีในรายการ)" : "ชื่อร้าน / อู่"}>
              <input name="supplierName" maxLength={120} className={inputCls} />
            </Field>
            {m && (
              <Field label="รหัสค่าซ่อม (Express)">
                <select name="itemCode" defaultValue="" className={inputCls}>
                  <option value="">ไม่เลือก</option>
                  {m.repair.items.map((i) => (
                    <option key={i.code} value={i.code}>
                      {i.code} - {i.desc}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="เลขที่ใบกำกับภาษี">
              <input name="invoice" maxLength={30} className={inputCls} />
            </Field>
            {m && (
              <Field label="VAT ในใบกำกับภาษี">
                <select name="vatMode" defaultValue="" required className={inputCls}>
                  <option value="">เลือก</option>
                  <option value="1">ราคาในบิลรวม VAT แล้ว</option>
                  <option value="2">ราคาในบิลยังไม่รวม VAT (บวก VAT 7% ท้ายบิล)</option>
                  <option value="0">ไม่มี VAT</option>
                </select>
              </Field>
            )}
            <Field label="ค่าซ่อม (บาท รวม VAT)" hint={`ใบเสนอราคาที่อนุมัติ ${baht(r.quoteAmount)} บาท (ถ้าเกิน 5% ต้องขออนุมัติใหม่)`}>
              <input name="costAmount" type="number" inputMode="decimal" step="0.01" min="0.01" required className={inputCls} />
            </Field>
            <Field label="รายละเอียด">
              <textarea name="costDetail" maxLength={2000} rows={3} className={inputCls} />
            </Field>
            <Field label="บิล / รูปงานซ่อม (รูป / PDF)">
              <PhotoInput name="billFiles" multiple required pdf camera={false} />
            </Field>
          </ApiForm>
        </Card>
      )}

      {act && (r.status === "approved" || r.status === "rejected") && (
        <Card title="ขออนุมัติใหม่ (ราคาเปลี่ยน)">
          <p className="mb-3 text-sm text-muted">
            {r.status === "approved" ? "ค่าซ่อมสูงกว่าใบเสนอราคาที่อนุมัติเกิน 5%" : "ผู้บริหารไม่อนุมัติใบเสนอราคานี้"}: แนบใบเสนอราคาใหม่ ส่งให้ผู้บริหารอนุมัติอีกครั้ง
          </p>
          <QuoteForm id={r.id} seen={seen} submit="ส่งขออนุมัติใหม่" />
        </Card>
      )}

      {act && r.status === "repairing" && (
        <Card>
          <div className="grid">
            <ActionButton
              action={`/api/repairs/${r.id}/done`}
              label="ซ่อมเสร็จ"
              confirm={`ยืนยันซ่อมเสร็จ แจ้งคนขับตรวจรับรถ ${r.vehicle.code}?`}
              primary
            />
          </div>
        </Card>
      )}

      {manage && r.status === "done" && (
        <Card>
          <p className="mb-3 text-sm text-muted">รอคนขับตรวจรับรถ: ถ้าคนขับตรวจรับไม่ได้ ปิดงานแทนได้ (แจ้งคนขับทาง LINE)</p>
          <div className="grid">
            <ActionButton action={`/api/repairs/${r.id}/close`} label="ปิดงานแทนคนขับ" note={{ prompt: "เหตุผลที่ปิดงานแทนคนขับ", required: true }} />
          </div>
        </Card>
      )}

      {manage && ["quote", "approval", "approved"].includes(r.status) && (
        <Card>
          <div className="grid">
            <ActionButton action={`/api/repairs/${r.id}/cancel`} label="ยกเลิกงานซ่อม" note={{ prompt: "เหตุผลที่ยกเลิกงานซ่อม (แจ้งคนขับ)", required: true }} />
          </div>
        </Card>
      )}
    </>
  );
}
