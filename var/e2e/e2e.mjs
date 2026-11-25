// End-to-end smoke test of every flow against a running app with the dev seed
// (DEV_LOGIN=1). Run: node e2e.mjs   (BASE, CRON, EXPRESS, EXPORT env override the secrets; EXPORT = the server's
// EXPORT_SECRET)
import { PrismaClient } from "@prisma/client";
import { createHmac } from "crypto";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BASE, BIG_PNG, JPG, PDF, bearer, check, done, form, json, login, page } from "./e2e-lib.mjs";

const CRON = process.env.CRON || "dev-cron";
const EXPRESS = process.env.EXPRESS || "dev-express";
const EXPORT = process.env.EXPORT || "dev-export";
const db = new PrismaClient();
const bkk = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(d);
// the date on a tax invoice (fuel slip, garage bill): today, so its VAT month is still open
const today = () => bkk(new Date());
// "YYYY-MM" k months from this Bangkok month
const month = (k) => new Date(Date.UTC(Number(today().slice(0, 4)), Number(today().slice(5, 7)) - 1 + k, 1)).toISOString().slice(0, 7);
// the quotation the exec / purchasing page would show (decide and re-quote send it back)
const qa = async (id) => (await db.repairRequest.findUnique({ where: { id } })).quotedAt?.toISOString() ?? "";
// the version of a fill the Office page shows; approve sends it back (reviewedAt "" = never returned, flag codes)
const shown = async (id) => {
  const f = await db.fuelRequest.findUnique({ where: { id } });
  return { reviewedAt: f.reviewedAt?.toISOString() ?? "", flags: (Array.isArray(f.flags) ? f.flags : []).map((x) => String(x?.code ?? "")).join(",") };
};
// the export token of one kind (exportToken in lib/csv): a sheet's formula opens only its own kind
const tok = (kind) => createHmac("sha256", EXPORT).update(kind).digest("hex").slice(0, 32);
// page text without the <!-- --> React puts between text parts (counts in tabs, chips)
const listText = async (who, p) => (await page(who, p)).text.replace(/<!-- -->/g, "");

const users = Object.fromEntries((await db.user.findMany()).map((u) => [u.lineUserId.replace("dev-", ""), u]));
const v = Object.fromEntries((await db.vehicle.findMany()).map((x) => [x.code, x]));
const c = {};
for (const k of ["office", "driver", "driver2", "filler", "exec", "purchasing", "accounting", "new"]) c[k] = await login(users[k].id);

console.log("pages");
const PAGES = {
  driver: ["/", "/driver/attendance", "/driver/fuel", "/driver/repair", "/driver/my"],
  filler: ["/filler"],
  office: ["/office/fuel", "/office/users", "/office/vehicles", `/office/vehicles/${v["SY140-01"].id}`, "/office/attendance", "/office/costs", "/office/express", "/purchasing/repairs"],
  exec: ["/exec/repairs", "/office/costs"],
  purchasing: ["/purchasing/repairs", "/purchasing/prices"],
  accounting: ["/office/express", "/office/costs", "/office/fuel"],
};
for (const [who, list] of Object.entries(PAGES)) for (const p of list) {
  const r = await page(c[who], p);
  check(r.status === 200, `${who} GET ${p} -> ${r.status}${r.location ? " " + r.location : ""}`);
}
check((await page(c.driver, "/office/users")).location.includes("denied"), "driver cannot open /office/users");
check((await page(c.new, "/driver/fuel")).location.endsWith("/register"), "pending user is sent to /register");
check((await page("", "/driver/fuel")).location.includes("/login"), "anonymous is sent to /login");
check((await json(c.driver, "/api/fuel/x/review", { action: "approve" })).status === 403, "driver cannot review fuel");
const health = await fetch(`${BASE}/api/health`);
check(health.status === 200 && (await health.json().catch(() => ({}))).ok === true, "GET /api/health answers ok without a session");
check((await fetch(`${BASE}/_next/image?url=%2Ffavicon.ico&w=64&q=75`)).status === 404, "the image optimizer is off (/_next/image 404)");
// a page on another site (its Origin) cannot use a signed-in browser's cookie, nor the dev login
const evil = { Origin: "http://evil.example", "Content-Type": "application/json" };
check((await fetch(`${BASE}/api/ai/key`, { method: "POST", headers: { ...evil, Cookie: c.office }, body: JSON.stringify({ action: "create" }) })).status === 403, "a signed-in call from another site's page is refused");
check((await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: evil, body: JSON.stringify({ userId: users.office.id }) })).status === 403, "the dev login refuses another site's page");
const liff = await page(c.driver, `/liff/driver/repair?vehicle=${v["SY140-01"].id}&pm=1`);
check(liff.location.endsWith(`/driver/repair?vehicle=${v["SY140-01"].id}&pm=1`), "a LIFF link with a session goes on to its page, its query kept", liff);

console.log("registration");
let r = await form(c.new, "/api/auth/register", { name: "verify at line.me", phone: "081-234-5678", role: "driver" });
check(r.status === 400, "a registration name holding a link is refused (the Office group would show it)", r.body);
r = await form(c.new, "/api/auth/register", { name: "ผู้สมัคร ใหม่", phone: "081-234-5678", role: "driver" });
check(r.status === 200, "register", r.body);
// what the Office page showed of the user (status, roles, registration): a page left open cannot undo a later change
const shownNew = { was: "pending", wasRoles: "", wasName: "ผู้สมัคร ใหม่", wasPhone: "081-234-5678", wasRequest: "driver" };
r = await form(c.office, `/api/users/${users.new.id}`, { roles: "driver", status: "active", ...shownNew });
check(r.status === 200, "office approves", r.body);
check((await db.user.findUnique({ where: { id: users.new.id } })).status === "active", "user active");
r = await form(c.office, `/api/users/${users.new.id}`, { roles: "driver", status: "active", ...shownNew });
check(r.status === 400 && /รีเฟรช/.test(r.body.error || ""), "an approval from a page that still shows the user pending is refused", r.body);
r = await form(c.office, `/api/users/${users.office.id}`, { roles: "driver", status: "active", was: "active", wasRoles: "office" });
check(r.status === 400 && /แก้บทบาทของตัวเองไม่ได้/.test(r.body.error || ""), "office cannot drop own office role", r.body);

console.log("attendance");
await db.attendance.deleteMany({ where: { userId: users.driver.id } });
r = await form(c.driver, "/api/attendance", { action: "out", photo: JPG });
check(r.status === 400, "out before in is refused", r.body);
r = await form(c.driver, "/api/attendance", { action: "in", photo: JPG, lat: "7.88", lng: "98.39" });
check(r.status === 200, "clock in", r.body);
r = await form(c.driver, "/api/attendance", { action: "in", photo: JPG });
check(r.status === 400 && /วันละ 1 รอบ/.test(r.body.error || ""), "second clock in refused", r.body);
await db.attendance.deleteMany({ where: { userId: users.driver2.id } });
await db.attendance.create({
  data: { userId: users.driver2.id, workDate: new Date(`${bkk(new Date(Date.now() - 86_400_000))}T00:00:00Z`), inAt: new Date(Date.now() - 20 * 3_600_000), inPhoto: "x.jpg" },
});
r = await form(c.driver2, "/api/attendance", { action: "in", photo: JPG });
check(r.status === 200, "a forgotten shift from yesterday does not block clocking in", r.body);

console.log("fuel: request -> fill -> return -> refill -> approve");
const ask1 = { vehicleId: v["SY140-01"].id, engineHours: "1100", photo: JPG, remember: "on" };
r = await form(c.driver, "/api/fuel", { ...ask1, odometer: "5000" });
check(r.status === 400 && /รูปเลขไมค์/.test(r.body.error || ""), "an odometer without its photo is refused", r.body);
r = await form(c.driver, "/api/fuel", { ...ask1, odoPhoto: JPG });
check(r.status === 400 && /เลขไมค์/.test(r.body.error || ""), "an odometer photo without the number is refused", r.body);
r = await form(c.driver, "/api/fuel", { ...ask1, odometer: "5000", odoPhoto: JPG });
check(r.status === 200, "driver asks for fuel (hours, odometer, both photos)", r.body);
let fr = await db.fuelRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check(fr?.status === "waiting", "status waiting");
check(Number(fr.driverHours) === 1100 && Number(fr.driverOdometer) === 5000 && !!fr.odoPhoto, "the driver's readings and odometer photo are kept", fr);
check((await db.user.findUnique({ where: { id: users.driver.id } })).rememberVehicleId === v["SY140-01"].id, "vehicle remembered");
const fill1 = { engineHours: "1100.5", liters: "100", pricePerLiter: "30", amount: "3000", source: "pump", supplierName: "ปั๊มทดสอบ", invoice: "ต2611090001", invoiceDate: today(), slip: JPG, odometer: "5003" };
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, fill1);
check(r.status === 400 && /หน้าปัดตอนเติม/.test(r.body.error || ""), "a fill without the filler's dash photo is refused", r.body);
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { ...fill1, fillDash: JPG, odometer: "" });
check(r.status === 400 && /เลขไมค์/.test(r.body.error || ""), "a fill without the odometer the driver gave is refused", r.body);
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { ...fill1, fillDash: JPG });
check(r.status === 200, "filler fills", r.body);
fr = await db.fuelRequest.findUnique({ where: { id: fr.id } });
check(fr.status === "filled", "status filled");
check(Number(fr.engineHours) === 1100.5 && Number(fr.driverHours) === 1100 && Number(fr.odometer) === 5003 && !!fr.fillDashPhoto, "the pump readings sit next to the driver's", fr);
check(!fr.flags.some((f) => /_driver$/.test(f.code)), "a pump reading a little above the driver's is not flagged", fr.flags);
const dash1 = fr.fillDashPhoto;
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "return", note: "ยอดไม่ชัด" });
check(r.status === 200, "office returns", r.body);
// no slip attached: the form posts the key of the slip it was filled against (slipKey)
const refill = { engineHours: "1100.5", liters: "100", pricePerLiter: "30", amount: "3000", source: "pump", supplierName: "ปั๊มทดสอบ", invoice: "ต2611090001", invoiceDate: today(), odometer: "5003" };
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { ...refill, slipKey: "sending" });
check(r.status === 400 && /รอให้ส่งรูปสลิป/.test(r.body.error || ""), "a save while the slip photo is still sending is refused", r.body);
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { ...refill, slipKey: "fuel-slip/2026-01/another.jpg" });
check(r.status === 400 && /รูปสลิปถูกเปลี่ยน/.test(r.body.error || ""), "a save against another slip than the one kept is refused", r.body);
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { ...refill, slipKey: (await db.fuelRequest.findUnique({ where: { id: fr.id } })).slipPhoto });
check(r.status === 200 && (await db.fuelRequest.findUnique({ where: { id: fr.id } })).fillDashPhoto === dash1, "filler refills without a new slip or dash photo", r.body);
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve" });
check(r.status === 400, "an approval without the version the page showed is refused", r.body);
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve", ...(await shown(fr.id)), reviewedAt: "" });
check(r.status === 400 && /รีเฟรช/.test(r.body.error || ""), "an approval from a page loaded before the return is refused", r.body);
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve", ...(await shown(fr.id)), flags: "stale_code" });
check(r.status === 400 && /รีเฟรช/.test(r.body.error || ""), "an approval from a page that showed other flags is refused", r.body);
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve", ...(await shown(fr.id)) });
check(r.status === 200, "office approves (no Express masters yet)", r.body);
check((await db.fuelRequest.findUnique({ where: { id: fr.id } })).status === "approved", "status approved");
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve", ...(await shown(fr.id)) });
check(r.status === 400, "second approve refused", r.body);

console.log("fuel: driver cancels own waiting request");
r = await form(c.driver, "/api/fuel", { vehicleId: v["SY140-01"].id, engineHours: "1101", photo: JPG, remember: "on" });
const cx = await db.fuelRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check((await json(c.driver2, `/api/fuel/${cx.id}/cancel`, {})).status === 400, "another driver cannot cancel it");
check((await json(c.filler, `/api/fuel/${cx.id}/cancel`, {})).status === 403, "only a driver uses the driver cancel");
r = await json(c.driver, `/api/fuel/${cx.id}/cancel`, {});
check(r.status === 200 && (await db.fuelRequest.findUnique({ where: { id: cx.id } })).status === "cancelled", "driver cancels own waiting request", r.body);
check((await json(c.driver, `/api/fuel/${cx.id}/cancel`, {})).status === 400, "a cancelled request cannot be cancelled again");
check((await json(c.driver, `/api/fuel/${fr.id}/cancel`, {})).status === 400, "an approved request cannot be cancelled by the driver");

