// Office PC agent between this app and Express Accounting. Runs every minute
// from Windows Task Scheduler on the PC that holds the Express data:
//
//   node --env-file=.env scripts/express-agent.mjs
//
// .env on that PC (written by deploy/office/install.ps1; single quotes: Node turns \n inside double quotes into a new line):
//   EXPRESS_DIR='D:\ACExpress\ExpressI\<company>'    Express company folder (POPR.DBF ...); its name goes with every
//                                                     request (x-express-company): the web refuses another company
//   EXPRESS_SYNC_URL='https://nukyok.phuketnukyok.com'
//   EXPRESS_SYNC_SECRET='...'                         same value as on the server
//   EXPRESS_FUEL_MODE="live"     PK + H3 for fuel fills Office approved (fuel-write.ps1)
//   EXPRESS_REPAIR_MODE="live"   PO + RR for repair bills (repair-write.ps1)
//   EXPRESS_R3_MODE="live"       fuel H3 into the R3 (ตั้งหนี้บัตรเครดิต) of the bill date (r3-write.ps1)
//   EXPRESS_REPAIR_PO_PREFIX="PO"           PO book used for repairs
// Anything but "live" = off: that part is only planned/read, never written.
// The writers were verified on TESTR3 (fuel / R3 in nukyoksoftware, repair on 2026-11-18) and all three changed on
// 2026-11-24: they need the TESTR3 run in HANDOFF.md before this agent is installed.
// EXPRESS_MASTERS_ONLY=1 (set in the environment by the installer's connection test): only the
// master data and prices, with the writer flags of the modes above; nothing is written and the
// lock of an agent that is running is left alone.
// Writes need 32-bit PowerShell + the VFP OLE DB provider 9.0 SP2.
//
// Each run: master data every 15 minutes (fuel suppliers / per-vehicle items,
// repair suppliers / service items, read-only; with them two years of purchase
// prices for จัดซื้อ's เทียบราคา, sent when they changed) -> fuel queue -> repair queue ->
// R3 queue (last, so a bill approved this minute gets its R3 line in the same run).
// Before writing, the tables a write touches are copied to var/express-backups/.
// A write that did not end cleanly (its ledger in var/<kind>-ledger says "writing" /
// "ROLLBACK-FAILED", or cannot be read) holds every write of its kind until a person has
// undone that bill fully from its ledger (stuckText) and moved the ledger out of its
// folder: the next bill would take the half-written bill's number, or add to its
// half-written R3.
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync, readdirSync, copyFileSync, rmSync, utimesSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf, stuckLedger, stuckText } from "./express/dbf.mjs";
import { buildFuelMasters } from "./express/fuel-masters.mjs";
import { buildRepairMasters } from "./express/repair.mjs";
import { buildPrices } from "./express/prices.mjs";
import { planFuel } from "./express/fuel.mjs";
import { planRepair } from "./express/repair.mjs";
import { planR3 } from "./express/r3.mjs";
import { readFuelTables, writeFuel, FUEL_LEDGER_DIR } from "./express-fuel.mjs";
import { readRepairTables, writeRepair, repairOptions, REPAIR_LEDGER_DIR } from "./express-repair.mjs";
import { readR3Tables, writeR3, LEDGER_DIR as R3_LEDGER_DIR } from "./express-r3.mjs";

