import { NextResponse } from "next/server";

// Public description of the เลขา AI API for AI tools (GPT Actions, n8n, Dify ...). No data here, no key needed.
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const num = (description: string) => ({ type: "number", description });
const qp = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }) => ({ name, in: "query", required: false, description, schema });
const json = { description: "JSON", content: { "application/json": { schema: { type: "object" } } } };
const op = (operationId: string, summary: string, description: string, extra: Record<string, unknown> = {}) => ({
  operationId,
  summary,
  description,
  responses: { "200": json, "400": { description: "error: ข้อความภาษาไทยบอกว่าผิดอะไร" }, "401": { description: "รหัสไม่ถูกต้อง" }, "403": { description: "ไม่มีสิทธิ์" } },
  ...extra,
});
const body = (properties: Record<string, unknown>, required: string[]) => ({
  required: true,
  content: { "application/json": { schema: { type: "object", properties, required } } },
});
const FUEL_STATUS = ["waiting", "filled", "returned", "approved", "cancelled"];
const REPAIR_STATUS = ["quote", "approval", "approved", "repairing", "done", "closed", "rejected", "cancelled"];
const date = (d: string) => qp(d, "YYYY-MM-DD (วันตามเวลาไทย)", { type: "string", format: "date" });

export function GET() {
  const spec = {
    openapi: "3.1.0",
    info: {
      title: "nukyok ระบบจัดการรถ: API สำหรับเลขา AI",
      version: "1.0.0",
      description: [
        "ระบบจัดการรถของบริษัท: เข้างาน / เติมน้ำมัน / แจ้งซ่อม / ต้นทุนต่อคัน / Express",
        "ใช้รหัสของผู้ใช้ (Authorization: Bearer nk_...) เลขาทำได้เท่าที่เจ้าของรหัสทำได้ในแอปตามบทบาทของเขา",
        "เรียก getMe ก่อน เพื่อรู้ชื่อและบทบาท แล้วเรียก getPending เพื่อดูงานที่รอคนนี้อยู่",
        "เลขรายการ (no) คือเลข # ที่คนในบริษัทใช้ เช่น #12 ส่งเป็นตัวเลข 12; รถเรียกด้วยรหัสรถ เช่น SY140-01",
        "ก่อนเรียกคำสั่งที่เปลี่ยนข้อมูล (reviewFuel, decideRepair, requestFuel, reportRepair) ต้องสรุปให้ผู้ใช้ฟังและได้คำยืนยันก่อนทุกครั้ง",
        "เงินเป็นบาท รวม VAT; เวลาเป็น ISO 8601 (UTC) ให้แสดงเป็นเวลาไทยเมื่อตอบผู้ใช้",
      ].join("\n"),
    },
    servers: [{ url: (process.env.APP_URL || "https://nukyok.phuketnukyok.com").replace(/\/$/, "") }],
    security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "รหัสเลขา AI ของผู้ใช้ สร้างได้ที่หน้า /ai ในแอป" } } },
    paths: {
      "/api/ai/me": { get: op("getMe", "ฉันคือใคร", "ชื่อและบทบาทของเจ้าของรหัส") },
      "/api/ai/pending": {
        get: op("getPending", "งานที่รอฉันอยู่", "รายการที่รอเจ้าของรหัสตามบทบาท: น้ำมันรอเติม / รอตรวจ (ผิดปกติขึ้นก่อน), งานซ่อมรออนุมัติ (พร้อมราคา), งานซ่อมของจัดซื้อ, รถที่รอตรวจรับ, ผู้ใช้รออนุมัติ, Express ที่ผิดพลาด"),
      },
      "/api/ai/summary": {
        get: op("getSummary", "สรุปรายวัน / สัปดาห์", "ข้อความสรุปแบบเดียวกับที่ส่งเข้า LINE กลุ่ม Office (Office / ผู้บริหาร / บัญชี)", {
          parameters: [qp("period", "day = วันนี้ (ค่าเริ่มต้น), week = 7 วันก่อนวันนี้", { type: "string", enum: ["day", "week"] })],
        }),
      },
      "/api/ai/costs": {
        get: op("getCosts", "ต้นทุนต่อคัน", "ค่าน้ำมัน (ที่อนุมัติแล้ว) + ค่าซ่อม ต่อคัน เรียงจากมากไปน้อย ค่าเริ่มต้นคือเดือนนี้ ไม่เกิน 400 วัน (Office / ผู้บริหาร / บัญชี)", {
          parameters: [date("from"), date("to")],
        }),
      },
      "/api/ai/vehicles": {
        get: op("getVehicles", "ข้อมูลรถ", "ไม่ใส่ code = รถทุกคัน (ชม.เครื่องล่าสุด, รอบเช็คระยะ); ใส่ code = คันเดียว พร้อมน้ำมัน / ซ่อมล่าสุด และต้นทุนเดือนนี้", {
          parameters: [qp("code", "รหัสรถ เช่น SY140-01")],
        }),
      },
      "/api/ai/attendance": {
        get: op("getAttendance", "เข้างาน / ออกงาน", "ใครเข้างาน ออกงาน กี่ชั่วโมง ในวันหนึ่ง ค่าเริ่มต้นคือวันนี้ (Office / ผู้บริหาร)", { parameters: [date("date")] }),
      },
      "/api/ai/fuel": {
        get: op("listFuel", "รายการเติมน้ำมัน", "ล่าสุดก่อน (Office / ผู้บริหาร / บัญชี)", {
          parameters: [
            qp("no", "เลขรายการ", { type: "integer" }),
            qp("status", "waiting รอเติม, filled เติมแล้วรอตรวจ, returned ส่งกลับแก้ไข, approved อนุมัติแล้ว, cancelled ยกเลิก", { type: "string", enum: FUEL_STATUS }),
            qp("vehicle", "รหัสรถ"),
            date("from"),
            date("to"),
            qp("flagged", "1 = เฉพาะที่ระบบตรวจพบผิดปกติ", { type: "string", enum: ["1"] }),
            qp("limit", "จำนวนสูงสุด (ค่าเริ่มต้น 50, ไม่เกิน 200)", { type: "integer" }),
          ],
        }),
        post: op("requestFuel", "ขอเติมน้ำมัน (คนขับ)", "สร้างคำขอเติมน้ำมันและแจ้งคนเติม ไม่มีรูปหน้าปัดเมื่อขอผ่านเลขา ต้องยืนยันกับผู้ใช้ก่อน", {
          requestBody: body({ vehicle: str("รหัสรถ"), engineHours: num("ชั่วโมงเครื่องบนหน้าปัด") }, ["vehicle", "engineHours"]),
        }),
      },
      "/api/ai/fuel/review": {
        post: op("reviewFuel", "ตรวจรายการน้ำมัน (Office / ผู้บริหาร)", "approve = อนุมัติ (ส่งเข้าคิว Express PK / H3 / R3), return = ส่งกลับให้คนเติมแก้, cancel = ยกเลิก; return / cancel ต้องมี note ใช้กับรายการสถานะ filled ต้องยืนยันกับผู้ใช้ก่อน", {
          requestBody: body({ no: num("เลขรายการ"), action: str("approve | return | cancel", { enum: ["approve", "return", "cancel"] }), note: str("เหตุผล") }, ["no", "action"]),
        }),
      },
      "/api/ai/repairs": {
        get: op("listRepairs", "งานซ่อม", "ล่าสุดก่อน พร้อมราคาใบเสนอราคาและค่าซ่อม (จัดซื้อ / Office / บัญชี / ผู้บริหาร)", {
          parameters: [
            qp("no", "เลขงานซ่อม", { type: "integer" }),
            qp("status", "quote รอใบเสนอราคา, approval รออนุมัติ, approved อนุมัติแล้ว, repairing กำลังซ่อม, done ซ่อมเสร็จ, closed ปิดงาน, rejected ไม่อนุมัติ, cancelled ยกเลิก", { type: "string", enum: REPAIR_STATUS }),
            qp("vehicle", "รหัสรถ"),
            qp("urgency", "urgent ด่วน, normal ปกติ, canwait รอได้", { type: "string", enum: ["urgent", "normal", "canwait"] }),
            date("from"),
            date("to"),
            qp("limit", "จำนวนสูงสุด (ค่าเริ่มต้น 50, ไม่เกิน 200)", { type: "integer" }),
          ],
        }),
        post: op("reportRepair", "แจ้งซ่อม (คนขับ)", "สร้างแจ้งซ่อมและแจ้งจัดซื้อ (ด่วนแจ้งผู้บริหารทันที) ไม่มีรูปเมื่อแจ้งผ่านเลขา ต้องยืนยันกับผู้ใช้ก่อน", {
          requestBody: body(
            {
              vehicle: str("รหัสรถ"),
              symptom: str("อาการ (3-1000 ตัวอักษร)"),
              cause: str("สาเหตุ ถ้าทราบ"),
              urgency: str("urgent = ด่วน รถหยุดงาน, normal = ปกติ, canwait = รอได้", { enum: ["urgent", "normal", "canwait"] }),
              odometer: num("เลขไมค์ / ชั่วโมงเครื่อง ถ้าทราบ"),
            },
            ["vehicle", "symptom", "urgency"]
          ),
        }),
      },
      "/api/ai/repairs/decide": {
        post: op("decideRepair", "อนุมัติ / ไม่อนุมัติงานซ่อม (ผู้บริหาร)", "ใช้กับงานสถานะ approval ต้องบอกราคาให้ผู้ใช้และได้คำยืนยันก่อน แล้วส่ง quoteAmount ตามราคาที่ผู้ใช้เห็น (ถ้าราคาเปลี่ยนจะไม่สำเร็จ) ไม่อนุมัติต้องมี note", {
          requestBody: body(
            { no: num("เลขงานซ่อม"), approve: { type: "boolean", description: "true = อนุมัติ, false = ไม่อนุมัติ" }, quoteAmount: num("ราคาในใบเสนอราคาที่ผู้ใช้ยืนยัน (บาท)"), note: str("เหตุผล / หมายเหตุ") },
            ["no", "approve", "quoteAmount"]
          ),
        }),
      },
    },
  };
  return NextResponse.json(spec);
}