console.log("express: masters -> fuel PK/H3 -> R3");
// repair suppliers as the agent sends them: vat = a tax ID in Express (its bill can be a tax invoice)
const MASTERS = {
  fuel: { suppliers: [{ code: "บ015", name: "บางจาก", vat: true }], items: [{ code: "140 SY", desc: "น้ำมัน SY140", depCode: "03", stock: false, vatClaim: true }], writer: true },
  repair: {
    suppliers: [
      { code: "อ001", name: "อู่ช่างเอก", vat: true },
      { code: "ร003", name: "ร้านยางทดสอบ", vat: false },
    ],
    items: [{ code: "SV-REPAIR", desc: "ค่าซ่อม", depCode: "03", stock: false, vatClaim: true }],
    writer: true,
  },
};
r = await bearer(EXPRESS, "/api/express/masters", MASTERS);
check(r.status === 200, "masters saved", r.body);
check((await bearer("wrong", "/api/express/fuel")).status === 401, "express API needs the secret");
// the fuel writer turned off on the office PC: bills waiting for it become errors a person settles
let queuedBill = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: {}, createdBy: "e2e" } });
r = await bearer(EXPRESS, "/api/express/masters", { ...MASTERS, fuel: { ...MASTERS.fuel, writer: false } });
check(r.status === 200 && (await db.expressOrder.findUnique({ where: { id: queuedBill.id } })).status === "error", "masters with the fuel writer off turn its queued bills into errors", r.body);
check((await bearer(EXPRESS, "/api/express/masters", MASTERS)).status === 200, "masters saved again with the writer on");
await db.expressOrder.delete({ where: { id: queuedBill.id } });
// a bill whose VAT month closed while it waited is not handed out (its input VAT would go into a filed month)
queuedBill = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: { withH3: true, date: `${month(-3)}-10`, invoice: "LATE-E2E" }, createdBy: "e2e" } });
r = await bearer(EXPRESS, "/api/express/fuel");
check(
  r.status === 200 && !r.body.orders?.some((o) => o.id === queuedBill.id) && (await db.expressOrder.findUnique({ where: { id: queuedBill.id } })).status === "error",
  "a bill of a closed VAT month is not handed out: it becomes an error",
  r.body
);
await db.expressOrder.delete({ where: { id: queuedBill.id } });
await db.vehicle.update({ where: { id: v["SY140-01"].id }, data: { expressItem: "140 SY", expressDep: "03" } });
r = await form(c.driver, "/api/fuel", { vehicleId: v["SY140-01"].id, engineHours: "1103", photo: JPG });
fr = await db.fuelRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
r = await form(c.filler, `/api/fuel/${fr.id}/fill`, { fillDash: JPG, engineHours: "1105", liters: "200", pricePerLiter: "32.5", amount: "6500", source: "pump", supplierCode: "บ015", invoice: "ต2611090002", invoiceDate: today(), slip: JPG, odometer: "5100" });
check(r.status === 200, "fill 2", r.body);
fr = await db.fuelRequest.findUnique({ where: { id: fr.id } });
check(Array.isArray(fr.flags) && fr.flags.length > 0, "flags raised (fills 5 h apart, 40 L/h)", fr.flags);
check(fr.flags.some((f) => f.code === "hours_driver" && /1,103/.test(f.text)), "2 engine hours more at the pump than the driver typed a moment ago is flagged", fr.flags);
r = await json(c.office, `/api/fuel/${fr.id}/review`, { action: "approve", ...(await shown(fr.id)) });
check(r.status === 200 && r.body.express === "queued", "approve queues PK + H3", r.body);
r = await bearer(EXPRESS, "/api/express/fuel");
const fo = r.body.orders?.find((o) => o.invoice === "2611090002");
check(!!fo && fo.withH3 === true && fo.supplier === "บ015" && fo.item === "140 SY" && fo.liters === 200 && fo.amount === 6500, "agent gets the fuel order", r.body);
check(fo?.date === today(), "the PK / H3 is dated by the tax invoice date typed at the pump", fo);
r = await bearer(EXPRESS, "/api/express/fuel", { results: [{ id: fo?.id, status: "done", pkNo: "PK0000101", h3No: "H3691109-01" }] });
check(r.body.applied === 1, "agent reports PK + H3", r.body);
r = await bearer(EXPRESS, "/api/express/r3");
check(r.body.po?.includes("PK0000101"), "R3 queue has the PK", r.body);
r = await bearer(EXPRESS, "/api/express/r3", { results: [{ po: "PK0000101", status: "error", error: "อาจซ้ำ: R3691109-01 ..." }] });
const eo = await db.expressOrder.findFirst({ where: { poNo: "PK0000101" } });
check(eo.r3Status === "error", "R3 error kept");
r = await json(c.accounting, "/api/express/retry", { id: eo.id, force: true });
check(r.status === 200 && (await db.expressOrder.findUnique({ where: { id: eo.id } })).r3Status === "force", "accounting confirms not a duplicate", r.body);
r = await bearer(EXPRESS, "/api/express/r3");
check(r.body.force?.includes("PK0000101"), "force handed to the agent", r.body);
r = await bearer(EXPRESS, "/api/express/r3", { results: [{ po: "PK0000101", status: "done", docNo: "R3691109-01" }] });
check((await db.expressOrder.findUnique({ where: { id: eo.id } })).r3No === "R3691109-01", "R3 done");