const DIR = process.env.EXPRESS_DIR || "";
const BASE = (process.env.EXPRESS_SYNC_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const SECRET = process.env.EXPRESS_SYNC_SECRET || "";
const MODE = {
  fuel: process.env.EXPRESS_FUEL_MODE === "live",
  repair: process.env.EXPRESS_REPAIR_MODE === "live",
  r3: process.env.EXPRESS_R3_MODE === "live",
};
const MASTERS_ONLY = process.env.EXPRESS_MASTERS_ONLY === "1";
const COMPANY = companyOf(DIR);
const STATE = path.resolve("var/express-agent.json");
const LOCK = path.resolve("var/express-agent.lock");
const LOCK_STALE_MS = 30 * 60 * 1000; // a running agent touches its lock before every step and write
const FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const MASTERS_EVERY_MS = 15 * 60 * 1000;
const PRICE_DAYS = 730; // purchase prices sent for เทียบราคา: the last two years
const PRICES_RESEND_MS = 6 * 60 * 60 * 1000; // unchanged prices are sent again after this
const BACKUPS = path.resolve("var/express-backups");
const KEEP_BACKUPS = 30; // per kind
const DOC_TABLES = ["POPR", "POPRIT", "ISRUN", "STMAS", "APTRN", "STCRD", "GLJNL", "GLJNLIT", "ISVAT", "APRCPCQ", "APBAL", "APMAS"];
const R3_TABLES = ["APTRN", "STCRD", "GLJNL", "GLJNLIT", "APMAS", "APBAL"];
export const ORDER_ID = /^[a-z0-9]{20,40}$/; // a cuid: the order's ledger file is named after it
export const DOC_NO = /^[A-Za-z0-9-]{1,20}$/; // a plain document number (PK0000012): the R3 ledger file is named after it
const at = new Date().toISOString();
const OWNER = `${process.pid} ${at}`; // this run, as written in the lock

// The Express company this PC writes to: the name of its folder (DHEWA66, TESTR3).
export function companyOf(dir) {
  return path.win32.basename(dir).toUpperCase();
}

// One run at a time (Task Scheduler plus a manual run would race, and a run the task
// stopped after 10 minutes may still be going). The lock holds "<pid> <start>" of its run
// and is touched before every step and write. Another run takes it over only when that
// process is gone, or when it was not touched for LOCK_STALE_MS (a hung run, or a pid
// Windows has given to another program); a run whose lock was taken over writes nothing more.
export function takeLock(file, owner) {
  try {
    writeFileSync(file, owner, { flag: "wx" });
    return true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw e;
  }
  let held;
  try {
    const pid = Number(readFileSync(file, "utf8").split(" ")[0]);
    // a lock without a pid (being written just now, or left by an older agent) counts while fresh
    held = Date.now() - statSync(file).mtimeMs < LOCK_STALE_MS && (!(pid > 0) || processAlive(pid));
  } catch {
    held = true; // removed or replaced just now: the next minute tries again
  }
  if (held) return false;
  writeFileSync(file, owner);
  return true;
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // there, but not ours to signal
  }
}

