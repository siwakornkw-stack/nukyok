import { prisma } from "@/lib/db";
import { bad, jsonBody, ok, str } from "@/lib/http";
import { apiUser } from "@/lib/session";

// ลองใหม่ was pressed or the office PC finished a step since the page was drawn: Express may now hold documents the
// person has not seen.
const CHANGED = "รายการนี้ถูกเปลี่ยนไปแล้ว (เครื่อง Office อาจเขียนลง Express แล้ว): รีเฟรชหน้า แล้วตรวจเอกสารใน Express ก่อนทำต่อ";

// Office settles an Express order outside the office PC. The page posts the state it showed (seen = status, seenR3 =
// r3Status) and the update is guarded on exactly that state: a row that changed since is refused, never settled in a
// meaning the person did not see.
//   { id, action: "manual", seen, seenR3, note? }  staff keyed it in Express by hand: seen "error" = the failed order
//                                                  (-> manual); seen "written" + seenR3 "error" = its failed R3
//                                                  (r3Status -> manual)
//   { id, action: "cancel", seen, seenR3, note }   void a wrong or test order (seen error / written -> cancelled; not
//                                                  while its R3 is queued for the office PC); documents it already has
//                                                  in Express are voided there by staff. Until then they are still
//                                                  its own: the same-bill check refuses them for another order.
// Neither is counted as a problem any more.
export async function POST(req: Request) {
  const a = await apiUser(["office"]);
  if ("res" in a) return a.res;
  const u = a.user;
  const b = await jsonBody(req);
  const action = str(b.action, 10), note = str(b.note, 300);
  const seen = { id: str(b.id, 40), status: str(b.seen, 10), r3Status: str(b.seenR3, 10) || null };

  if (action === "manual") {
    const by = `(โดย ${u.name})${note ? `: ${note}` : ""}`;
    const data =
      seen.status === "error"
        ? { status: "manual", error: `คีย์ใน Express เองแล้ว ${by}` }
        : seen.status === "written" && seen.r3Status === "error"
          ? { r3Status: "manual", r3Error: `ทำ R3 ใน Express เองแล้ว ${by}` }
          : null;
    if (!data) return bad(CHANGED);
    const n = await prisma.expressOrder.updateMany({ where: seen, data });
    return n.count === 1 ? ok() : bad(CHANGED);
  }

  if (action !== "cancel") return bad("คำสั่งไม่ถูกต้อง");
  if (!note) return bad("ต้องกรอกเหตุผล");
  if (seen.status !== "error" && seen.status !== "written") return bad(CHANGED);
  // The office PC writes a queued R3 in its next run: cancelled meanwhile, that R3 would reach Express unseen (its
  // result names an order no longer written).
  if (seen.r3Status === "queued" || seen.r3Status === "force") return bad("เครื่อง Office กำลังเปิด R3 ของรายการนี้: รอให้เสร็จหรือไม่สำเร็จก่อน แล้วรีเฟรชหน้าค่อยยกเลิก");
  // An R3 already in Express stays shown (staff void it there too); one still to do is dropped with the order, with
  // its error or instruction. An R3 waiting for its H3 may still be written by a run that already took it (it is
  // handed out while waiting): that result is kept on this cancelled order and the Office group told (r3/route.ts).
  const keepR3 = seen.r3Status === "done" || seen.r3Status === "manual";
  const n = await prisma.expressOrder.updateMany({
    where: seen,
    data: { status: "cancelled", error: `ยกเลิกโดย ${u.name}: ${note}`, ...(keepR3 ? {} : { r3Status: null, r3Error: null }) },
  });
  return n.count === 1 ? ok() : bad(CHANGED);
}
