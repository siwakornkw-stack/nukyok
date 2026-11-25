// Creates the R3 (ตั้งหนี้บัตรเครดิต) for an approved PK in Express.
//
//   node scripts/express-r3.mjs --dir <Express company folder> --pk PK0000001           (plan only)
//   node scripts/express-r3.mjs --dir <Express company folder> --pk PK0000001 --write   (write it)
//
// Plans from the Express tables (scripts/express/r3.mjs), then writes through the
// VFP OLE DB provider (32-bit PowerShell + scripts/express/r3-write.ps1), which
// keeps Express's indexes in step. Safe to repeat: an R3 already carrying the PK
// number (REFNUM) is reported, not written again. Every write leaves a ledger in
// var/r3-ledger/<PK>.json (what was written, or what was rolled back).
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf, stuckLedger, stuckText, ledgerTime, noResult } from "./express/dbf.mjs";
import { planR3 } from "./express/r3.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PS32 = path.join(process.env.WINDIR || "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");

export function readR3Tables(dir) {
  const t = (n) => readDbf(path.join(dir, `${n}.DBF`));
  return { aptrn: t("APTRN"), stcrd: t("STCRD"), apmas: t("APMAS"), isprd: t("ISPRD"), isrun: t("ISRUN") };
}

export const LEDGER_DIR = path.resolve("var/r3-ledger");

export function writeR3(dir, plan) {
  mkdirSync(LEDGER_DIR, { recursive: true });
  const ledger = path.join(LEDGER_DIR, `${plan.pkNo}.json`);
  // A run that died half way ("writing"), could not undo itself, or left a ledger that cannot
  // be read needs a person to look at Express before anything is written for this PK again.
  const prev = stuckLedger(ledger);
  if (prev) return { ok: false, stuck: true, error: stuckText(prev, ledger) };
  const tmp = mkdtempSync(path.join(tmpdir(), "r3-"));
  try {
    const planFile = path.join(tmp, "plan.json");
    writeFileSync(planFile, JSON.stringify(plan), "utf8");
    const before = ledgerTime(ledger);
    const r = spawnSync(
      PS32,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "express", "r3-write.ps1"), "-Dir", dir, "-PlanFile", planFile, "-Ledger", ledger],
      { encoding: "utf8", timeout: 120000 }
    );
    const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
    // Killed by the timeout above (no rollback) or never started: its ledger says how far it got.
    if (!line) return noResult(ledger, before, r, (l) => ({ docNo: l.docNo }));
    const res = line.slice(7);
    if (res.startsWith("OK:")) return { ok: true, docNo: res.slice(3).trim() };
    if (res.startsWith("EXISTS:")) return { ok: true, docNo: res.slice(7).trim(), existed: true };
    if (res.startsWith("BUSY:")) return { ok: false, busy: true, error: res.slice(5) };
    return { ok: false, error: res.replace(/^ERR:/, "") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : ""; };
  const dir = arg("--dir"), pk = arg("--pk");
  if (!dir || !pk) {
    console.error("usage: node scripts/express-r3.mjs --dir <Express company folder> --pk <PK no> [--write]");
    process.exit(1);
  }
  const plan = planR3({ pkNo: pk, ...readR3Tables(dir) });
  console.log(JSON.stringify(plan, null, 2));
  if (process.argv.includes("--write") && plan.status === "ready") {
    const r = writeR3(dir, plan);
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }
}