console.log("audit fixes: queue later, tank price, webhook size, alert job");
const first = await db.fuelRequest.findFirst({ where: { invoice: "ต2611090001" } });
r = await json(c.accounting, "/api/express/queue-fuel", { id: first.id });
check(r.status === 200 && /ยังส่งเข้า Express ไม่ได้/.test(r.body.notice || ""), "approved fill without Express can be retried and says why", r.body);
check((await page(c.accounting, "/office/express")).text.includes("ยังไม่ได้ส่งเข้า"), "express page lists approved fills not in Express");
r = await json(c.accounting, "/api/express/queue-fuel", { id: first.id, manual: true });
check(r.status === 200 && r.body.manual === true, "accounting marks a fill as keyed in Express by hand", r.body);
const mo = await db.expressOrder.findFirst({ where: { fuelRequestId: first.id } });
check(mo?.status === "manual", "a manual ExpressOrder is kept", mo);
check((await json(c.accounting, "/api/express/queue-fuel", { id: first.id, manual: true })).status === 400, "a fill already marked cannot be marked again");
check((await json(c.accounting, "/api/express/retry", { id: mo.id })).status === 400, "a manual order cannot be retried");
check(!(await bearer(EXPRESS, "/api/express/fuel")).body.orders?.some((o) => o.id === mo.id), "a manual order is never handed to the agent");
check(!(await page(c.accounting, "/office/express")).text.includes("ยังไม่ได้ส่งเข้า"), "the fill left the not-sent list");
r = await form(c.driver2, "/api/fuel", { vehicleId: v["70-1826"].id, engineHours: "300", photo: JPG });
const tankReq = await db.fuelRequest.findFirst({ where: { driverId: users.driver2.id }, orderBy: { createdAt: "desc" } });
r = await form(c.filler, `/api/fuel/${tankReq.id}/fill`, { fillDash: JPG, engineHours: "300", liters: "50", source: "tank" });
check(r.status === 400 && /ราคาต่อลิตร/.test(r.body.error || ""), "tank fill needs a price", r.body);
r = await form(c.filler, `/api/fuel/${tankReq.id}/fill`, { fillDash: JPG, engineHours: "300", liters: "50", pricePerLiter: "30", source: "tank" });
check(r.status === 200 && Number((await db.fuelRequest.findUnique({ where: { id: tankReq.id } })).amount) === 1500, "tank fill amount computed from litres x price", r.body);
const big = await fetch(`${BASE}/api/line/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-line-signature": "x" }, body: "x".repeat(1_500_000) });
check(big.status === 413, `webhook refuses a 1.5 MB body (${big.status})`);
r = await bearer(CRON, "/api/cron/alert", { text: "ทดสอบ e2e" });
check(r.status === 200 && r.body.sent === true, "cron alert job sends to Office", r.body);

console.log("duplicate bill: same tax invoice twice");
r = await form(c.driver2, "/api/fuel", { vehicleId: v["SY55-02"].id, engineHours: "500", photo: JPG });
let dup = await db.fuelRequest.findFirst({ where: { driverId: users.driver2.id }, orderBy: { createdAt: "desc" } });
r = await form(c.filler, `/api/fuel/${dup.id}/fill`, { fillDash: JPG, engineHours: "500", liters: "200", pricePerLiter: "32.5", amount: "6500", source: "pump", supplierCode: "บ015", invoice: "ต2611090002", invoiceDate: today(), slip: JPG });
dup = await db.fuelRequest.findUnique({ where: { id: dup.id } });
check(dup.flags.some((f) => f.code === "invoice_dup"), "same invoice flagged", dup.flags);
await db.vehicle.update({ where: { id: v["SY55-02"].id }, data: { expressItem: "140 SY", expressDep: "03" } });
r = await json(c.office, `/api/fuel/${dup.id}/review`, { action: "approve", ...(await shown(dup.id)) });
check(r.body.express === "queued", "duplicate approved and queued", r.body);
const dupOrder = (await bearer(EXPRESS, "/api/express/fuel")).body.orders?.find((o) => o.id && o.liters === 200 && o.amount === 6500);
r = await bearer(EXPRESS, "/api/express/fuel", { results: [{ id: dupOrder?.id, status: "done", pkNo: "PK0000101", h3No: "H3691109-01" }] });
const dupRow = await db.expressOrder.findUnique({ where: { id: dupOrder.id } });
check(dupRow.status === "error" && /อีกรายการ/.test(dupRow.error), "planner's 'exists' pointing at another order's PK/H3 is an error, not booked", dupRow);
const lo = await fetch(`${BASE}/api/auth/logout`, { method: "POST", redirect: "manual" });
check(lo.status === 303 && lo.headers.get("location") === "/login", "logout redirects to a relative /login", lo.headers.get("location"));

console.log("express: retry from the vehicle, settled by Office, VAT month filed");
// ลองใหม่ builds the order again from the fill, its vehicle and the masters: a department Express lacks stays an error
await db.vehicle.update({ where: { id: v["SY55-02"].id }, data: { expressDep: "C01" } });
r = await json(c.accounting, "/api/express/retry", { id: dupRow.id });
check(
  r.status === 200 && /ยังส่งเข้า Express ไม่ได้: แผนก C01/.test(r.body.notice || "") && (await db.expressOrder.findUnique({ where: { id: dupRow.id } })).status === "error",
  "a retry rebuilds the order from the vehicle: a department not in Express is not queued, and it says why",
  r.body
);
await db.vehicle.update({ where: { id: v["SY55-02"].id }, data: { expressDep: "03" } });
// the page posts the state it showed (seen / seenR3); only Office settles
const twinSeen = { id: dupRow.id, action: "manual", seen: "error", seenR3: "" };
check((await json(c.accounting, "/api/express/close", twinSeen)).status === 403, "only Office settles an Express order by hand");
check((await listText(c.office, "/office/express")).includes("ไม่สำเร็จ (1)"), "the twin counts as a problem");
r = await json(c.office, "/api/express/close", twinSeen);
check(
  r.status === 200 && (await db.expressOrder.findUnique({ where: { id: dupRow.id } })).status === "manual" && (await listText(c.office, "/office/express")).includes("ไม่สำเร็จ (0)"),
  "Office marks the twin as keyed in Express by hand: no longer a problem",
  r.body
);
const eoSeen = { id: eo.id, action: "cancel", seen: "written", seenR3: "done" };
check((await json(c.office, "/api/express/close", { ...eoSeen, note: "" })).status === 400, "cancelling an Express order needs a reason");
r = await json(c.office, "/api/express/close", { ...eoSeen, note: "บิลทดสอบ" });
check(r.status === 200 && (await db.expressOrder.findUnique({ where: { id: eo.id } })).status === "cancelled", "Office cancels a written order (a test bill)", r.body);
// a cancelled order's documents stay live in Express until staff void them: the same PK / H3 reported for another
// order is held for Office with its own text; sharing one number only (another company's numbering) is booked
const reuse = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: {}, createdBy: "e2e" } });
r = await bearer(EXPRESS, "/api/express/fuel", { results: [{ id: reuse.id, status: "done", pkNo: "PK0000101", h3No: "H3691109-01" }] });
const reused = await db.expressOrder.findUnique({ where: { id: reuse.id } });
check(r.body.applied === 1 && reused.status === "error" && reused.error.startsWith("เอกสาร PK0000101 H3691109-01 ใน Express ยังเป็นของรายการที่ยกเลิกแล้ว"), "the cancelled order's live PK / H3 reported again is held for Office", reused);
await db.expressOrder.delete({ where: { id: reuse.id } });
const reuse2 = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: {}, createdBy: "e2e" } });
r = await bearer(EXPRESS, "/api/express/fuel", { results: [{ id: reuse2.id, status: "done", pkNo: "PK0000999", h3No: "H3691109-01" }] });
check(r.body.applied === 1 && (await db.expressOrder.findUnique({ where: { id: reuse2.id } })).status === "written", "a number shared only in part with a cancelled order is booked", r.body);
await db.expressOrder.delete({ where: { id: reuse2.id } });
// ภ.พ.30 filed through a month before this one (Office only); put back afterwards
check((await form(c.accounting, "/api/express/vat-month", { month: month(-1) })).status === 403, "only Office marks a VAT month as filed");
check((await form(c.office, "/api/express/vat-month", { month: month(0) })).status === 400, "this month cannot be marked as filed");
r = await form(c.office, "/api/express/vat-month", { month: month(-1) });
check(r.status === 200 && (await db.appSetting.findUnique({ where: { key: "vat_filed_through" } }))?.value === month(-1), "Office marks last month's VAT return as filed", r.body);
await db.appSetting.deleteMany({ where: { key: "vat_filed_through" } });

console.log("repair: request -> quote -> approve -> cost (Express) -> done -> reopen -> done -> close");
r = await form(c.driver, "/api/repairs", { vehicleId: v["SY55-02"].id, symptom: "รูปใหญ่เกิน", urgency: "normal", photos: [BIG_PNG] });
check(r.status === 400 && /รูปใหญ่เกินไป/.test(r.body.error || ""), "a photo far over the pixel limit is refused from its header", r.body);
r = await form(c.driver, "/api/repairs", { vehicleId: v["SY55-02"].id, symptom: "ไฮดรอลิครั่ว", cause: "ซีลแตก", odometer: "450", urgency: "urgent", photos: [JPG, JPG] });
check(r.status === 200, "driver reports", r.body);
let rr = await db.repairRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check(rr?.status === "quote" && rr.photos.length === 2, "status quote with 2 photos");
r = await form(c.purchasing, `/api/repairs/${rr.id}/quote`, { quoteAmount: "10700", quoteNote: "ซีล + ค่าแรง", quoteFiles: [PDF, JPG] });
check(r.status === 200, "purchasing quotes", r.body);
r = await json(c.driver, `/api/repairs/${rr.id}/decide`, { approve: true });
check(r.status === 403, "driver cannot approve", r.body);
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: true, note: "" });
check(r.status === 400, "a decision without the quotation it was made on is refused", r.body);
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: true, note: "", quotedAt: await qa(rr.id) });
check(r.status === 200, "exec approves", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, { costAmount: "20000", vatMode: "2", costDetail: "เกิน", supplierCode: "อ001", itemCode: "SV-REPAIR", invoice: "IV999", invoiceDate: today(), billFiles: [PDF] });
check(r.status === 400 && /เกิน 5%/.test(r.body.error || ""), "cost above the approved quote is refused", r.body);
const oldQuote = await qa(rr.id);
r = await form(c.purchasing, `/api/repairs/${rr.id}/quote`, { quoteAmount: "11000", quoteNote: "ราคาเปลี่ยน", quoteFiles: [PDF], seen: oldQuote });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rr.id } })).status === "approval", "re-quote sends it back to the exec", r.body);
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: true, note: "", quotedAt: oldQuote });
check(r.status === 400 && /รีเฟรช/.test(r.body.error || ""), "an approval from a page that still shows the old quote is refused", r.body);
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: true, note: "", quotedAt: await qa(rr.id) });
check(r.status === 200, "exec approves the new price", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/quote`, { quoteAmount: "12000", quoteFiles: [PDF], seen: "" });
check(r.status === 400 && Number((await db.repairRequest.findUnique({ where: { id: rr.id } })).quoteAmount) === 11000, "a stale first-quote form does not replace the approved quote", r.body);
const costForm = { costAmount: "10700", costDetail: "เปลี่ยนซีล", supplierCode: "อ001", itemCode: "SV-REPAIR", invoice: "IV200", invoiceDate: today(), billFiles: [PDF] };
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, { ...costForm, vatMode: "2", invoiceDate: "" });
check(r.status === 400 && /วันที่ในใบกำกับภาษี/.test(r.body.error || ""), "a cost without the tax invoice's date is refused", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, costForm);
check(r.status === 400 && /VAT/.test(r.body.error || ""), "a cost for an Express supplier without the bill's VAT is refused", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, { ...costForm, supplierCode: "ร003", vatMode: "1" });
check(r.status === 400 && /ไม่มีเลขประจำตัวผู้เสียภาษี/.test(r.body.error || ""), "a bill with VAT from a supplier without a tax ID in Express is refused", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, { ...costForm, costAmount: "1000.07", vatMode: "2" });
check(r.status === 400 && /ไม่ลงตัว/.test(r.body.error || ""), "a VAT-on-top total no price gives is refused", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/cost`, { ...costForm, vatMode: "2" });
check(r.status === 200 && r.body.express === "queued", "cost saved, PO + RR queued", r.body);
r = await bearer(EXPRESS, "/api/express/repair");
const ro = r.body.orders?.find((o) => o.invoice === "IV200");
check(!!ro && ro.amount === 10700 && ro.vat === "2" && ro.dep === "03" && ro.item === "SV-REPAIR" && ro.job === "เปลี่ยนซีล" && ro.plate === "SY55-02", "agent gets the repair order (VAT mode, work + plate for YOUREF)", r.body);
check(ro?.date === today(), "the PO / RR is dated by the tax invoice date typed", ro);
r = await bearer(EXPRESS, "/api/express/repair", { results: [{ id: ro?.id, status: "done", poNo: "PO0000101", rrNo: "RR691109-02" }] });
check(r.body.applied === 1, "agent reports PO + RR (exec + accounting told)", r.body);
const rro = await db.expressOrder.findFirst({ where: { poNo: "PO0000101" } });
check(rro.status === "written" && rro.h3No === "RR691109-02" && rro.r3Status === null, "repair written, RR kept, no R3 step", rro);
r = await bearer(EXPRESS, "/api/express/r3");
check(!r.body.po?.includes("PO0000101"), "R3 queue does not have the repair PO", r.body);
r = await json(c.purchasing, `/api/repairs/${rr.id}/done`, {});
check(r.status === 200, "repair done", r.body);
r = await json(c.driver2, `/api/repairs/${rr.id}/accept`, { pass: true });
check(r.status >= 400, "another driver cannot accept", r.body);
r = await json(c.driver, `/api/repairs/${rr.id}/accept`, { pass: false, note: "ยังรั่ว" });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rr.id } })).status === "repairing", "driver rejects -> repairing", r.body);
await json(c.purchasing, `/api/repairs/${rr.id}/done`, {});
r = await json(c.driver, `/api/repairs/${rr.id}/accept`, { pass: true });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rr.id } })).status === "closed", "driver accepts -> closed", r.body);
r = await form(c.driver, "/api/repairs", { vehicleId: v["70-1826"].id, symptom: "ยางรั่ว", urgency: "normal", photos: [JPG] });
rr = await db.repairRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
await form(c.purchasing, `/api/repairs/${rr.id}/quote`, { quoteAmount: "500", quoteFiles: [JPG] });
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: false, note: "", quotedAt: await qa(rr.id) });
check(r.status === 400 && /เหตุผล/.test(r.body.error || ""), "reject needs a note", r.body);
r = await json(c.exec, `/api/repairs/${rr.id}/decide`, { approve: false, note: "ใช้ยางเก่าได้", quotedAt: await qa(rr.id) });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rr.id } })).status === "rejected", "exec rejects", r.body);
r = await form(c.purchasing, `/api/repairs/${rr.id}/quote`, { quoteAmount: "350", quoteNote: "ยางมือสอง", quoteFiles: [JPG], seen: await qa(rr.id) });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rr.id } })).status === "approval", "purchasing can send a new quote after a reject", r.body);

console.log("repair: cancel, close by purchasing, service cycle");
// a cause typed like a spreadsheet formula: the CSV export must write it as text (checked under export)
r = await form(c.driver, "/api/repairs", { vehicleId: v["70-1826"].id, symptom: "แจ้งซ้ำ", cause: "=1+1, ซ้ำ", urgency: "canwait", photos: [JPG] });
let rc = await db.repairRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check((await json(c.purchasing, `/api/repairs/${rc.id}/cancel`, { note: "" })).status === 400, "cancel needs a reason");
r = await json(c.purchasing, `/api/repairs/${rc.id}/cancel`, { note: "แจ้งซ้ำกับ #1" });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rc.id } })).status === "cancelled", "purchasing cancels a repair", r.body);
const rcx = await db.repairRequest.findUnique({ where: { id: rc.id } });
check(rcx.endNote === "แจ้งซ้ำกับ #1" && rcx.endedBy === users.purchasing.name && !!rcx.closedAt, "the cancel reason and who cancelled are kept", rcx);
check((await page(c.purchasing, `/purchasing/repairs/${rc.id}`)).text.includes("แจ้งซ้ำกับ #1"), "the cancel reason shows on the repair page");
await db.vehicle.update({ where: { id: v["SY140-01"].id }, data: { pmLastHours: 600, pmEveryHours: 500 } });
r = await form(c.driver, "/api/repairs", { vehicleId: v["SY140-01"].id, symptom: "ถึงรอบเช็คระยะ", pmRound: "ถึงรอบเช็คระยะ", fromPm: "1", urgency: "normal", photos: [JPG] });
rc = await db.repairRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check(rc.fromPm === true, "service-due repair marked fromPm");
await form(c.purchasing, `/api/repairs/${rc.id}/quote`, { quoteAmount: "3000", quoteFiles: [JPG] });
check((await json(c.exec, `/api/repairs/${rc.id}/decide`, { approve: true, note: "", quotedAt: await qa(rc.id) })).status === 200, "exec approves the service");
r = await form(c.purchasing, `/api/repairs/${rc.id}/cost`, { costAmount: "3000", costDetail: "เช็คระยะ", supplierName: "อู่ทดสอบ", invoiceDate: today(), billFiles: [PDF] });
check(r.status === 200, "service cost saved", r.body);
// not queued (no Express supplier picked): listed on /office/express and sent later from the repair page
check((await page(c.office, "/office/express")).text.includes("ค่าซ่อมที่บันทึกแล้ว แต่ยังไม่มี PO / RR ใน Express"), "express page lists a costed repair not in Express");
check((await page(c.purchasing, `/purchasing/repairs/${rc.id}`)).text.includes(`/api/repairs/${rc.id}/express`), "the repair page offers ส่งเข้า Express");
const later = { supplierCode: "ร003", itemCode: "SV-REPAIR", invoice: "IV300", invoiceDate: today(), vatMode: "0" };
check((await form(c.driver, `/api/repairs/${rc.id}/express`, later)).status === 403, "a driver cannot send a repair to Express");
r = await form(c.purchasing, `/api/repairs/${rc.id}/express`, { ...later, vatMode: "2" });
check(r.status === 400 && /ไม่มีเลขประจำตัวผู้เสียภาษี/.test(r.body.error || ""), "sent later: VAT from a supplier without a tax ID is refused", r.body);
r = await form(c.purchasing, `/api/repairs/${rc.id}/express`, later);
check(r.status === 200 && r.body.queued === true, "purchasing sends the costed repair to Express later (no VAT)", r.body);
check((await form(c.purchasing, `/api/repairs/${rc.id}/express`, later)).status === 400, "a repair is sent to Express only once");
check((await json(c.office, "/api/express/repair-manual", { id: rc.id })).status === 400, "a repair with an Express order cannot be marked as keyed by hand");
check(!(await page(c.office, "/office/express")).text.includes("ค่าซ่อมที่บันทึกแล้ว แต่ยังไม่มี PO / RR"), "the repair left the not-sent list");
r = await bearer(EXPRESS, "/api/express/repair");
const lro = r.body.orders?.find((o) => o.invoice === "IV300");
check(!!lro && lro.supplier === "ร003" && lro.vat === "0" && lro.amount === 3000 && lro.date === today() && lro.plate === "SY140-01", "agent gets the repair sent later, dated by its tax invoice", r.body);
r = await bearer(EXPRESS, "/api/express/repair", { results: [{ id: lro?.id, status: "done", poNo: "PO0000102", rrNo: "RR691109-03" }] });
check(r.body.applied === 1, "agent reports its PO + RR (exec + accounting told)", r.body);
await json(c.purchasing, `/api/repairs/${rc.id}/done`, {});
r = await json(c.office, `/api/repairs/${rc.id}/close`, { note: "คนขับลาออก" });
check(r.status === 200 && (await db.repairRequest.findUnique({ where: { id: rc.id } })).status === "closed", "office closes a done job for the driver", r.body);
const rcy = await db.repairRequest.findUnique({ where: { id: rc.id } });
check(rcy.endNote === "คนขับลาออก" && rcy.endedBy === users.office.name, "the close reason and who closed are kept", rcy);
check(Number((await db.vehicle.findUnique({ where: { id: v["SY140-01"].id } })).pmLastHours) === 1105, "closing a service repair moves the service cycle to the latest hours");
// the vehicle form writes only the fields changed, each guarded on what the page loaded (was)
r = await form(c.office, `/api/vehicles/${v["SY140-01"].id}`, { was: JSON.stringify({ pmLastHours: "1000", note: "" }), pmLastHours: "1000", note: "รถหลัก" });
const syv = await db.vehicle.findUnique({ where: { id: v["SY140-01"].id } });
check(r.status === 200 && syv.note === "รถหลัก" && Number(syv.pmLastHours) === 1105, "a form loaded before the service saves its own change and keeps the new service hours", r.body);
r = await form(c.office, `/api/vehicles/${v["SY140-01"].id}`, { was: JSON.stringify({ note: "" }), note: "รถสำรอง" });
check(r.status === 409, "a field someone else changed meanwhile is refused", r.body);
r = await form(c.office, `/api/vehicles/${v["SY55-02"].id}`, { was: JSON.stringify({ code: "SY55-02" }), code: "sy 140.01" });
check(r.status === 400 && /SY140-01/.test(r.body.error || ""), "a plate written like another vehicle's is refused", r.body);
// service done at the engine hours the page showed, never another number
check((await json(c.purchasing, `/api/vehicles/${v["SY55-02"].id}`, { action: "pm-done" })).status === 409, "service done without the hours shown is refused");
r = await json(c.purchasing, `/api/vehicles/${v["SY55-02"].id}`, { action: "pm-done", hours: 500 });
check(r.status === 200 && Number((await db.vehicle.findUnique({ where: { id: v["SY55-02"].id } })).pmLastHours) === 500, "service done saves the latest engine hours", r.body);

console.log("cron + export");
check((await bearer("wrong", "/api/cron/tick")).status === 401, "cron needs the secret");
for (const job of ["tick", "daily", "weekly"]) {
  r = await bearer(CRON, `/api/cron/${job}`);
  check(r.status === 200, `cron ${job}`, r.body);
}
// office PC silent for 2 h while an order waits: one alert, not again on the next tick, again after a new silence
const masters = await db.appSetting.findUnique({ where: { key: "express_masters" } });
const oldAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
await db.appSetting.update({ where: { key: "express_masters" }, data: { value: { ...masters.value, at: oldAt } } });
const parked = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: {}, createdBy: "e2e" } });
r = await bearer(CRON, "/api/cron/tick");
check(r.body.expressAgentAlerted === true, "tick alerts the Office when the office PC is silent with work waiting", r.body);
check((await bearer(CRON, "/api/cron/tick")).body.expressAgentAlerted === false, "the silent-PC alert goes out once");
check((await page(c.office, "/office/express")).text.includes("ขาดการติดต่อ"), "express page shows the PC is silent");
await db.expressOrder.delete({ where: { id: parked.id } });
await db.appSetting.update({ where: { key: "express_masters" }, data: { value: { ...masters.value, at: new Date().toISOString() } } });
check(!(await page(c.office, "/office/express")).text.includes("ขาดการติดต่อ"), "express page is calm again once the PC reports");
// the office PC answers but a bill has waited over an hour (a write keeps failing): one alert per jam
const stuck = await db.expressOrder.create({ data: { kind: "repair", status: "queued", payload: {}, createdBy: "e2e" } });
await db.$executeRaw`UPDATE "ExpressOrder" SET "updatedAt" = "updatedAt" - interval '2 hours' WHERE "id" = ${stuck.id}`;
r = await bearer(CRON, "/api/cron/tick");
check(r.body.expressStuckAlerted === true && r.body.expressAgentAlerted === false, "tick alerts the Office when a bill waits over an hour while the office PC answers", r.body);
check((await bearer(CRON, "/api/cron/tick")).body.expressStuckAlerted === false, "the stuck-queue alert goes out once");
await db.expressOrder.delete({ where: { id: stuck.id } });
await db.appSetting.deleteMany({ where: { key: "express_stuck_alert" } });
for (const kind of ["fuel", "repairs", "attendance", "vehicles"]) {
  const res = await fetch(`${BASE}/api/export/${kind}?token=${tok(kind)}`);
  const text = await res.text();
  check(res.status === 200 && text.split("\n").length > 1, `export ${kind} (${text.split("\n").length - 1} rows)`, text.slice(0, 200));
}
check((await fetch(`${BASE}/api/export/fuel?token=wrong`)).status >= 400, "export needs the token");
check((await fetch(`${BASE}/api/export/fuel?token=${EXPORT}`)).status === 403, "the export secret itself opens nothing");
check((await fetch(`${BASE}/api/export/attendance?token=${tok("fuel")}`)).status === 403, "one kind's token does not open another");
const attCsv = await (await fetch(`${BASE}/api/export/attendance?token=${tok("attendance")}`)).text();
check(attCsv.split(/\r?\n/)[0] === "วันที่,ชื่อ,เข้างาน,ออกงาน,ชั่วโมง" && !attCsv.includes("พิกัด"), "the attendance export has no GPS", attCsv.slice(0, 200));
const repCsv = await (await fetch(`${BASE}/api/export/repairs?token=${tok("repairs")}`)).text();
check(repCsv.includes(`"'=1+1, ซ้ำ"`), "a cell typed like a formula is exported as text", repCsv.slice(0, 300));
const home = (await page(c.office, "/")).text;
check(home.includes(`/api/export/attendance?token=${tok("attendance")}`) && home.includes("สูตร Google Sheets"), "Office home shows each sheet's formula with its own token");
check(!(await page(c.driver, "/")).text.includes("IMPORTDATA"), "a driver's home shows no export formula");

console.log("clock out + pages after data");
for (const q of [`?vehicle=${v["SY140-01"].id}&sort=lph`, "?from=2026-10-01&to=2026-10-31", "?month=2026-10", "?month=2026-13", "?from=bad&to=2026-13-40&sort=x&vehicle=x"]) {
  const x = await page(c.office, `/office/costs${q}`);
  check(x.status === 200 && x.text.includes("ชม.ทำงาน"), `cost dashboard ${q}`);
}
// list filters: counts in the status tabs follow the filters (listText drops React's <!-- --> between text parts)
check((await listText(c.office, "/office/fuel?tab=approved")).includes("อนุมัติแล้ว (3)"), "fuel list: 3 approved without filters");
check((await listText(c.office, "/office/fuel?tab=approved&flagged=1")).includes("อนุมัติแล้ว (2)"), "fuel list: flagged only");
check((await listText(c.office, "/office/fuel?tab=approved&q=%E0%B8%952611090001")).includes("อนุมัติแล้ว (1)"), "fuel list: search by tax invoice");
check((await listText(c.office, `/office/fuel?tab=approved&vehicle=${v["SY55-02"].id}`)).includes("อนุมัติแล้ว (1)"), "fuel list: one vehicle");
check((await listText(c.office, "/office/fuel?tab=approved&from=2026-01-01&to=2026-01-31")).includes("ไม่พบรายการตามตัวกรอง"), "fuel list: a date range with nothing in it");
check((await listText(c.office, "/purchasing/repairs?status=closed&q=%E0%B9%84%E0%B8%AE%E0%B8%94%E0%B8%A3%E0%B8%AD")).includes("ปิดงาน (1)"), "repair list: search by symptom");
check((await listText(c.office, "/purchasing/repairs?status=closed&urgency=urgent")).includes("ปิดงาน (1)"), "repair list: urgent only");
check((await listText(c.office, "/purchasing/repairs?status=closed&q=%234")).includes("#4"), "repair list: search by #no");
for (const q of ["/office/fuel?from=x&to=2026-99-99&vehicle=x&flagged=x&q=%27%22", "/purchasing/repairs?status=x&urgency=x&q=%25"]) check((await page(c.office, q)).status === 200, `list ignores bad filter values ${q}`);
const dash = await page(c.office, `/office/costs?vehicle=${v["SY140-01"].id}`);
check(dash.text.includes("2,500.00"), "cost per engine hour of SY140-01 (12,500 baht / 5 h)");
// today's shift stays open past OPEN_SHIFT_HOURS (16): it can still be closed
await db.attendance.updateMany({ where: { userId: users.driver.id, outAt: null }, data: { inAt: new Date(Date.now() - 17 * 3_600_000) } });
r = await form(c.driver, "/api/attendance", { action: "out", photo: JPG });
check(r.status === 200, "clock out of today's shift after 17 h", r.body);
// one shift per Bangkok day: the next clock-in is refused before its photo is kept (UPLOAD_DIR as the server resolves it)
const uploads = path.resolve(fileURLToPath(new URL("../../", import.meta.url)), process.env.UPLOAD_DIR || "var/uploads");
const attendancePhotos = () => readdirSync(path.join(uploads, "attendance"), { recursive: true }).filter((f) => String(f).endsWith(".jpg")).length;
const photosBefore = attendancePhotos();
r = await form(c.driver, "/api/attendance", { action: "in", photo: JPG });
check(r.status === 400 && /วันละ 1 รอบ/.test(r.body.error || ""), "a second shift on the same day is refused", r.body);
check(attendancePhotos() === photosBefore, "a refused clock-in keeps no photo", { photosBefore, now: attendancePhotos() });
const attPage = (await page(c.driver, "/driver/attendance")).text;
check(attPage.includes("เข้างานครั้งต่อไปได้พรุ่งนี้") && !attPage.includes('name="action"'), "the attendance page says the next clock-in is tomorrow and offers no form");
for (const [who, list] of Object.entries(PAGES)) for (const p of list) {
  const x = await page(c[who], p);
  check(x.status === 200, `${who} GET ${p} after data -> ${x.status}`);
}
for (const p of [`/office/fuel/${fr.id}`, `/filler/${fr.id}`]) check((await page(c.office, p)).status === 200 || (await page(c.filler, p)).status === 200, `GET ${p}`);
check((await page(c.purchasing, `/purchasing/repairs/${rr.id}`)).status === 200, "purchasing repair detail");
check((await page(c.exec, `/exec/repairs/${rr.id}`)).status === 200, "exec repair detail");

console.log("เลขา AI API");
r = await json(c.driver, "/api/ai/key", { action: "create" });
const kDriver = r.body.key;
check(/^nk_[A-Za-z0-9_-]{43}$/.test(kDriver || ""), "driver makes an AI key", r.body);
const kOffice = (await json(c.office, "/api/ai/key", { action: "create" })).body.key;
const kExec = (await json(c.exec, "/api/ai/key", { action: "create" })).body.key;
// JSON sent as text/plain (a form another site can post without asking the browser first) is not read
const execKey = (await db.user.findUnique({ where: { id: users.exec.id } })).aiKeyHash;
const plain = await fetch(`${BASE}/api/ai/key`, { method: "POST", headers: { Cookie: c.exec, "Content-Type": "text/plain" }, body: JSON.stringify({ action: "create" }) });
check(plain.status === 400 && (await db.user.findUnique({ where: { id: users.exec.id } })).aiKeyHash === execKey, "a JSON body sent as text/plain is not read (no new key)");
check((await bearer("nk_" + "x".repeat(43), "/api/ai/me")).status === 401, "a wrong AI key is refused");
check((await fetch(`${BASE}/api/ai/me`)).status === 401, "no AI key is refused");
r = await bearer(kDriver, "/api/ai/me");
check(r.status === 200 && r.body.name === users.driver.name, "AI me", r.body);
check((await bearer(kDriver, "/api/ai/costs")).status === 403, "a driver key cannot read costs");
const specRes = await fetch(`${BASE}/api/ai/openapi.json`);
const spec = await specRes.json().catch(() => ({}));
check(specRes.status === 200 && !!spec.paths?.["/api/ai/repairs/decide"], "OpenAPI spec is public");
r = await bearer(kDriver, "/api/ai/fuel", { vehicle: "sy140-01", engineHours: 1110 });
check(r.status === 200 && r.body.no > 0, "driver asks for fuel via AI (vehicle code in any case)", r.body);
const aiFuel = await db.fuelRequest.findUnique({ where: { no: r.body.no ?? 0 } });
check(aiFuel?.status === "waiting" && aiFuel.dashPhoto === "", "the AI fuel request waits, without a dashboard photo", aiFuel);
check((await bearer(kDriver, "/api/ai/fuel", { vehicle: "NOPE", engineHours: 1 })).status === 400, "AI fuel: unknown vehicle refused");
check((await bearer(kDriver, "/api/ai/fuel", { vehicle: "SY140-01", engineHours: "abc" })).status === 400, "AI fuel: bad engine hours refused");
r = await form(c.filler, `/api/fuel/${aiFuel.id}/fill`, { fillDash: JPG, engineHours: "1110", liters: "50", pricePerLiter: "30", source: "tank" });
check(r.status === 200, "filler fills the AI request in the app", r.body);
r = await bearer(kOffice, "/api/ai/pending");
check(r.body.fuelToReview?.some((f) => f.no === aiFuel.no), "office pending lists it for review", r.body);
check(typeof r.body.usersToApprove === "number" && typeof r.body.untrusted === "string", "pending: users to approve as a count only, typed text marked as data", r.body);
check((await bearer(kOffice, "/api/ai/fuel/review", { no: aiFuel.no, action: "return" })).status === 400, "AI return without a note refused");
// the approval is of the amount the person was told: 50 L x 30 baht
r = await bearer(kOffice, "/api/ai/fuel/review", { no: `#${aiFuel.no}`, action: "approve", amount: 1400 });
check(r.status === 409 && /1,500\.00/.test(r.body.error || ""), "an AI approval of another amount is refused and told the current one", r.body);
r = await bearer(kOffice, "/api/ai/fuel/review", { no: `#${aiFuel.no}`, action: "approve", amount: 1500 });
const af = await db.fuelRequest.findUnique({ where: { id: aiFuel.id } });
check(r.status === 200 && af.status === "approved" && af.reviewedBy === `${users.office.name} (เลขา AI)`, "office approves via AI, recorded as เลขา AI", r.body);
check((await bearer(kOffice, "/api/ai/fuel/review", { no: aiFuel.no, action: "approve" })).status === 400, "a second AI approve is refused");
check((await bearer(kDriver, "/api/ai/fuel/review", { no: aiFuel.no, action: "approve" })).status === 403, "a driver key cannot review fuel");
r = await bearer(kOffice, `/api/ai/fuel?no=${aiFuel.no}`);
check(r.body.fuel?.[0]?.status === "อนุมัติแล้ว" && r.body.fuel[0].source === "ถังกลาง", "AI fuel list by no", r.body);
r = await bearer(kOffice, "/api/ai/fuel?flagged=1&limit=5");
check(r.status === 200 && r.body.fuel.length > 0 && r.body.fuel.every((f) => f.flags.length > 0), "AI fuel list: flagged only", r.body);
// a filter that is not valid is refused, never answered as an unfiltered list
for (const q of ["/api/ai/fuel?from=2026-11-31", "/api/ai/fuel?status=pending", "/api/ai/fuel?flagged=true", "/api/ai/repairs?urgency=soon", "/api/ai/attendance?date=2026-02-30", "/api/ai/costs?from=2026-02-30", "/api/ai/summary?period=month"])
  check((await bearer(kOffice, q)).status === 400, `AI ${q} is refused`);
check((await bearer(kOffice, "/api/ai/fuel?vehicle=%25")).status === 404, "AI fuel: '%' matches no vehicle");
r = await bearer(kOffice, "/api/ai/summary?period=week");
check(r.status === 200 && /สรุปประจำสัปดาห์/.test(r.body.text || ""), "AI weekly summary", r.body);
r = await bearer(kOffice, "/api/ai/summary");
check(r.status === 200 && /สรุปประจำวัน/.test(r.body.text || ""), "AI daily summary", r.body);
r = await bearer(kOffice, `/api/ai/costs?from=${bkk(new Date(Date.now() - 30 * 86_400_000))}&to=${bkk(new Date())}`);
check(r.status === 200 && r.body.totals.total > 0 && r.body.vehicles[0].total >= r.body.vehicles.at(-1).total, "AI costs, costliest first", r.body);
check((await bearer(kOffice, "/api/ai/costs?from=2020-01-01&to=2026-01-01")).status === 400, "AI costs: a range over 400 days is refused");
r = await bearer(kOffice, "/api/ai/vehicles?code=SY140-01");
check(r.status === 200 && r.body.vehicle?.code === "SY140-01" && r.body.recentFuel.length > 0, "AI vehicle detail", r.body);
r = await bearer(kOffice, "/api/ai/vehicles");
check(r.status === 200 && r.body.vehicles.length === Object.keys(v).length, "AI vehicle list", r.body);
r = await bearer(kOffice, "/api/ai/attendance");
check(
  r.status === 200 && Array.isArray(r.body.attendance) && typeof r.body.untrusted === "string" && r.body.attendance.every((x) => !Object.keys(x).some((k) => /gps|lat|lng/i.test(k))),
  "AI attendance (no GPS)",
  r.body
);
r = await bearer(kDriver, "/api/ai/repairs", { vehicle: "70-1826", symptom: "แอร์ไม่เย็น", urgency: "normal" });
check(r.status === 200, "driver reports a repair via AI", r.body);
const aiRep = await db.repairRequest.findUnique({ where: { no: r.body.no ?? 0 } });
check(aiRep?.status === "quote" && aiRep.photos.length === 0, "the AI repair waits for a quote, without photos", aiRep);
check((await bearer(kDriver, "/api/ai/repairs", { vehicle: "70-1826", symptom: "แอร์", urgency: "soon" })).status === 400, "AI repair: bad urgency refused");
r = await form(c.purchasing, `/api/repairs/${aiRep.id}/quote`, { quoteAmount: "2500", quoteFiles: [PDF] });
check(r.status === 200, "purchasing quotes the AI repair", r.body);
r = await bearer(kExec, "/api/ai/pending");
check(r.body.repairsToApprove?.find((x) => x.no === aiRep.no)?.quoteAmount === 2500, "exec pending shows the quote amount", r.body);
r = await bearer(kExec, "/api/ai/repairs/decide", { no: aiRep.no, approve: true, quoteAmount: 2000 });
check(r.status === 400 && /2,500/.test(r.body.error || ""), "approve at another price is refused and told the current price", r.body);
check((await bearer(kExec, "/api/ai/repairs/decide", { no: aiRep.no, approve: false, quoteAmount: 2500 })).status === 400, "AI reject without a note refused");
r = await bearer(kExec, "/api/ai/repairs/decide", { no: aiRep.no, approve: true, quoteAmount: 2500 });
const ar = await db.repairRequest.findUnique({ where: { id: aiRep.id } });
check(r.status === 200 && ar.status === "approved" && ar.decidedBy === `${users.exec.name} (เลขา AI)`, "exec approves via AI", r.body);
check((await bearer(kExec, "/api/ai/repairs/decide", { no: aiRep.no, approve: true, quoteAmount: 2500 })).status === 400, "a decided repair cannot be decided again");
r = await bearer(kExec, `/api/ai/repairs?no=${aiRep.no}`);
check(r.body.repairs?.[0]?.status === "อนุมัติแล้ว รอค่าซ่อม", "AI repair list by no", r.body);
r = await json(c.driver, "/api/ai/key", { action: "revoke" });
check(r.status === 200 && (await bearer(kDriver, "/api/ai/me")).status === 401, "a revoked key stops working");
const kOffice2 = (await json(c.office, "/api/ai/key", { action: "create" })).body.key;
check((await bearer(kOffice, "/api/ai/me")).status === 401 && (await bearer(kOffice2, "/api/ai/me")).status === 200, "a new key replaces the old one");
check((await page(c.office, "/ai")).status === 200 && (await page(c.driver, "/ai")).status === 200, "GET /ai");

console.log("LINE: paths the flow above does not reach");
// a request waiting 40 min + a vehicle past its service: one tick reminds the filler and alerts the service, the next stays quiet
r = await form(c.driver2, "/api/fuel", { vehicleId: v["70-1826"].id, engineHours: "310", photo: JPG });
const late = await db.fuelRequest.findFirst({ where: { driverId: users.driver2.id }, orderBy: { createdAt: "desc" } });
await db.fuelRequest.update({ where: { id: late.id }, data: { createdAt: new Date(Date.now() - 40 * 60_000) } });
// the seed's cycle (0 + 300) was told "เลยรอบ" by the first tick; a new cycle (100 + 230, 300 h now) is "ใกล้รอบ"
await db.vehicle.update({ where: { id: v["70-1826"].id }, data: { pmLastHours: 100, pmEveryHours: 230 } });
r = await bearer(CRON, "/api/cron/tick");
check(r.body.fuelReminded?.includes(late.no) && r.body.serviceDue?.includes("70-1826"), "tick: fuel reminder + service due", r.body);
r = await bearer(CRON, "/api/cron/tick");
check(!r.body.fuelReminded?.length && !r.body.serviceDue?.includes("70-1826"), "the next tick does not repeat them", r.body);
r = await json(c.office, `/api/fuel/${late.id}/review`, { action: "cancel", note: "รถเข้าอู่" });
check(r.status === 200, "office cancels a waiting request", r.body);
for (const kind of ["fuel", "repair"]) {
  const o = await db.expressOrder.create({ data: { kind, status: "queued", payload: {}, createdBy: "e2e" } });
  r = await bearer(EXPRESS, `/api/express/${kind}`, { results: [{ id: o.id, status: "error", error: `ทดสอบ ${kind}` }] });
  check(r.body.applied === 1 && (await db.expressOrder.findUnique({ where: { id: o.id } })).status === "error", `agent reports a ${kind} write error`, r.body);
  await db.expressOrder.delete({ where: { id: o.id } });
}
// busy (a row the write needs is open in Express): stays queued for the next run, nobody is told
const busy = await db.expressOrder.create({ data: { kind: "fuel", status: "queued", payload: {}, createdBy: "e2e" } });
r = await bearer(EXPRESS, "/api/express/fuel", { results: [{ id: busy.id, status: "busy", error: "รอ: มีคนเปิดรายการใน Express" }] });
check(r.body.applied === 1 && (await db.expressOrder.findUnique({ where: { id: busy.id } })).status === "queued", "a busy write stays queued", r.body);
await db.expressOrder.delete({ where: { id: busy.id } });
const hook = JSON.stringify({ events: [{ type: "message", replyToken: "rt-e2e", message: { type: "text", text: "ID" }, source: { type: "group", userId: "U-e2e", groupId: "G-e2e" } }] });
const sig = createHmac("sha256", "dev-line-secret").update(hook).digest("base64");
check((await fetch(`${BASE}/api/line/webhook`, { method: "POST", headers: { "x-line-signature": sig }, body: hook })).status === 200, "webhook answers a signed 'id'");
check((await fetch(`${BASE}/api/line/webhook`, { method: "POST", headers: { "x-line-signature": "bad" }, body: hook })).status === 401, "webhook refuses a bad signature");
console.log("driver forms: typed driver name, a vehicle not in the list");
// a plate typed like a listed one (case, spaces, dashes) is that vehicle
r = await form(c.driver, "/api/fuel", { vehicleId: "new", newCode: " sy 14001 ", newModel: "x", driverName: "สมพร แทนคนขับ", engineHours: "1120", photo: JPG });
let tf = await db.fuelRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" }, include: { vehicle: true } });
check(r.status === 200 && tf.vehicle.code === "SY140-01" && tf.driverName === "สมพร แทนคนขับ", "a typed plate like a listed one uses it; the typed driver name is kept", { body: r.body, code: tf?.vehicle.code, driverName: tf?.driverName });
check((await db.vehicle.count()) === Object.keys(v).length, "no vehicle is added for it");
check((await page(c.filler, "/filler")).text.replace(/<!-- -->/g, "").includes("สมพร แทนคนขับ (ส่งโดย สมชาย คนขับ)"), "the filler sees the typed name and the account that sent it");
r = await form(c.driver2, "/api/fuel", { vehicleId: "new", newCode: "80-1234", newModel: "ISUZU FRR", driverName: users.driver2.name, engineHours: "50", photo: JPG, remember: "on" });
const nv = await db.vehicle.findUnique({ where: { code: "80-1234" } });
tf = await db.fuelRequest.findFirst({ where: { driverId: users.driver2.id }, orderBy: { createdAt: "desc" } });
check(r.status === 200 && nv?.model === "ISUZU FRR" && /คนขับเพิ่มเอง/.test(nv.note) && tf.vehicleId === nv.id && tf.driverName === "", "a new plate becomes a vehicle; the sender's own name is not stored twice", { body: r.body, nv, driverName: tf?.driverName });
check((await db.user.findUnique({ where: { id: users.driver2.id } })).rememberVehicleId === nv?.id, "the new vehicle is remembered");
check((await page(c.driver2, "/driver/fuel")).text.includes("80-1234 - ISUZU FRR"), "the new vehicle is in the list next time");
// a service interval without the hours of the last service: unknown (never 0 h), so no service-due alert
await db.vehicle.update({ where: { id: nv.id }, data: { pmEveryHours: 10 } });
r = await bearer(CRON, "/api/cron/tick");
check(r.status === 200 && !r.body.serviceDue?.includes("80-1234"), "no service-due alert without the last service's hours", r.body);
await db.vehicle.update({ where: { id: nv.id }, data: { pmEveryHours: null } });
r = await form(c.driver, "/api/repairs", { vehicleId: "new", newCode: "80 1234", newModel: "ISUZU", driverName: "สมพร แทนคนขับ", symptom: "ไฟเบรกไม่ติด", urgency: "normal", photos: [JPG] });
const tr = await db.repairRequest.findFirst({ where: { driverId: users.driver.id }, orderBy: { createdAt: "desc" } });
check(r.status === 200 && tr.vehicleId === nv?.id && tr.driverName === "สมพร แทนคนขับ", "repair: a typed plate finds the vehicle a driver added", r.body);
check((await page(c.purchasing, `/purchasing/repairs/${tr.id}`)).text.replace(/<!-- -->/g, "").includes("สมพร แทนคนขับ (ส่งโดย สมชาย คนขับ)"), "purchasing sees who drove and who sent it");
r = await form(c.driver, "/api/repairs", { vehicleId: "new", newCode: "90-5555", newModel: "", symptom: "ทดสอบ", urgency: "normal", photos: [JPG] });
check(r.status === 400 && /รุ่น/.test(r.body.error || "") && !(await db.vehicle.findUnique({ where: { code: "90-5555" } })), "a typed plate needs the model", r.body);
await db.vehicle.update({ where: { id: nv.id }, data: { active: false } });
r = await form(c.driver, "/api/fuel", { vehicleId: "new", newCode: "801234", newModel: "ISUZU", engineHours: "60", photo: JPG });
check(r.status === 400 && /ปิดใช้งาน/.test(r.body.error || ""), "a plate Office turned off is refused", r.body);
await db.vehicle.update({ where: { id: nv.id }, data: { active: true } });
for (const p of ["/driver/fuel", "/driver/repair"]) check((await page(c.driver, p)).text.includes("ไม่มีในรายการ"), `${p} offers a plate not in the list`);

console.log("slip: sent on its own (no AI key here), 3-decimal litres, checks against an AI reading");
r = await form(c.driver2, "/api/fuel", { vehicleId: v["SY55-02"].id, engineHours: "510", photo: JPG });
const sr = await db.fuelRequest.findFirst({ where: { driverId: users.driver2.id }, orderBy: { createdAt: "desc" } });
check((await page(c.filler, `/filler/${sr.id}`)).text.includes("รูปสลิป"), "the filler form shows the slip photo field");
check((await page(c.driver2, "/driver/fuel")).text.includes(`/api/fuel/${sr.id}/cancel`), "the driver may cancel a request no filler has taken");
check((await form(c.driver, `/api/fuel/${sr.id}/slip`, { slip: JPG })).status === 403, "only a filler sends a slip");
r = await form(c.filler, `/api/fuel/${sr.id}/slip`, { slip: JPG });
let srow = await db.fuelRequest.findUnique({ where: { id: sr.id } });
check(r.status === 200 && r.body.read === null && !!srow.slipPhoto && srow.slipRead === null, "the slip is kept at once; without a key nothing is read", r.body);
// a slip sent = a filler is filling it (likely paid): only Office cancels it now
r = await json(c.driver2, `/api/fuel/${sr.id}/cancel`, {});
check(r.status === 400 && /แนบสลิปแล้ว/.test(r.body.error || ""), "the driver cannot cancel once a filler sent the slip", r.body);
check(!(await page(c.driver2, "/driver/fuel")).text.includes(`/api/fuel/${sr.id}/cancel`), "the driver's page no longer offers to cancel it");
// what the AI would read from a replacement slip (made-up values; tax ID fails the Thai checksum; Gemini is not
// called here): it cancels the invoice of the first fill, which is approved
await db.fuelRequest.update({
  where: { id: sr.id },
  data: { slipRead: { invoice: "ต99990000000002", replaces: "ต2611090001", date: today(), plate: "00-0000 ทดสอบ", liters: 72.674, pricePerLiter: 41.28, amount: 3000, station: "บางจาก", buyerTaxId: "0999999999995" } },
});
r = await form(c.filler, `/api/fuel/${sr.id}/fill`, { fillDash: JPG, engineHours: "510", liters: "72.674", pricePerLiter: "41.28", amount: "3100", source: "pump", supplierName: "บางจาก", invoice: "99990000000002", invoiceDate: today(), slipKey: srow.slipPhoto });
srow = await db.fuelRequest.findUnique({ where: { id: sr.id } });
check(r.status === 200 && Number(srow.liters) === 72.67, "a fill after the slip was sent needs no slip; 72.674 L is kept as 72.67", { body: r.body, liters: srow?.liters });
const sc = (srow.flags ?? []).map((f) => f.code);
check(
  sc.includes("slip_amount") && sc.includes("slip_plate") && sc.includes("slip_replaces") && !sc.includes("slip_liters") && !sc.includes("slip_invoice") && !sc.includes("slip_date"),
  "typed vs read: the amount and plate differ, the replacement slip is noted",
  sc
);
check(sc.includes("replace_pair"), "the replacement slip of an approved fill's invoice is flagged as the same purchase", sc);
check((await form(c.filler, `/api/fuel/${sr.id}/slip`, { slip: JPG })).status === 400, "a filled request takes no new slip");
// one purchase on two requests is booked once: the replacement waits while the fill it cancels stays booked
r = await json(c.office, `/api/fuel/${sr.id}/review`, { action: "approve", ...(await shown(sr.id)) });
check(
  r.status === 400 &&
    new RegExp(`ออกแทนใบเลขที่ ต2611090001 ของคำขอ #${first.no} ที่อนุมัติแล้ว`).test(r.body.error || "") &&
    (await db.fuelRequest.findUnique({ where: { id: sr.id } })).status === "filled" &&
    !(await db.expressOrder.count({ where: { fuelRequestId: sr.id } })),
  "a replacement slip is held from approval while the fill it cancels is booked",
  r.body
);

r = await form(c.office, `/api/users/${users.new.id}`, { roles: ["driver", "filler"], status: "active", ...shownNew, was: "active", wasRoles: "driver" });
check(r.status === 200, "office changes an active user's roles", r.body);
// disabling ends every session and the AI key; re-enabling brings neither back
const kNew = (await json(c.new, "/api/ai/key", { action: "create" })).body.key;
r = await form(c.office, `/api/users/${users.new.id}`, { roles: ["driver", "filler"], status: "disabled", ...shownNew, was: "active", wasRoles: "driver,filler" });
check(
  r.status === 200 && !!kNew && (await db.user.findUnique({ where: { id: users.new.id } })).aiKeyHash === null && (await bearer(kNew, "/api/ai/me")).status === 401,
  "office disables a user: the AI key stops",
  r.body
);
check((await json(c.new, "/api/ai/key", { action: "create" })).status === 401, "a disabled user's session is refused");
r = await form(c.office, `/api/users/${users.new.id}`, { roles: ["driver", "filler"], status: "active", ...shownNew, was: "disabled", wasRoles: "driver,filler" });
check(r.status === 200 && (await json(c.new, "/api/ai/key", { action: "create" })).status === 401, "re-enabled: a session from before stays signed out", r.body);

console.log("เทียบราคา: purchase prices from Express -> purchasing compares suppliers");
check((await page(c.purchasing, "/purchasing/prices?q=11r")).text.includes("ยังไม่มีข้อมูลราคา"), "before the office PC sends prices the page says so");
check((await page(c.driver, "/purchasing/prices")).location.includes("denied"), "a driver cannot open เทียบราคา");
const tyre = { item: "TY-11R", desc: "ยาง 11R22.5 BRIDGESTONE", qty: 2, unit: "เส้น", vat: "1" };
const prices = {
  since: "2024-11-24",
  lines: [
    { ...tyre, date: "2026-11-01", doc: "RR691101-01", sup: "ย001", price: 8560, net: 16000 },
    { ...tyre, date: "2026-10-01", doc: "RR691001-01", sup: "ย001", price: 8025, net: 15000 },
    { ...tyre, date: "2026-11-02", doc: "RR691102-01", sup: "ย002", price: 7900, net: 15800, vat: "2" },
    { date: "2026-11-03", doc: "RR691103-01", sup: "อ001", item: "5360-02", desc: "เปลี่ยนยางใหม่ 2 เส้น 81-2147", qty: 1, unit: "งาน", price: 9630, net: 9000, vat: "1" },
    // from an older agent: payroll must never be kept
    { date: "2026-10-31", doc: "SA691031-01", sup: "พ999", item: "5301-01", desc: "เงินเดือนพนักงาน", qty: 1, unit: "ครั้ง", price: 558033.33, net: 558033.33, vat: "0" },
    // a private person: kept by name only, without service wages (5110-05)
    { date: "2026-11-11", doc: "RR691111-01", sup: "ช001", item: "5110-05", desc: "ค่าแรง 3 วัน", qty: 1, unit: "งาน", price: 1500, net: 1500, vat: "0" },
    { date: "2026-11-12", doc: "RR691112-01", sup: "ช001", item: "5360-03", desc: "ค่าซ่อมไดชาร์จ", qty: 1, unit: "งาน", price: 1500, net: 1500, vat: "0" },
    // an employee (a loan line marks them as staff): nothing of them is kept, not even a purchase
    { date: "2026-10-01", doc: "PE691001-01", sup: "น001", item: "1150-03", desc: "เงินยืม", qty: 1, unit: "ครั้ง", price: 5000, net: 5000, vat: "0" },
    { date: "2026-11-10", doc: "PE691110-01", sup: "น001", item: "5360-03", desc: "ยางใน", qty: 2, unit: "เส้น", price: 175, net: 350, vat: "0" },
  ],
  suppliers: [
    { code: "ย001", name: "หจก. ยางดี", address: "1 ถ.เทพกระษัตรี ภูเก็ต", zip: "83000", phone: "076-111111", taxId: "0833500000001", branch: "", remark: "", vat: "2" },
    { code: "ย002", name: "ร้านยางถูก", address: "", zip: "", phone: "081-2222222", taxId: "", branch: "", remark: "ส่งของช้า", vat: "0" },
    { code: "อ001", name: "อู่ช่างเอก", address: "", zip: "", phone: "", taxId: "", branch: "", remark: "", vat: "1" },
    { code: "พ999", name: "เงินเดือนพนักงาน", address: "", zip: "", phone: "", taxId: "", branch: "", remark: "", vat: "0" },
    // made-up personal IDs (they fail the Thai ID checksum)
    { code: "ช001", name: "นาย ช่างทดสอบ", address: "9 หมู่ 1", zip: "83000", phone: "089-0000002", taxId: "3830100000002", branch: "", remark: "บัญชีส่วนตัว", vat: "0" },
    { code: "น001", name: "พนักงานทดสอบ", address: "", zip: "", phone: "089-0000001", taxId: "3830100000001", branch: "", remark: "", vat: "0" },
  ],
  items: { "TY-11R": "ยางรถบรรทุก 11R22.5", "5360-02": "ค่าซ่อมแซม-เครื่องจักร", "5301-01": "เงินเดือน", "5110-05": "ค่าแรงงานซ่อม", "5360-03": "ค่าซ่อมแซม-ไฟฟ้า", "1150-03": "เงินยืมพนักงาน" },
};
check((await bearer("wrong", "/api/express/prices", prices)).status === 401, "prices need the sync secret");
check((await bearer(EXPRESS, "/api/express/prices", { lines: "x" })).status === 400, "prices in another shape are refused");
r = await bearer(EXPRESS, "/api/express/prices", prices);
check(r.status === 200 && r.body.saved === 5, "office PC sends the purchase prices; payroll, staff and a private person's wages are not kept", r.body);
const stored = (await db.appSetting.findUnique({ where: { key: "express_prices" } })).value;
check(!stored.lines.some((x) => x.item === "5301-01") && !stored.suppliers.some((s) => s.code === "พ999") && !("5301-01" in stored.items), "nothing of the payroll line is stored", stored.suppliers.map((s) => s.code));
check(!stored.lines.some((x) => x.sup === "น001") && !stored.suppliers.some((s) => s.code === "น001"), "nothing of an employee is stored", stored.suppliers.map((s) => s.code));
const person = stored.suppliers.find((s) => s.code === "ช001");
check(
  person?.name === "นาย ช่างทดสอบ" && [person.address, person.zip, person.phone, person.taxId, person.remark].every((x) => x === "") && !stored.lines.some((x) => x.sup === "ช001" && x.item === "5110-05"),
  "a private person is stored by name only, without service wages",
  person
);
if (process.env.EXPRESS_COMPANY) {
  r = await bearer(EXPRESS, "/api/express/prices", { ...prices, lines: [] }, "POST", { "x-express-company": "OTHER-E2E" });
  check(r.status === 409 && JSON.stringify((await db.appSetting.findUnique({ where: { key: "express_prices" } })).value) === JSON.stringify(stored), "another Express company's office PC cannot replace the prices", r.body);
}
check((await page(c.purchasing, `/purchasing/prices?q=${encodeURIComponent("เงินเดือน")}`)).text.includes("ไม่พบการซื้อ"), "payroll cannot be searched");
let pg = await page(c.purchasing, "/purchasing/prices?q=11r22.5");
check(pg.status === 200 && pg.text.includes("ร้านยางถูก") && pg.text.includes("หจก. ยางดี") && pg.text.includes("ถูกสุด"), "search lists the suppliers with the cheapest marked");
check(pg.text.includes("7,900.00") && pg.text.includes("7,500.00") && pg.text.includes("081-2222222") && pg.text.includes("ส่งของช้า"), "per-unit prices before VAT and the supplier details show");
check(pg.text.includes("ยาง 11R22.5 BRIDGESTONE"), "the table names the product as written on the bill line");
pg = await page(c.purchasing, `/purchasing/prices?q=${encodeURIComponent("ยาง")}`);
check(pg.text.includes("สินค้าที่พบ 2 รายการ") && pg.text.includes("เปลี่ยนยางใหม่ 2 เส้น 81-2147") && !pg.text.includes(">5360-02 "), "a wider search offers each product by its bill-line name, not the account code", pg.text.match(/สินค้าที่พบ[^<]*/)?.[0]);
pg = await page(c.purchasing, `/purchasing/prices?q=${encodeURIComponent("ยาง")}&p=${encodeURIComponent("เปลี่ยนยางใหม่2เส้น81-2147")}`);
check(pg.text.includes("อู่ช่างเอก") && !pg.text.includes("ร้านยางถูก"), "picking a product compares that product alone");
check((await page(c.purchasing, "/purchasing/prices?q=zzzz")).text.includes("ไม่พบการซื้อ"), "a search with no purchase says so");
check((await page(c.purchasing, `/purchasing/prices?q=${encodeURIComponent("ค่าแรง")}`)).text.includes("ไม่พบการซื้อ"), "a private person's wages cannot be searched");
pg = await page(c.purchasing, `/purchasing/prices?q=${encodeURIComponent("ไดชาร์จ")}`);
check(pg.text.includes("นาย ช่างทดสอบ") && !pg.text.includes("089-0000002") && pg.text.includes("ผู้ขายที่เป็นบุคคลธรรมดาแสดงเฉพาะชื่อ"), "a private person's purchase shows the name only");
check((await page(c.accounting, "/purchasing/prices?q=11r")).status === 200 && (await page(c.office, "/purchasing/prices")).status === 200, "office and accounting open เทียบราคา too");

console.log("LINE messages (dry-run lines in var/e2e/dev.log, from dev-tee.mjs)");
await new Promise((s) => setTimeout(s, 1500)); // the webhook reply goes out after its response
const sent = readFileSync(new URL("./dev.log", import.meta.url), "utf8")
  .split(/\r?\n/)
  .flatMap((l) => {
    const m = l.match(/\[line:dry-run\] (\S+) (.*)$/);
    if (!m) return [];
    const to = m[2].match(/"(?:to|replyToken)":(\[[^\]]*\]|"[^"]*")/);
    let text = m[2].match(/"text":"((?:[^"\\]|\\.)*)/)?.[1] ?? "";
    try {
      text = JSON.parse(`"${text}"`);
    } catch {
      text = text.replace(/\\n/g, "\n"); // cut at 800 chars by the dry-run log
    }
    return [{ path: m[1], to: to ? [JSON.parse(to[1])].flat().sort() : [], text, used: false }];
  });
