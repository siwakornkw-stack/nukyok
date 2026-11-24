import { prisma } from "@/lib/db";
import { dec, num } from "@/lib/format";
import { agentSilent, getMasters } from "@/lib/express";
import { bad, bearerOk, jsonBody, ok, str } from "@/lib/http";
import { appLink, notifyOfficeGroup, notifyRoles, notifyUsers, quotaUsage } from "@/lib/line";
import { dailySummary, latestHours, PM_STATE, pmState, weeklySummary } from "@/lib/summary";
import { bkkDateKey, bkkHour, bkkStart, dateOnly, thDateTime, thTime } from "@/lib/time";

// Scheduled jobs, called by deploy/cron.sh from the server's crontab with "Authorization: Bearer $CRON_SECRET":
//   tick    every 10 minutes: fuel reminders, forgotten clock-out, service due, office PC (Express) silent
//   daily   18:05 Bangkok: LINE summary to the Office group (+ this month's LINE quota)
//   weekly  Monday 08:00 Bangkok: LINE summary of the last 7 days
//   alert   POST { text }: the backup / deploy scripts tell the Office group something failed
// When a LINE send fails, the tick leaves its rows as not sent, so the next tick tries again. An alert that goes to
// two audiences (b, c) is retried only when neither send went out: a retry would repeat the one that worked every
// 10 minutes. A failed send still shows on the Office home page (line_last_error).
const PM_ALERT_KEY = "pm_alert"; // { [vehicleId]: "<pmLastHours>|<state>" the alert was sent for }
const AGENT_ALERT_KEY = "express_agent_alert"; // masters.at the "office PC silent" alert was sent for