// Still this run's lock? Then it is touched, so that it does not look stale.
export function keepLock(file, owner) {
  try {
    if (readFileSync(file, "utf8") !== owner) return false;
    const now = new Date();
    utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

export function dropLock(file, owner) {
  try {
    if (readFileSync(file, "utf8") === owner) unlinkSync(file);
  } catch {}
}

// body: an object, or JSON already serialized
async function api(route, method, body) {
  const res = await fetch(`${BASE}/api/express/${route}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json", "x-express-company": COMPANY },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), // a hung request must not keep the run (and its lock) going
    ...(body ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} ${res.status} ${out.error || ""}`.trim());
  return out;
}

function backupTables(kind, tables) {
  const dest = path.join(BACKUPS, `${kind}-${at.replace(/[:.]/g, "-")}`);
  mkdirSync(dest, { recursive: true });
  const files = readdirSync(DIR);
  for (const t of tables) {
    for (const f of files.filter((n) => new RegExp(`^${t}\\.(dbf|cdx)$`, "i").test(n))) copyFileSync(path.join(DIR, f), path.join(dest, f));
  }
  const old = readdirSync(BACKUPS).filter((n) => n.startsWith(`${kind}-`)).sort();
  for (const n of old.slice(0, Math.max(0, old.length - KEEP_BACKUPS))) rmSync(path.join(BACKUPS, n), { recursive: true, force: true });
  return dest;
}

// The ledgers of a kind whose write did not end cleanly (see stuckLedger), with their order id / PK.
export function stuckLedgers(dir) {
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch (e) {
    if (e?.code !== "ENOENT") throw e; // a ledger folder that cannot be read fails the step: nothing is written
  }
  return names.flatMap((n) => {
    const file = path.join(dir, n), led = stuckLedger(file);
    return led ? [{ name: n.slice(0, -5), file, led }] : [];
  });
}

// Why an order (or an R3 PK) is not planned now. Values from the server name ledger files,
// so one of another shape is refused. While a write of its kind is stuck nothing of that kind
// is written: the order whose write it was is an error (Office hears it at once), the others
// stay queued ("busy"; the web tells the Office when they wait long).
export function holdFor(name, shape, stuck) {
  if (typeof name !== "string" || !shape.test(name)) return { status: "error", error: `รหัสที่เว็บส่งมาไม่ถูกต้อง: ${String(name).slice(0, 60)}` };
  const own = stuck.find((s) => s.name === name), s = own || stuck[0];
  if (!s) return null;
  return own
    ? { status: "error", error: stuckText(s.led, s.file) }
    : { status: "busy", error: `รอ: อีกรายการ${stuckText(s.led, s.file)} รายการนี้จึงจะลงต่อเอง` };
}

async function pushMasters() {
  const t = (n) => readDbf(path.join(DIR, `${n}.DBF`));
  const rows = { popr: t("POPR"), poprit: t("POPRIT"), stmas: t("STMAS"), apmas: t("APMAS"), istab: t("ISTAB"), isacc: t("ISACC"), aptrn: t("APTRN"), stcrd: t("STCRD") };
  const fuel = buildFuelMasters(rows);
  const repair = buildRepairMasters(rows, { prefix: repairOptions().prefix });
  await api("masters", "POST", { fuel: { ...fuel, writer: MODE.fuel }, repair: { ...repair, writer: MODE.repair } });
  let prices;
  try {
    prices = await pushPrices(rows);
  } catch (e) {
    prices = `prices failed: ${e?.message || e}`;
    process.exitCode = 1;
  }
  // 0 = this company has no fuel / repair PO since 2025: the web has nothing to choose from
  return `fuel ${fuel.suppliers.length} suppliers ${fuel.items.length} items, repair ${repair.suppliers.length} suppliers ${repair.items.length} items, ${prices}`;
}

// Purchase prices for เทียบราคา: sent when they changed, and again after PRICES_RESEND_MS.
async function pushPrices(rows) {
  const since = new Date(Date.now() - PRICE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const data = buildPrices(rows, { since });
  const body = JSON.stringify(data);
  const hash = createHash("sha256").update(body).digest("hex");
  if (hash === state.pricesHash && Date.now() - new Date(state.pricesAt || 0).getTime() < PRICES_RESEND_MS) return "prices unchanged";
  await api("prices", "POST", body);
  state.pricesHash = hash;
  state.pricesAt = at;
  return `prices ${data.lines.length} lines ${data.suppliers.length} suppliers`;
}

// Fuel: the PK and (for an ordinary vehicle) its H3 in one go: Office already approved on the web.
async function runFuel() {
  if (!MODE.fuel) return;
  const { orders = [] } = await api("fuel", "GET");
  if (!orders.length) return;
  let tables = readFuelTables(DIR), backup = "", stuck = stuckLedgers(FUEL_LEDGER_DIR);
  const results = [];
  for (const order of orders) {
    const hold = holdFor(order.id, ORDER_ID, stuck);
    if (hold) {
      results.push({ id: order.id, ...hold });
      continue;
    }
    const plan = planFuel(order, tables);
    if (plan.status === "exists") results.push({ id: order.id, status: "done", pkNo: plan.pkNo, h3No: plan.h3No });
    else if (plan.status !== "ready") results.push({ id: order.id, status: "error", error: plan.reason });
    else {
      if (!keepLock(LOCK, OWNER)) break; // another run took the lock over: it carries on from here
      if (!backup) backup = backupTables("fuel", DOC_TABLES);
      const w = writeFuel(DIR, plan);
      if (w.ok) {
        results.push({ id: order.id, status: "done", pkNo: w.pkNo, h3No: w.h3No });
        tables = readFuelTables(DIR); // the next bill must see these numbers
      } else {
        results.push({ id: order.id, status: w.busy ? "busy" : "error", error: w.error });
        stuck = stuckLedgers(FUEL_LEDGER_DIR); // cut off part way: the bills after it wait as well
      }
    }
  }
  await api("fuel", "POST", { results });
  log("fuel", results, (r) => [r.pkNo, r.h3No], backup);
}

async function runRepair() {
  if (!MODE.repair) return;
  const { orders = [] } = await api("repair", "GET");
  if (!orders.length) return;
  const opts = repairOptions();
  let tables = readRepairTables(DIR), backup = "", stuck = stuckLedgers(REPAIR_LEDGER_DIR);
  const results = [];
  for (const order of orders) {
    const hold = holdFor(order.id, ORDER_ID, stuck);
    if (hold) {
      results.push({ id: order.id, ...hold });
      continue;
    }
    const plan = planRepair(order, tables, opts);
    if (plan.status === "exists") results.push({ id: order.id, status: "done", poNo: plan.poNo, rrNo: plan.rrNo });
    else if (plan.status !== "ready") results.push({ id: order.id, status: "error", error: plan.reason });
    else {
      if (!keepLock(LOCK, OWNER)) break;
      if (!backup) backup = backupTables("repair", DOC_TABLES);
      const w = writeRepair(DIR, plan);
      if (w.ok) {
        results.push({ id: order.id, status: "done", poNo: w.poNo, rrNo: w.rrNo });
        tables = readRepairTables(DIR);
      } else {
        results.push({ id: order.id, status: w.busy ? "busy" : "error", error: w.error });
        stuck = stuckLedgers(REPAIR_LEDGER_DIR);
      }
    }
  }
  await api("repair", "POST", { results });
  log("repair", results, (r) => [r.poNo, r.rrNo], backup);
}

// R3: for every fuel PK whose H3 exists, add it to the R3 of the bill date (repairs have no R3).
async function runR3() {
  if (!MODE.r3) return;
  const { po = [], force = [] } = await api("r3", "GET");
  if (!po.length) return;
  let tables = readR3Tables(DIR), backup = "", stuck = stuckLedgers(R3_LEDGER_DIR);
  const results = [];
  for (const no of po) {
    const hold = holdFor(no, DOC_NO, stuck);
    if (hold) {
      results.push({ po: no, ...hold });
      continue;
    }
    const plan = planR3({ pkNo: no, ...tables }, { force: force.includes(no) });
    if (plan.status === "exists") results.push({ po: no, status: "done", docNo: plan.docNo });
    else if (plan.status === "waiting") results.push({ po: no, status: "waiting", error: plan.reason });
    else if (plan.status !== "ready") results.push({ po: no, status: "error", error: plan.reason });
    else {
      if (!keepLock(LOCK, OWNER)) break;
      if (!backup) backup = backupTables("r3", R3_TABLES);
      const w = writeR3(DIR, plan);
      if (w.ok) {
        results.push({ po: no, status: "done", docNo: w.docNo });
        tables = readR3Tables(DIR);
      } else {
        results.push({ po: no, status: w.busy ? "busy" : "error", error: w.error });
        stuck = stuckLedgers(R3_LEDGER_DIR);
      }
    }
  }
  await api("r3", "POST", { results });
  log("r3", results, (r) => [r.docNo], backup);
}

// Each reason once per line: a held kind repeats the same one for every order, every minute.
function log(kind, results, docs, backup) {
  const seen = new Set();
  const why = (e) => (!e ? "" : seen.has(e) ? " (same)" : (seen.add(e), ` (${e})`));
  const one = (r) => `${r.id ? String(r.id).slice(-8) : r.po} ${r.status} ${docs(r).filter(Boolean).join(" ")}${why(r.error)}`.trim();
  console.log(at, `express-${kind}: ${results.map(one).join(", ")}${backup ? ` · backup ${backup}` : ""}`);
}

let state = {};

async function main() {
  if (!DIR || !SECRET) {
    console.error("ต้องตั้ง EXPRESS_DIR และ EXPRESS_SYNC_SECRET ใน .env");
    process.exit(1);
  }
  mkdirSync(path.dirname(LOCK), { recursive: true });
  // The installer's connection test writes nothing, so it leaves the lock (and the run holding it) alone.
  if (!MASTERS_ONLY && !takeLock(LOCK, OWNER)) {
    console.log(at, "express-agent: another run is going, skipped");
    return;
  }
  try {
    try {
      state = JSON.parse(readFileSync(STATE, "utf8"));
    } catch {}
    const modes = JSON.stringify(MODE);
    if (MASTERS_ONLY || !state.mastersAt || state.modes !== modes || Date.now() - new Date(state.mastersAt).getTime() >= MASTERS_EVERY_MS) {
      // A failed send waits 15 minutes too: reading eight tables every minute for nothing.
      state = { ...state, mastersAt: at, modes };
      try {
        console.log(at, "express-agent: masters sent", await pushMasters(), modes);
      } catch (e) {
        console.error(at, "express-agent: masters failed:", e?.message || e);
        process.exitCode = 1;
      }
      writeFileSync(STATE, JSON.stringify(state));
    }
    if (MASTERS_ONLY) return;
    for (const [name, run] of [["fuel", runFuel], ["repair", runRepair], ["r3", runR3]]) {
      if (!keepLock(LOCK, OWNER)) {
        console.error(at, "express-agent: another run took the lock over, stopped");
        process.exitCode = 1;
        break;
      }
      try {
        await run();
      } catch (e) {
        console.error(at, `express-${name} failed:`, e?.message || e);
        process.exitCode = 1;
      }
    }
  } finally {
    if (!MASTERS_ONLY) dropLock(LOCK, OWNER);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