check(sent.length > 0, `dev.log holds ${sent.length} LINE messages`);
const OFFICE = ["dev-office"], FILLER = ["dev-filler"], EXEC = ["dev-exec"], PUR = ["dev-purchasing"], ACC = ["dev-accounting"], DRIVER = ["dev-driver"];
const drivers = (to) => to.length > 0 && to.every((x) => /^dev-(driver2?|new)$/.test(x));
const line = (label, re, to, count) => {
  const hits = sent.filter((m) => re.test(m.text || m.path));
  hits.forEach((m) => (m.used = true));
  const okTo = hits.every((m) => (typeof to === "function" ? to(m.to) : m.to.join(",") === [...to].sort().join(",")));
  const seen = [...new Set(hits.map((m) => m.to.join("+")))].join(" | ");
  check(hits.length > 0 && (count === undefined || hits.length === count) && okTo, `LINE ${label}: ${hits.length}x -> ${seen}`, hits.map((m) => m.text.slice(0, 150)));
};
const L = "\\nhttp://\\S+";
line("ลงทะเบียนใหม่ -> Office", new RegExp(`^มีผู้ลงทะเบียนใหม่: ผู้สมัคร ใหม่ ขอบทบาท คนขับ${L}/office/users$`), OFFICE, 1);
line("อนุมัติบัญชี -> ผู้สมัคร", new RegExp(`^บัญชีของคุณได้รับการอนุมัติแล้ว บทบาท: คนขับ${L}/$`), ["dev-new"], 1);
line("เปิดใช้งานอีกครั้ง -> ผู้ใช้", new RegExp(`^บัญชีของคุณได้รับการอนุมัติแล้ว บทบาท: คนขับ, คนเติม${L}/$`), ["dev-new"], 1);
line("Rich Menu ตามบทบาท (อนุมัติ + เปลี่ยนบทบาท + เปิดใช้งานอีกครั้ง)", /^\/v2\/bot\/user\/dev-new\/richmenu\/richmenu-dev-driver$/, [], 3);
line("อนุมัติผู้ใช้ -> Office", new RegExp(`^อนุมัติผู้ใช้ ผู้สมัคร ใหม่ บทบาท คนขับ โดย สมศรี Office${L}/office/users$`), OFFICE, 1);
line("เปลี่ยนบทบาท -> Office", new RegExp(`^เปลี่ยนบทบาท ผู้สมัคร ใหม่: คนขับ -> คนขับ, คนเติม โดย สมศรี Office${L}/office/users$`), OFFICE, 1);
line("ปิดการใช้งาน -> Office", new RegExp(`^ปิดการใช้งาน ผู้สมัคร ใหม่ โดย สมศรี Office${L}/office/users$`), OFFICE, 1);
line("เปิดใช้งานอีกครั้ง -> Office", new RegExp(`^เปิดใช้งานอีกครั้ง ผู้สมัคร ใหม่ บทบาท คนขับ, คนเติม โดย สมศรี Office${L}/office/users$`), OFFICE, 1);
line("ขอเติมน้ำมัน -> คนเติม", new RegExp(`^ขอเติมน้ำมัน #\\d+ รถ \\S+ ชม\\.เครื่อง [\\d,]+(?: ไมค์ [\\d,.]+)? โดย [^\\n]+${L}/filler/\\w+$`), FILLER, 10);
line("ขอเติมพร้อมเลขไมค์ -> คนเติม", /^ขอเติมน้ำมัน #\d+ รถ SY140-01 ชม\.เครื่อง 1,100 ไมค์ 5,000 โดย /, FILLER, 1);
line("ขอเติมผ่านเลขา AI ไม่มีรูป -> คนเติม", /^ขอเติมน้ำมัน #\d+ รถ SY140-01 ชม\.เครื่อง 1,110 โดย สมชาย คนขับ \(เลขา AI\) ไม่มีรูปหน้าปัด\n/, FILLER, 1);
line("ชื่อผู้ขับที่พิมพ์ -> คนเติม", /^ขอเติมน้ำมัน #\d+ รถ SY140-01 ชม\.เครื่อง 1,120 โดย สมพร แทนคนขับ \(ส่งโดย สมชาย คนขับ\)\n/, FILLER, 1);
line("คนขับเพิ่มรถใหม่ -> Office", new RegExp(`^คนขับเพิ่มรถใหม่: 80-1234 \\(ISUZU FRR\\) โดย สมปอง คนขับ\\nกรอก ลิตร/ชม\\., ความจุถัง, รอบเช็คระยะ และรหัส Express${L}/office/vehicles/\\w+$`), OFFICE, 1);
line("คนขับยกเลิกคำขอ -> คนเติม", /^คนขับยกเลิกคำขอเติมน้ำมัน #\d+ รถ SY140-01 ไม่ต้องเติม$/, FILLER, 1);
line("ค้างเติมเกิน 30 นาที -> คนเติม", new RegExp(`^ค้างเติมน้ำมัน: #${late.no} รถ 70-1826 \\(รอ 4\\d นาที\\)${L}/filler$`), FILLER, 1);
line("ผิดปกติตอนเติม -> Office", new RegExp(`^แจ้งเตือนผิดปกติ เติมน้ำมัน #\\d+ รถ \\S+\\n- [^]+${L}/office/fuel/\\w+$`), OFFICE);
line("Office ส่งกลับ -> คนเติมคนนั้น", new RegExp(`^ส่งกลับให้แก้ไข เติมน้ำมัน #\\d+: ยอดไม่ชัด${L}/filler/\\w+$`), FILLER, 1);
line("Office ยกเลิกคำขอ -> คนขับคนนั้น", new RegExp(`^ยกเลิกคำขอเติมน้ำมัน #${late.no}: รถเข้าอู่$`), ["dev-driver2"], 1);
line("Office ยกเลิกคำขอที่รอเติม -> คนเติม", new RegExp(`^ยกเลิกคำขอเติมน้ำมัน #${late.no} รถ 70-1826 ไม่ต้องเติม: รถเข้าอู่$`), FILLER, 1);
line("แจ้งซ่อม -> จัดซื้อ", new RegExp(`^แจ้งซ่อม #\\d+ รถ \\S+ \\((ด่วน \\(รถหยุดงาน\\)|ปกติ|รอได้)\\)( \\(แจ้งผ่านเลขา AI ไม่มีรูป\\))?\\nอาการ: [^\\n]+${L}/purchasing/repairs/\\w+$`), PUR, 6);
line("แจ้งซ่อมผ่านเลขา AI -> จัดซื้อ", /^แจ้งซ่อม #\d+ รถ 70-1826 \(ปกติ\) \(แจ้งผ่านเลขา AI ไม่มีรูป\)\nอาการ: แอร์ไม่เย็น\n/, PUR, 1);
line("ด่วน รถหยุดงาน -> ผู้บริหาร", new RegExp(`^ด่วน รถหยุดงาน: แจ้งซ่อม #\\d+ รถ SY55-02\\nอาการ: ไฮดรอลิครั่ว${L}/exec/repairs/\\w+$`), EXEC, 1);
line("ขออนุมัติซ่อม -> ผู้บริหาร", new RegExp(`^ขออนุมัติซ่อม #\\d+ รถ \\S+\\nอาการ: [^\\n]+\\nใบเสนอราคา [\\d,]+\\.\\d\\d บาท${L}/exec/repairs/\\w+$`), EXEC, 4);
line("ขออนุมัติใหม่ ราคาเปลี่ยน -> ผู้บริหาร", new RegExp(`^ขออนุมัติใหม่ \\(ราคาเปลี่ยน\\) #\\d+ รถ \\S+\\nอาการ: [^\\n]+\\nใบเสนอราคา [\\d,.]+ บาท \\(เดิม [\\d,.]+ บาท\\)${L}/exec/repairs/\\w+$`), EXEC, 2);
line("ใบเสนอราคา 11,000 เดิม 10,700", /ใบเสนอราคา 11,000\.00 บาท \(เดิม 10,700\.00 บาท\)/, EXEC, 1);
line("อนุมัติซ่อม -> จัดซื้อ", new RegExp(`^อนุมัติซ่อม #\\d+ แล้ว ลงรายละเอียดค่าซ่อม${L}/purchasing/repairs/\\w+$`), PUR, 4);
line("ไม่อนุมัติ -> คนขับ", new RegExp(`^ไม่อนุมัติซ่อม #\\d+ รถ 70-1826: ใช้ยางเก่าได้${L}/driver/my$`), DRIVER, 1);
line("ไม่อนุมัติ -> จัดซื้อ", new RegExp(`^ไม่อนุมัติซ่อม #\\d+ รถ 70-1826: ใช้ยางเก่าได้${L}/purchasing/repairs/\\w+$`), PUR, 1);
line("เริ่มซ่อม -> คนขับ", new RegExp(`^เริ่มซ่อม #\\d+ รถ \\S+${L}/driver/my$`), DRIVER, 2);
line("เริ่มซ่อม + ค่าซ่อม -> ผู้บริหาร", new RegExp(`^เริ่มซ่อม #\\d+ รถ \\S+ ค่าซ่อม [\\d,.]+ บาท\\nExpress: [^\\n]+${L}/exec/repairs/\\w+$`), EXEC, 2);
line("เริ่มซ่อม + ค่าซ่อม -> บัญชี", new RegExp(`^เริ่มซ่อม #\\d+ รถ \\S+ ค่าซ่อม [\\d,.]+ บาท\\nExpress: [^\\n]+${L}/purchasing/repairs/\\w+$`), ACC, 2);
line("ค่าซ่อม 10,700 ส่งเข้า Express", /^เริ่มซ่อม #\d+ รถ SY55-02 ค่าซ่อม 10,700\.00 บาท\nExpress: กำลังเปิด PO \/ RR\n/, (to) => ["dev-accounting", "dev-exec"].includes(to.join()), 2);
line("PO / RR ครบ -> ผู้บริหาร", new RegExp(`^เปิด PO / RR ค่าซ่อม #\\d+ รถ SY55-02 ใน Express แล้ว: PO0000101 · RR691109-02${L}/exec/repairs/\\w+$`), EXEC, 1);
line("PO / RR ครบ -> บัญชี", new RegExp(`^เปิด PO / RR ค่าซ่อม #\\d+ รถ SY55-02 ใน Express แล้ว: [^\\n]+${L}/purchasing/repairs/\\w+$`), ACC, 1);
line("PO / RR ของค่าซ่อมที่ส่งทีหลัง -> ผู้บริหาร", new RegExp(`^เปิด PO / RR ค่าซ่อม #\\d+ รถ SY140-01 ใน Express แล้ว: PO0000102 · RR691109-03${L}/exec/repairs/\\w+$`), EXEC, 1);
line("PO / RR ของค่าซ่อมที่ส่งทีหลัง -> บัญชี", new RegExp(`^เปิด PO / RR ค่าซ่อม #\\d+ รถ SY140-01 ใน Express แล้ว: PO0000102 · RR691109-03${L}/purchasing/repairs/\\w+$`), ACC, 1);
line("ซ่อมเสร็จ -> คนขับ", new RegExp(`^ซ่อมเสร็จแล้ว #\\d+ รถ \\S+ กรุณาตรวจรับรถ${L}/driver/my$`), DRIVER, 3);
line("คนขับไม่รับรถ -> จัดซื้อ", new RegExp(`^ซ่อมไม่เรียบร้อย #\\d+ รถ SY55-02: ยังรั่ว${L}/purchasing/repairs/\\w+$`), PUR, 1);
line("คนขับรับรถ -> จัดซื้อ", new RegExp(`^ปิดงานซ่อม #\\d+ รถ SY55-02 \\(คนขับตรวจรับแล้ว\\)${L}/purchasing/repairs/\\w+$`), PUR, 1);
line("Office ปิดงานแทน -> คนขับ", new RegExp(`^ปิดงานซ่อม #\\d+ โดย สมศรี Office: คนขับลาออก${L}/driver/my$`), DRIVER, 1);
line("ยกเลิกงานซ่อม -> คนขับ", new RegExp(`^ยกเลิกงานซ่อม #\\d+ รถ 70-1826: แจ้งซ้ำกับ #1${L}/driver/my$`), DRIVER, 1);
line("ใกล้ / เลยรอบเช็คระยะ -> คนขับ 3 คนล่าสุด", new RegExp(`^(เลยรอบ|ใกล้รอบ)เช็คระยะ รถ \\S+: ชม\\.เครื่อง [\\d,]+ / ครบรอบที่ [\\d,]+\\nเปิดแจ้งซ่อม: http://\\S+/driver/repair\\?vehicle=\\w+&pm=1$`), drivers);
line("ใกล้ / เลยรอบเช็คระยะ -> จัดซื้อ", new RegExp(`^(เลยรอบ|ใกล้รอบ)เช็คระยะ รถ \\S+: ชม\\.เครื่อง [\\d,]+ / ครบรอบที่ [\\d,]+\\nนัดเช็คระยะ: http://\\S+/office/vehicles/\\w+$`), PUR);
line("เลยรอบ 70-1826 ครั้งเดียวต่อรอบ -> คนขับรถคันนั้น", /^เลยรอบเช็คระยะ รถ 70-1826: ชม\.เครื่อง 300 \/ ครบรอบที่ 300\nเปิดแจ้งซ่อม/, ["dev-driver2"], 1);
line("ใกล้รอบ 70-1826 รอบใหม่ -> คนขับรถคันนั้น", /^ใกล้รอบเช็คระยะ รถ 70-1826: ชม\.เครื่อง 300 \/ ครบรอบที่ 330\nเปิดแจ้งซ่อม/, ["dev-driver2"], 1);
line("ยังไม่กดออกงาน -> คนนั้น", new RegExp(`^ยังไม่ได้กดออกงาน กรุณากดออกงาน${L}/driver/attendance$`), (to) => to.includes("dev-driver2") && drivers(to));
line("ยังไม่ออกงาน -> Office", new RegExp(`^ยังไม่ออกงาน: สมปอง คนขับ เข้างาน [^]+${L}/office/attendance$`), OFFICE);
line("เปิด R3 ไม่สำเร็จ -> Office", new RegExp(`^เปิด R3 ของ PK0000101 ใน Express ไม่สำเร็จ: อาจซ้ำ: R3691109-01 \\.\\.\\.${L}/office/express$`), OFFICE, 1);
line("บิลซ้ำกับรายการที่ยกเลิก -> Office", new RegExp(`^เอกสาร PK0000101 H3691109-01 ใน Express ยังเป็นของรายการที่ยกเลิกแล้ว: .+${L}/office/express$`), OFFICE, 1);
line("บิลซ้ำใน Express -> Office", new RegExp(`^เอกสาร PK0000101 H3691109-01 ใน Express เป็นของอีกรายการแล้ว \\(ใบกำกับซ้ำ\\?\\) ตรวจแล้วคีย์ใน Express เอง${L}/office/express$`), OFFICE, 1);
line("เปิด PK / H3 ไม่สำเร็จ -> Office", new RegExp(`^เปิด PK / H3 ใน Express ไม่สำเร็จ: ทดสอบ fuel${L}/office/express$`), OFFICE, 1);
line("เปิด PO / RR ไม่สำเร็จ -> Office", new RegExp(`^เปิด PO / RR ใน Express ไม่สำเร็จ: ทดสอบ repair${L}/office/express$`), OFFICE, 1);
line("เครื่อง Office เงียบเกิน 1 ชม. -> Office (ครั้งเดียว)", new RegExp(`^เครื่อง Office \\(Express\\) ไม่ได้ติดต่อมาตั้งแต่ [^\\n]+ มี 1 รายการรอลง Express: ตรวจว่าเครื่องเปิดอยู่และต่อเน็ต${L}/office/express$`), OFFICE, 1);
line("ค้างในคิว Express เกิน 1 ชม. ทั้งที่เครื่องติดต่ออยู่ -> Office (ครั้งเดียว)", new RegExp(`^มี 1 รายการรอลง Express เกิน 1 ชม\\. ทั้งที่เครื่อง Office ยังติดต่ออยู่: [^\\n]+${L}/office/express$`), OFFICE, 1);
line("ปิดการเขียน PK / H3 ที่เครื่อง Office -> Office", new RegExp(`^ปิดการเปิด PK / H3 อัตโนมัติที่เครื่อง Office: 1 รายการที่รอเขียนย้ายไปที่ "ไม่สำเร็จ" [^\\n]+${L}/office/express\\?f=problem$`), OFFICE, 1);
line("บิลเดือนภาษีปิดแล้ว ไม่ส่งให้เครื่อง Office -> Office", new RegExp(`^ไม่ได้ส่ง PK / H3 1 รายการให้เครื่อง Office เพราะเดือนภาษีปิดแล้ว: บิล LATE-E2E \\([^)\\n]+\\)${L}/office/express\\?f=problem$`), OFFICE, 1);
line("แจ้งเตือนระบบจากสคริปต์ -> Office", /^แจ้งเตือนระบบ: ทดสอบ e2e$/, OFFICE, 1);
line("สรุปประจำวัน -> Office", /^สรุปประจำวัน /, OFFICE, 1);
line("สรุปประจำสัปดาห์ -> Office", /^สรุปประจำสัปดาห์ /, OFFICE, 1);
line("webhook 'id' -> ตอบกลับในกลุ่ม", /^LINE user id: U-e2e\ngroup id: G-e2e$/, ["rt-e2e"], 1);
const other = sent.filter((m) => !m.used);
check(!other.length, `every LINE message is one the test expects (${other.length} other)`, other.map((m) => `${m.to} ${m.text || m.path}`.slice(0, 150)));
await db.$disconnect();
console.log("BASE", BASE);
done();