async function tick() {
  const now = new Date();

  // a) Fuel requests still waiting: remind the fillers every FUEL_REMIND_MINUTES, at most 6 times. The
  // rows are claimed first (remindedAt = now) so overlapping runs do not remind twice.
  const remindMin = Number(process.env.FUEL_REMIND_MINUTES) || 30;
  const cutoff = new Date(now.getTime() - remindMin * 60_000);
  await prisma.fuelRequest.updateMany({
    where: { status: "waiting", createdAt: { lt: cutoff }, remindCount: { lt: 6 }, OR: [{ remindedAt: null }, { remindedAt: { lt: cutoff } }] },
    data: { remindedAt: now, remindCount: { increment: 1 } },
  });
  const fuel = await prisma.fuelRequest.findMany({
    where: { status: "waiting", remindedAt: now },
    orderBy: { createdAt: "asc" },
    include: { vehicle: { select: { code: true } } },
  });
  if (fuel.length) {
    const reminded = await notifyRoles(
      ["filler"],
      [
        ...fuel.map((f) => `ค้างเติมน้ำมัน: #${f.no} รถ ${f.vehicle.code} (รอ ${Math.round((now.getTime() - f.createdAt.getTime()) / 60_000)} นาที)`),
        appLink("/filler"),
      ].join("\n")
    );
    // give the claim back so the next tick tries again
    if (!reminded)
      await prisma.fuelRequest.updateMany({
        where: { id: { in: fuel.map((f) => f.id) }, remindedAt: now },
        data: { remindedAt: null, remindCount: { decrement: 1 } },
      });
  }

  // b) Still clocked in after ATTENDANCE_END_HOUR today (shifts that began before it; an evening
  // shift is caught by the 14 hours instead), or for more than 14 hours: once per row.
  const endHour = Number(process.env.ATTENDANCE_END_HOUR) || 18;
  const today = dateOnly(bkkDateKey(now));
  const endToday = new Date(bkkStart(bkkDateKey(now)).getTime() + endHour * 3_600_000);
  await prisma.attendance.updateMany({
    where: {
      outAt: null,
      forgotAlertAt: null,
      OR: [{ inAt: { lt: new Date(now.getTime() - 14 * 3_600_000) } }, ...(bkkHour(now) >= endHour ? [{ workDate: today, inAt: { lt: endToday } }] : [])],
    },
    data: { forgotAlertAt: now },
  });
  const open = await prisma.attendance.findMany({ where: { forgotAlertAt: now }, orderBy: { inAt: "asc" }, include: { user: { select: { name: true } } } });
  if (open.length) {
    const toUsers = await notifyUsers(
      open.map((a) => a.userId),
      "ยังไม่ได้กดออกงาน กรุณากดออกงาน\n" + appLink("/driver/attendance")
    );
    const toOffice = await notifyOfficeGroup(
      [
        ...open.map((a) => `ยังไม่ออกงาน: ${a.user.name} เข้างาน ${a.workDate.getTime() === today.getTime() ? thTime(a.inAt) : thDateTime(a.inAt)}`),
        appLink("/office/attendance"),
      ].join("\n")
    );
    // give the claim back only when neither went out, or the next tick would message the side that got it again
    if (!toUsers && !toOffice)
      await prisma.attendance.updateMany({ where: { id: { in: open.map((a) => a.id) }, forgotAlertAt: now }, data: { forgotAlertAt: null } });
  }

  // c) Service due (เช็คระยะ): alert once per (vehicle, pmLastHours, state) to its last 3 drivers + purchasing,
  // so "ใกล้รอบ" and later "เลยรอบ" each go out once. Remembered once either send went out (a retry would repeat
  // the one that worked); when neither did, the next tick tries again.
  const [vehicles, hours, setting] = await Promise.all([
    prisma.vehicle.findMany({ where: { active: true, pmEveryHours: { gt: 0 } } }),
    latestHours(),
    prisma.appSetting.findUnique({ where: { key: PM_ALERT_KEY } }),
  ]);
  const sent: Record<string, string | number> =
    setting?.value && typeof setting.value === "object" && !Array.isArray(setting.value) ? { ...(setting.value as Record<string, string | number>) } : {};
  const due = vehicles.flatMap((v) => {
    const h = hours.get(v.id);
    const pm = pmState(v, h);
    if (!pm || h === undefined || pm.state === "ok") return [];
    const mark = `${dec(v.pmLastHours) ?? 0}|${pm.state}`;
    // a plain number was written before the state was kept: it stands for the "ใกล้รอบ" alert
    const prev = typeof sent[v.id] === "number" ? `${sent[v.id]}|near` : sent[v.id];
    return prev === mark ? [] : [{ v, h, pm, mark }];
  });
  let remembered = false;
  for (const d of due) {
    const drivers = await prisma.fuelRequest.findMany({ where: { vehicleId: d.v.id }, orderBy: { createdAt: "desc" }, take: 3, select: { driverId: true } });
    const text = `${PM_STATE[d.pm.state][0]}เช็คระยะ รถ ${d.v.code}: ชม.เครื่อง ${num(d.h)} / ครบรอบที่ ${num(d.pm.due)}\n`;
    // each gets a page their role can open
    const toDrivers = await notifyUsers([...new Set(drivers.map((x) => x.driverId))], text + `เปิดแจ้งซ่อม: ${appLink(`/driver/repair?vehicle=${d.v.id}&pm=1`)}`);
    const toPurchasing = await notifyRoles(["purchasing"], text + `นัดเช็คระยะ: ${appLink(`/office/vehicles/${d.v.id}`)}`);
    if (toDrivers || toPurchasing) {
      sent[d.v.id] = d.mark;
      remembered = true;
    }
  }
  if (remembered) await prisma.appSetting.upsert({ where: { key: PM_ALERT_KEY }, update: { value: sent }, create: { key: PM_ALERT_KEY, value: sent } });

  // d) The office PC silent for an hour while bills wait for Express: tell the Office once per silence
  // (keyed by the last time it was heard from).
  const [m, waiting, agentAlert] = await Promise.all([
    getMasters(),
    prisma.expressOrder.count({ where: { OR: [{ status: "queued" }, { status: "written", r3Status: { in: ["queued", "force"] } }] } }),
    prisma.appSetting.findUnique({ where: { key: AGENT_ALERT_KEY } }),
  ]);
  let agentAlerted = false;
  if (m?.at && waiting && agentSilent(m, now.getTime()) && agentAlert?.value !== m.at) {
    agentAlerted = await notifyOfficeGroup(
      `เครื่อง Office (Express) ไม่ได้ติดต่อมาตั้งแต่ ${thDateTime(new Date(m.at))} มี ${waiting} รายการรอลง Express: ตรวจว่าเครื่องเปิดอยู่และต่อเน็ต\n${appLink("/office/express")}`
    );
    if (agentAlerted) await prisma.appSetting.upsert({ where: { key: AGENT_ALERT_KEY }, update: { value: m.at }, create: { key: AGENT_ALERT_KEY, value: m.at } });
  }

  return { fuelReminded: fuel.map((f) => f.no), clockOutAlerted: open.map((a) => a.user.name), serviceDue: due.map((d) => d.v.code), expressAgentAlerted: agentAlerted };
}

export async function GET(req: Request, { params }: { params: Promise<{ job: string }> }) {
  if (!bearerOk(req, process.env.CRON_SECRET)) return bad("ไม่มีสิทธิ์", 401);
  const { job } = await params;
  if (job === "tick") return ok(await tick());
  if (job === "daily" || job === "weekly") {
    let text = job === "daily" ? await dailySummary() : await weeklySummary();
    const q = job === "daily" ? await quotaUsage() : null;
    if (q) {
      // kept for the Office home page
      const value = { ...q, at: new Date().toISOString() };
      await prisma.appSetting.upsert({ where: { key: "line_quota" }, update: { value }, create: { key: "line_quota", value } });
      const nearFull = q.limit !== null && q.used >= q.limit * 0.8;
      text += `\nLINE ใช้ไป ${q.used}${q.limit === null ? "" : `/${q.limit}`} ข้อความเดือนนี้${nearFull ? " ใกล้เต็ม" : ""}`;
    }
    await notifyOfficeGroup(text);
    return ok({ text });
  }
  if (job === "alert") {
    if (req.method !== "POST") return bad("ใช้ได้เฉพาะ POST", 405);
    // a script's message may not be valid JSON: the Office still hears that something failed
    const text = str((await jsonBody(req)).text, 500);
    return ok({ sent: await notifyOfficeGroup(`แจ้งเตือนระบบ: ${text || "(ไม่มีรายละเอียด)"}`) });
  }
  return bad("ไม่พบงานนี้", 404);
}

export const POST = GET;
