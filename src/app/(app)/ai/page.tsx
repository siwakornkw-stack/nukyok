import { requirePage } from "@/lib/session";
import { ROLES, isRole, type Role } from "@/lib/roles";
import { thDateTime } from "@/lib/time";
import { Card, Info, Notice, PageHeader } from "@/components/ui";
import { ActionButton, AiKeyButton } from "@/components/forms";

// What the secretary can do with each role's key (the same as the person in the app).
const CAN: Record<Role, string> = {
  driver: "ขอเติมน้ำมัน, แจ้งซ่อม, ดูรายการของตัวเองที่รออยู่",
  filler: "ดูคำขอเติมน้ำมันที่รอเติม",
  office: "ตรวจ / อนุมัติ / ส่งกลับรายการน้ำมัน, สรุปรายวัน, ต้นทุน, ข้อมูลรถ, เข้างาน, ผู้ใช้รออนุมัติ",
  exec: "อนุมัติ / ไม่อนุมัติงานซ่อม, อนุมัติน้ำมัน, สรุป, ต้นทุน, ข้อมูลรถ, เข้างาน",
  purchasing: "ดูงานซ่อมที่ต้องทำ, ข้อมูลรถ",
  accounting: "สรุป, ต้นทุน, รายการน้ำมัน / งานซ่อม, Express ที่ผิดพลาด",
};

// เชื่อมต่อเลขา AI: the signed-in person's own API key (/api/ai/*, see /api/ai/openapi.json).
export default async function AiPage() {
  const u = await requirePage();
  const base = (process.env.APP_URL || "https://nukyok.phuketnukyok.com").replace(/\/$/, "");
  const roles = u.roles.filter(isRole);
  return (
    <>
      <PageHeader title="เชื่อมต่อเลขา AI" back="/" />
      <Card title="รหัสของฉัน">
        <p className="mb-3 text-sm text-muted">
          เลขา AI ที่ใช้รหัสนี้ทำได้เท่าที่คุณทำได้ในแอป ({roles.map((r) => ROLES[r]).join(", ")}) และทุกอย่างที่ทำจะบันทึกชื่อคุณพร้อมคำว่า &quot;(เลขา AI)&quot;
        </p>
        <div className="mb-4">
          <Info rows={[["สถานะ", u.aiKeyAt ? `มีรหัสแล้ว สร้างเมื่อ ${thDateTime(u.aiKeyAt)}` : "ยังไม่มีรหัส"]]} />
        </div>
        <div className="flex flex-wrap gap-2">
          <AiKeyButton replace={!!u.aiKeyAt} />
          {u.aiKeyAt && <ActionButton action="/api/ai/key" body={{ action: "revoke" }} label="ยกเลิกรหัส" confirm="ยกเลิกรหัสเลขา AI? เลขาจะใช้ระบบไม่ได้จนกว่าจะสร้างรหัสใหม่" />}
        </div>
        <Notice className="mt-4 mb-0">อย่าส่งรหัสให้คนอื่น ใครมีรหัสนี้สั่งงานแทนคุณได้ ถ้ารหัสหลุดให้กดสร้างรหัสใหม่หรือยกเลิกรหัสทันที</Notice>
      </Card>
      <Card title="สิ่งที่เลขาทำได้">
        <ul className="list-disc space-y-1 pl-5 text-sm">
          {roles.map((r) => (
            <li key={r}>
              <span className="font-medium">{ROLES[r]}:</span> {CAN[r]}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-sm text-muted">ก่อนอนุมัติ ไม่อนุมัติ หรือสร้างรายการ เลขาต้องถามยืนยันกับคุณก่อน และการอนุมัติงานซ่อมต้องระบุราคาที่คุณเห็นด้วย</p>
      </Card>
      <Card title="ตั้งค่าในเลขา AI">
        <Info
          rows={[
            ["คำอธิบาย API (OpenAPI)", <span key="o" className="break-all font-mono text-xs">{`${base}/api/ai/openapi.json`}</span>],
            ["การยืนยันตัวตน", <span key="h" className="break-all font-mono text-xs">Authorization: Bearer รหัสของคุณ</span>],
          ]}
        />
        <p className="mt-2 text-sm text-muted">นำลิงก์ OpenAPI ไปใส่ในเลขา AI (เช่น GPT Actions, n8n, Dify) แล้วตั้ง API Key แบบ Bearer เป็นรหัสด้านบน</p>
      </Card>
    </>
  );
}
