import { after } from "next/server";
import { bad, ok } from "@/lib/http";
import { replyText, signatureOk } from "@/lib/line";

type LineEvent = {
  type?: string;
  replyToken?: string;
  message?: { type?: string; text?: unknown };
  source?: { type?: string; userId?: string; groupId?: string; roomId?: string };
};

// LINE Messaging API webhook. Only "id" is answered, with the sender's LINE ids:
// that is how Office finds LINE_OFFICE_GROUP_ID and ADMIN_LINE_USER_IDS.
// Valid calls get 200 at once (LINE retries otherwise); replies go out after().
export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 1_000_000) return bad("ข้อมูลใหญ่เกินไป", 413);
  const raw = await req.text();
  if (!signatureOk(raw, req.headers.get("x-line-signature"))) return bad("ลายเซ็นไม่ถูกต้อง", 401);
  let events: unknown;
  try {
    events = JSON.parse(raw).events;
  } catch {
    return ok();
  }
  const replies: [string, string][] = [];
  for (const e of (Array.isArray(events) ? events : []) as (LineEvent | null)[]) {
    const text = e?.message?.type === "text" && typeof e.message.text === "string" ? e.message.text : "";
    if (e?.type !== "message" || text.trim().toLowerCase() !== "id" || typeof e.replyToken !== "string") continue;
    const s = e.source ?? {};
    let t = `LINE user id: ${s.userId ?? "-"}`;
    if (s.type === "group") t += `\ngroup id: ${s.groupId}`;
    if (s.type === "room") t += `\nroom id: ${s.roomId}`;
    replies.push([e.replyToken, t]);
  }
  if (replies.length) after(() => Promise.all(replies.map(([token, t]) => replyText(token, t))));
  return ok();
}
