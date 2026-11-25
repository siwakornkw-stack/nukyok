import "server-only";
import { parseSlip, type SlipRead } from "./fuel-checks";

// Reads a fuel slip photo with Gemini (Google AI Studio key in GEMINI_API_KEY). Never throws: without a key, over the
// free quota or unreadable, `read` is null and the filler types the numbers as before (`note` says why, for them).
// GEMINI_MODEL overrides the model, as Google retires them (gemini-3.5-flash-lite: free tier, no shutdown date).
const PROMPT = `Photo of a Thai fuel-station tax invoice / receipt (ใบกำกับภาษี/ใบเสร็จรับเงิน). Return these fields as printed:
- invoice: the document number after "เลขที่" near the top (e.g. ต26010100012345).
- replaces: when the slip says it cancels and replaces an earlier invoice ("ยกเลิกและออกใบกำกับภาษีฉบับใหม่แทนฉบับเดิม เลขที่ ..."), that earlier number; otherwise "".
- date: the sale date ("วันที่", not "วันที่พิมพ์") as YYYY-MM-DD with a Gregorian year (a Buddhist year minus 543).
- plate: the vehicle registration after "ทะเบียนรถ", with its province.
- liters: the fuel quantity ("จำนวน") with every decimal printed; pricePerLiter: the price per unit; amount: the total paid including VAT ("รวมทั้งสิ้น"). Digits and one dot only, no commas.
- station: the seller printed at the very top (the fuel company, e.g. "บริษัท ตัวอย่างปิโตรเลียม จำกัด") plus its station line (e.g. "00001-สาขาตัวอย่าง กม.1"). Never the buyer, whose company follows the date.
- sellerTaxId: the seller's tax ID ("เลขประจำตัวผู้เสียภาษี" / "TAX ID" printed with the seller at the top, not the buyer's), digits only.
- buyerTaxId: the customer's tax ID ("เลขประจำตัวผู้เสียภาษี" of the buyer, not the seller), digits only.
Use "" for anything not printed or not readable. Never guess.`;
const S = { type: "string" };
const FIELDS = ["invoice", "replaces", "date", "plate", "liters", "pricePerLiter", "amount", "station", "sellerTaxId", "buyerTaxId"];
const SCHEMA = { type: "object", properties: Object.fromEntries(FIELDS.map((f) => [f, S])), required: FIELDS };

export async function readSlip(jpeg: Buffer): Promise<{ read: SlipRead | null; note: string }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { read: null, note: "" };
  const fail = (why: string) => ({ read: null, note: `${why} กรอกตัวเลขเอง` });
  // null = no answer in time / no connection
  const call = (ms: number) =>
    fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.GEMINI_MODEL || "gemini-3.5-flash-lite"}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: "image/jpeg", data: jpeg.toString("base64") } }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: SCHEMA, temperature: 0 },
      }),
      signal: AbortSignal.timeout(ms),
    }).catch((e) => {
      console.error("[slip]", e instanceof Error ? e.message : e);
      return null;
    });
  try {
    // Gemini at times takes over a minute (seen: 75 s, then 1.5 s) or says "high demand" (503); a second try is
    // usually quick. 20 + 1 + 25 s stays under nginx's 60 s, the filler waiting on the photo.
    let r = await call(20_000);
    if (!r || r.status >= 500) {
      await new Promise((s) => setTimeout(s, 1000));
      r = await call(25_000);
    }
    if (!r) return fail("ตัวอ่านสลิปตอบช้า");
    if (r.status === 429) return fail("ตัวอ่านสลิปใช้ครบโควตาแล้ว");
    if (!r.ok) {
      console.error("[slip]", r.status, (await r.text().catch(() => "")).slice(0, 300));
      return fail(`อ่านสลิปไม่สำเร็จ (${r.status})`);
    }
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const read = parseSlip(j.candidates?.[0]?.content?.parts?.[0]?.text ?? "");
    return read ? { read, note: "" } : fail("อ่านสลิปไม่ออก");
  } catch (e) {
    console.error("[slip]", e instanceof Error ? e.message : e);
    return fail("อ่านสลิปไม่สำเร็จ");
  }
}
