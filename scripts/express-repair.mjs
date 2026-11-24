// Writes the PO + RR (credit purchase) for repair bills saved on the web into Express.
//
//   node scripts/express-repair.mjs --dir <Express company folder> --order <order.json>           (plan only)
//   node scripts/express-repair.mjs --dir <Express company folder> --order <order.json> --write   (write it)
//
// order.json: { id, supplier, item, dep, date, invoice, amount, vat, job, plate } (what GET
// /api/express/repair hands out). Setting from the environment:
//   EXPRESS_REPAIR_PO_PREFIX     PO book prefix in ISRUN (default "PO")
// The expense account comes from the item (STMAS.ACCCOD -> ISACC.ACCNUM01).
// Plans with scripts/express/repair.mjs, writes through the VFP OLE DB provider
// (32-bit PowerShell + express/repair-write.ps1). Same safety as express-fuel.mjs:
// an RR with this tax invoice is reported, not written again; each write leaves
// var/repair-ledger/<order id>.json.
import { spawnSync } from "child_process";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf } from "./express/dbf.mjs";
import { planRepair } from "./express/repair.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PS32 = path.join(process.env.WINDIR || "C:\\Windows", "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
export const REPAIR_LEDGER_DIR = path.resolve("var/repair-ledger");

export const repairOptions = () => ({ prefix: process.env.EXPRESS_REPAIR_PO_PREFIX || "PO" });

// What planRepair needs: the item and its account, the supplier, the RRs already there, periods, books.
export function readRepairTables(dir) {
  const t = (n) => readDbf(path.join(dir, `${n}.DBF`));
  return { stmas: t("STMAS"), isacc: t("ISACC"), apmas: t("APMAS"), aptrn: t("APTRN"), isprd: t("ISPRD"), isrun: t("ISRUN") };
}

export function writeRepair(dir, plan) {
  mkdirSync(REPAIR_LEDGER_DIR, { recursive: true });
  const ledger = path.join(REPAIR_LEDGER_DIR, `${plan.orderId}.json`);
  // A run that died half way, or could not undo itself, needs a person first.
  if (existsSync(ledger)) {
    let prev = {};
    try {
      prev = JSON.parse(readFileSync(ledger, "utf8").replace(/^\uFEFF/, ""));
    } catch {}
    if (prev.status === "writing" || prev.status === "ROLLBACK-FAILED") {
      return { ok: false, stuck: true, error: `บิลซ่อมนี้เขียนลง Express ค้างไว้ไม่สมบูรณ์ (${prev.status} ${prev.poNo || ""} ${prev.rrNo || ""}) ต้องตรวจใน Express ก่อน: ${ledger}` };
    }
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "repair-"));
  try {
    const planFile = path.join(tmp, "plan.json");
    writeFileSync(planFile, JSON.stringify(plan), "utf8");
    const r = spawnSync(
      PS32,
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(here, "express", "repair-write.ps1"), "-Dir", dir, "-PlanFile", planFile, "-Ledger", ledger],
      { encoding: "utf8", timeout: 180000 }
    );
    const line = (r.stdout || "").split(/\r?\n/).find((l) => l.startsWith("RESULT:"));
    if (!line) return { ok: false, error: `writer gave no result: ${(r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 300)}` };
    const res = line.slice(7);
    const docs = (s) => {
      const [poNo = "", rrNo = ""] = s.split("|");
      return { poNo: poNo.trim(), rrNo: rrNo.trim() };
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
    console.error("usage: node scripts/express-repair.mjs --dir <Express company folder> --order <order.json> [--write]");
    process.exit(1);
  }
  const order = JSON.parse(readFileSync(orderFile, "utf8"));
  const plan = planRepair(order, readRepairTables(dir), repairOptions());
  console.log(JSON.stringify(plan, null, 2));
  if (process.argv.includes("--write") && plan.status === "ready") {
    const w = writeRepair(dir, plan);
    console.log(JSON.stringify(w));
    process.exit(w.ok ? 0 : 1);
  }
}
