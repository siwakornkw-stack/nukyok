// Office PC agent between this app and Express Accounting. Runs every minute
// from Windows Task Scheduler on the PC that holds the Express data:
//
//   node --env-file=.env scripts/express-agent.mjs
//
// .env on that PC (written by deploy/office/install.ps1; single quotes: Node turns \n inside double quotes into a new line):
//   EXPRESS_DIR='D:\ACExpress\ExpressI\<company>'    Express company folder (POPR.DBF ...)
//   EXPRESS_SYNC_URL='https://nukyok.phuketnukyok.com'
//   EXPRESS_SYNC_SECRET='...'                         same value as on the server
//   EXPRESS_FUEL_MODE="live"     PK + H3 for fuel fills Office approved (fuel-write.ps1, verified)
//   EXPRESS_REPAIR_MODE="live"   PO + RR for repair bills (repair-write.ps1, NOT verified yet: test on TESTR3 first)
//   EXPRESS_R3_MODE="live"       fuel H3 into the R3 (ตั้งหนี้บัตรเครดิต) of the bill date (r3-write.ps1, verified)
//   EXPRESS_REPAIR_PO_PREFIX="PO"           PO book used for repairs
// Anything but "live" = off: that part is only planned/read, never written.
// Writes need 32-bit PowerShell + the VFP OLE DB provider 9.0 SP2.
//
// Each run: master data every 15 minutes (fuel suppliers / per-vehicle items,
// repair suppliers / service items, read-only; with them two years of purchase
// prices for จัดซื้อ's เทียบราคา, sent when they changed) -> fuel queue -> repair queue ->
// R3 queue (last, so a bill approved this minute gets its R3 line in the same run).
// Before writing, the tables a write touches are copied to var/express-backups/.
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, statSync, unlinkSync, readdirSync, copyFileSync, rmSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { readDbf } from "./express/dbf.mjs";
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
const STATE = path.resolve("var/express-agent.json");
const LOCK = path.resolve("var/express-agent.lock");
const LOCK_STALE_MS = 15 * 60 * 1000;
const MASTERS_EVERY_MS = 15 * 60 * 1000;
const PRICE_DAYS = 730; // purchase prices sent for เทียบราคา: the last two years
const PRICES_RESEND_MS = 6 * 60 * 60 * 1000; // unchanged prices are sent again after this
const BACKUPS = path.resolve("var/express-backups");
const KEEP_BACKUPS = 30; // per kind
const DOC_TABLES = ["POPR", "POPRIT", "ISRUN", "STMAS", "APTRN", "STCRD", "GLJNL", "GLJNLIT", "ISVAT", "APRCPCQ", "APBAL", "APMAS"];
const R3_TABLES = ["APTRN", "STCRD", "GLJNL", "GLJNLIT", "APMAS", "APBAL"];
const at = new Date().toISOString();

if (!DIR || !SECRET) {
  console.error("ต้องตั้ง EXPRESS_DIR และ EXPRESS_SYNC_SECRET ใน .env");
  process.exit(1);
}

// One run at a time (Task Scheduler plus a manual run would race).
mkdirSync(path.dirname(LOCK), { recursive: true });
try {
  closeSync(openSync(LOCK, "wx"));
} catch {
  let age = 0;
  try {
    age = Date.now() - statSync(LOCK).mtimeMs;
  } catch {}
  if (age < LOCK_STALE_MS) {
    console.log(at, "express-agent: another run is going, skipped");
    process.exit(0);
  }
  writeFileSync(LOCK, String(process.pid)); // stale lock from a crashed run
}

