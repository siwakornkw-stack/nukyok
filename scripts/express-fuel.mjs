// Writes the PK (+ H3) for fuel bills saved on the web into Express.
//
//   node scripts/express-fuel.mjs --dir <Express company folder> --order <order.json>           (plan only)
//   node scripts/express-fuel.mjs --dir <Express company folder> --order <order.json> --write   (write it)
//
// order.json: { id, withH3, supplier, item, dep, date, invoice, liters, price, amount }
// (what GET /api/express/fuel hands out), plus force: true once Office has confirmed that
// another H3 / PK of the invoice is another bill. Plans with scripts/express/fuel.mjs,
// writes through the VFP OLE DB provider (32-bit PowerShell + express/fuel-write.ps1).
// Safe to repeat: an H3 with this tax invoice and amount, or a PK with it in "อ้างอิง"
// for this amount and vehicle, is reported, not written again (the invoice from the same
// supplier with another amount or vehicle is an error a person checks). Each write
// leaves var/fuel-ledger/<order id>.json.
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf, stuckLedger, stuckText, ledgerTime, noResult } from "./express/dbf.mjs";
import { planFuel } from "./express/fuel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PS32 = path.join(process.env.WINDIR || "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
export const FUEL_LEDGER_DIR = path.resolve("var/fuel-ledger");

export function readFuelTables(dir) {
  const t = (n) => readDbf(path.join(dir, `${n}.DBF`));
  return { popr: t("POPR"), poprit: t("POPRIT"), stmas: t("STMAS"), apmas: t("APMAS"), aptrn: t("APTRN"), isprd: t("ISPRD"), isrun: t("ISRUN") };
}

export function writeFuel(dir, plan) {
  mkdirSync(FUEL_LEDGER_DIR, { recursive: true });
  const ledger = path.join(FUEL_LEDGER_DIR, `${plan.orderId}.json`);
  // A run that died half way, could not undo itself, or left a ledger that cannot be read needs a person first.
  const prev = stuckLedger(ledger);
  if (prev) return { ok: false, stuck: true, error: stuckText(prev, ledger) };
  const tmp = mkdtempSync(path.join(tmpdir(), "fuel-"));
  try {
    const planFile = path.join(tmp, "plan.json");
    writeFileSync(planFile, JSON.stringify(plan), "utf8");
    const before = ledgerTime(ledger);
    const r = spawnSync(
      PS32,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "express", "fuel-write.ps1"), "-Dir", dir, "-PlanFile", planFile, "-Ledger", ledger],
      { encoding: "utf8", timeout: 180000 }
    );
    const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
    // Killed by the timeout above (no rollback) or never started: its ledger says how far it got.
    // An H3 written onto an existing PK leaves that PK's number only in the plan.
    if (!line) return noResult(ledger, before, r, (l) => ({ pkNo: l.pkNo || plan.pkNo, h3No: l.h3No }));
    const res = line.slice(7);
    const docs = (s) => {
      const [pkNo = "", h3No = ""] = s.split("|");
      return { pkNo: pkNo.trim(), h3No: h3No.trim() };
    };
    if (res.startsWith("OK:")) return { ok: true, ...docs(res.slice(3)) };
    if (res.startsWith("EXISTS:")) return { ok: true, existed: true, ...docs(res.slice(7)) };
    if (res.startsWith("BUSY:")) return { ok: false, busy: true, error: res.slice(5) };
    return { ok: false, error: res.replace(/^ERR:/, "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : "";
  };
  const dir = arg("--dir"), orderFile = arg("--order");
  if (!dir || !orderFile) {
    console.error("usage: node scripts/express-fuel.mjs --dir <Express company folder> --order <order.json> [--write]");
    process.exit(1);
  }
  const order = JSON.parse(readFileSync(orderFile, "utf8"));
  const plan = planFuel(order, readFuelTables(dir));
  console.log(JSON.stringify(plan, null, 2));
  if (process.argv.includes("--write") && plan.status === "ready") {
    const w = writeFuel(dir, plan);
    console.log(JSON.stringify(w));
    process.exit(w.ok ? 0 : 1);
  }
}