// body: an object, or JSON already serialized
async function api(route, method, body) {
  const res = await fetch(`${BASE}/api/express/${route}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
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

// A write that died half way (its ledger says "writing" / "ROLLBACK-FAILED") can look like
// "already in Express" to the planner: a person checks Express before it counts as done.
function stuck(ledgerDir, name) {
  try {
    const s = JSON.parse(readFileSync(path.join(ledgerDir, `${name}.json`), "utf8").replace(/^\uFEFF/, "")).status;
    return s === "writing" || s === "ROLLBACK-FAILED" ? `เขียนลง Express ค้างไว้ไม่สมบูรณ์ (${s}) ต้องตรวจใน Express ก่อน: ${path.join(ledgerDir, name)}.json` : "";
  } catch {
    return "";
  }
}

async function pushMasters() {
  const t = (n) => readDbf(path.join(DIR, `${n}.DBF`));
  const rows = { popr: t("POPR"), poprit: t("POPRIT"), stmas: t("STMAS"), apmas: t("APMAS"), istab: t("ISTAB"), aptrn: t("APTRN"), stcrd: t("STCRD") };
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
  let tables = readFuelTables(DIR), backup = "";
  const results = [];
  for (const order of orders) {
    const halt = stuck(FUEL_LEDGER_DIR, order.id);
    if (halt) {
      results.push({ id: order.id, status: "error", error: halt });
      continue;
    }
    const plan = planFuel(order, tables);
    if (plan.status === "exists") results.push({ id: order.id, status: "done", pkNo: plan.pkNo, h3No: plan.h3No });
    else if (plan.status !== "ready") results.push({ id: order.id, status: "error", error: plan.reason });
    else {
      if (!backup) backup = backupTables("fuel", DOC_TABLES);
      const w = writeFuel(DIR, plan);
      if (w.ok) {
        results.push({ id: order.id, status: "done", pkNo: w.pkNo, h3No: w.h3No });
        tables = readFuelTables(DIR); // the next bill must see these numbers
      } else results.push({ id: order.id, status: w.busy ? "busy" : "error", error: w.error });
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
  let tables = readRepairTables(DIR), backup = "";
  const results = [];
  for (const order of orders) {
    const halt = stuck(REPAIR_LEDGER_DIR, order.id);
    if (halt) {
      results.push({ id: order.id, status: "error", error: halt });
      continue;
    }
    const plan = planRepair(order, tables, opts);
    if (plan.status === "exists") results.push({ id: order.id, status: "done", poNo: plan.poNo, rrNo: plan.rrNo });
    else if (plan.status !== "ready") results.push({ id: order.id, status: "error", error: plan.reason });
    else {
      if (!backup) backup = backupTables("repair", DOC_TABLES);
      const w = writeRepair(DIR, plan);
      if (w.ok) {
        results.push({ id: order.id, status: "done", poNo: w.poNo, rrNo: w.rrNo });
        tables = readRepairTables(DIR);
      } else results.push({ id: order.id, status: w.busy ? "busy" : "error", error: w.error });
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
  let tables = readR3Tables(DIR), backup = "";
  const results = [];
  for (const no of po) {
    const halt = stuck(R3_LEDGER_DIR, no);
    if (halt) {
      results.push({ po: no, status: "error", error: halt });
      continue;
    }
    const plan = planR3({ pkNo: no, ...tables }, { force: force.includes(no) });
    if (plan.status === "exists") results.push({ po: no, status: "done", docNo: plan.docNo });
    else if (plan.status === "waiting") results.push({ po: no, status: "waiting", error: plan.reason });
    else if (plan.status !== "ready") results.push({ po: no, status: "error", error: plan.reason });
    else {
      if (!backup) backup = backupTables("r3", R3_TABLES);
      const w = writeR3(DIR, plan);
      if (w.ok) {
        results.push({ po: no, status: "done", docNo: w.docNo });
        tables = readR3Tables(DIR);
      } else results.push({ po: no, status: w.busy ? "busy" : "error", error: w.error });
    }
  }
  await api("r3", "POST", { results });
  log("r3", results, (r) => [r.docNo], backup);
}

function log(kind, results, docs, backup) {
  const one = (r) => `${r.id ? r.id.slice(-8) : r.po} ${r.status} ${docs(r).filter(Boolean).join(" ")}${r.error ? ` (${r.error})` : ""}`.trim();
  console.log(at, `express-${kind}: ${results.map(one).join(", ")}${backup ? ` · backup ${backup}` : ""}`);
}

let state = {};
try {
  state = JSON.parse(readFileSync(STATE, "utf8"));
} catch {}
try {
  const modes = JSON.stringify(MODE);
  if (!state.mastersAt || state.modes !== modes || Date.now() - new Date(state.mastersAt).getTime() >= MASTERS_EVERY_MS) {
    // A failed send waits 15 minutes too: reading seven tables every minute for nothing.
    state = { ...state, mastersAt: at, modes };
    try {
      console.log(at, "express-agent: masters sent", await pushMasters(), modes);
    } catch (e) {
      console.error(at, "express-agent: masters failed:", e?.message || e);
      process.exitCode = 1;
    }
    writeFileSync(STATE, JSON.stringify(state));
  }
  for (const [name, run] of [["fuel", runFuel], ["repair", runRepair], ["r3", runR3]]) {
    try {
      await run();
    } catch (e) {
      console.error(at, `express-${name} failed:`, e?.message || e);
      process.exitCode = 1;
    }
  }
} finally {
  try {
    unlinkSync(LOCK);
  } catch {}
}
