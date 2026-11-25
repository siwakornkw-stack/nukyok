// The office-PC agent's own safety rules (scripts/express-agent.mjs, the ledger checks in
// scripts/express/dbf.mjs): a write that did not end cleanly holds its whole kind, a writer
// killed before its RESULT line is judged by the ledger it saved, values from the server are
// checked before they name a file, the lock is taken over only from a run that is gone or hung,
// and the company sent with every request is the Express folder's name.
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ledgerTime, noResult, stuckLedger, stuckText } from "../scripts/express/dbf.mjs";
import { DOC_NO, ORDER_ID, companyOf, dropLock, holdFor, keepLock, processAlive, stuckLedgers, takeLock } from "../scripts/express-agent.mjs";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "express-agent-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, text: string | Buffer) => {
  const f = path.join(dir, name);
  writeFileSync(f, text);
  return f;
};
// as fuel-write.ps1 saves it: UTF-8 with BOM
const ledger = (o: object) => "\uFEFF" + JSON.stringify(o);
const UNREADABLE = { status: "ไฟล์บันทึกอ่านไม่ได้" };
const ID = "cmwlrd7eu00066j2sc4ucw5xq";

describe("stuckLedger", () => {
  it("no ledger, or a write that ended cleanly, holds nothing", () => {
    expect(stuckLedger(path.join(dir, "none.json"))).toBeNull();
    for (const status of ["done", "exists", "busy", "rolled-back", "failed-unopened"]) expect(stuckLedger(put("a.json", ledger({ status })))).toBeNull();
  });

  it("a write that died half way or could not undo itself is stuck, with its numbers", () => {
    expect(stuckLedger(put("a.json", ledger({ status: "writing", pkNo: "PK0000005", h3No: "H3691124-03" })))).toMatchObject({ status: "writing", pkNo: "PK0000005", h3No: "H3691124-03" });
    expect(stuckLedger(put("b.json", JSON.stringify({ status: "ROLLBACK-FAILED", docNo: "R3691118-01" })))?.status).toBe("ROLLBACK-FAILED");
  });

  it("a ledger left empty, NUL-filled or cut off by a power cut, or without a known status, is stuck", () => {
    expect(stuckLedger(put("a.json", ""))).toEqual(UNREADABLE);
    expect(stuckLedger(put("b.json", Buffer.alloc(512)))).toEqual(UNREADABLE);
    expect(stuckLedger(put("c.json", ledger({ status: "done", pkNo: "PK0000005" }).slice(0, 12)))).toEqual(UNREADABLE);
    expect(stuckLedger(put("d.json", "null"))).toEqual(UNREADABLE);
    expect(stuckLedger(put("e.json", JSON.stringify({ pkNo: "PK0000005" })))).toEqual(UNREADABLE);
    expect(stuckLedger(put("f.json", JSON.stringify({ status: "half" })))?.status).toBe("half");
    mkdirSync(path.join(dir, "g.json")); // exists but cannot be read
    expect(stuckLedger(path.join(dir, "g.json"))).toEqual(UNREADABLE);
  });
});

describe("stuckText", () => {
  // The cleanup: the whole bill undone from its ledger (every added row deleted, every changed field
  // back to its logged old value), right whether or not each change reached disk (the last may not
  // have). Not "take back only this bill's part": that is wrong for a change that never reached disk.
  it("names what each kind reserved and the ledger file, and says to undo the whole bill from the ledger", () => {
    const fuel = stuckText({ status: "writing", pkNo: "PK0000005", h3No: "H3691124-03" }, "C:\\nukyok-agent\\var\\fuel-ledger\\a.json");
    expect(fuel).toContain("(writing PK0000005 H3691124-03)");
    expect(fuel).toContain("C:\\nukyok-agent\\var\\fuel-ledger\\a.json");
    expect(fuel).toContain("ย้อนบิลนี้ออกจาก Express ทั้งบิล");
    expect(fuel).toContain("ลบทุกแถวใน added");
    expect(fuel).toContain("ห้าม PACK");
    expect(fuel).toContain("แก้ทุกช่องใน changed กลับเป็นค่าเดิม");
    expect(fuel).toContain("changed รายการสุดท้ายอาจยังไม่ได้เขียน");
    expect(fuel).not.toContain("ย้อนเฉพาะส่วน");
    // fuel changes STMAS totreo twice (+litres, -litres): top-down, the first entry would be skipped
    expect(fuel).toContain("ทำจากรายการล่างสุดของ changed ขึ้นไป ช่องเดียวกันที่มีหลายรายการ ค่าที่ถูกคือ old ของรายการแรก");
    // "nobody changed it since" is checked against what the bill wrote, e.g. a PO / PK number staff issued meanwhile
    expect(fuel).toContain("เลขรัน ISRUN = เลข PK / PO ในไฟล์ + 1");
    expect(fuel).toContain("มีคนออกเลข PO / PK ใหม่ไปแล้ว");
    expect(fuel).not.toContain("express-backups");
    expect(stuckText({ status: "writing", poNo: "PO0002895", rrNo: "RR691124-01" }, "b.json")).toContain("(writing PO0002895 RR691124-01)");
    expect(stuckText({ status: "ROLLBACK-FAILED", pk: "PK0000004", docNo: "R3691118-01" }, "c.json")).toContain("(ROLLBACK-FAILED PK0000004 R3691118-01)");
  });

  // The web keeps the first 500 characters of an order's error (str): the file and the order of the cleanup fit.
  it("puts the ledger file, what to do and the order of the cleanup in the first 500 characters", () => {
    const file = `C:\\nukyok-agent\\var\\repair-ledger\\${ID}.json`;
    const head = stuckText({ status: "ROLLBACK-FAILED", poNo: "PO0002895", rrNo: "RR691124-01" }, file).slice(0, 500);
    expect(head).toContain(file);
    expect(head).toContain("แล้วย้ายไฟล์ออกจากโฟลเดอร์นั้นก่อนกดลองใหม่หรือคีย์เอง");
    expect(head).toContain("ค่าที่ถูกคือ old ของรายการแรก");
  });

  it("points a ledger that cannot be read to its .tmp, else to the tables saved before the run", () => {
    const text = stuckText(UNREADABLE, "C:\\nukyok-agent\\var\\fuel-ledger\\a.json");
    expect(text).toContain("(ไฟล์บันทึกอ่านไม่ได้)");
    expect(text).toContain("ใช้ added / changed จาก a.json.tmp ข้างกันแทน");
    expect(text).toContain("var\\express-backups");
  });

  // Cut off between the temp file's flush and its swap: the row the write had just appended is
  // in Express, but listed only in "<ledger>.tmp".
  it("names a <ledger>.tmp left next to it, to be read and moved along", () => {
    const led = { status: "writing", pkNo: "PK0000005" };
    const f = put(`${ID}.json`, ledger(led));
    const plain = stuckText(led, f);
    expect(plain).not.toContain(".tmp");
    put(`${ID}.json.tmp`, ledger({ ...led, added: [["fwst", 4012]] }));
    const text = stuckText(led, f);
    // the note follows the file name, inside the 500 characters the web keeps
    const at = plain.indexOf(": ย้อนบิลนี้");
    expect(text.startsWith(plain.slice(0, at))).toBe(true);
    expect(text.endsWith(plain.slice(at))).toBe(true);
    expect(text.slice(0, 500)).toContain("ย้ายไปพร้อมกัน)");
    expect(text).toContain(`มี ${ID}.json.tmp ข้างกันด้วย`);
    // an append listed only in the .tmp is in Express; a change listed only there was not written
    expect(text).toContain("แถวใน added ของ .tmp อยู่ใน Express แล้ว");
    expect(text).toContain("changed ที่มีแค่ใน .tmp ยังไม่ได้เขียน");
    expect(text).toContain("ย้ายไปพร้อมกัน");
    // the same text wherever the ledger is shown: its own order, the orders it holds, a writer killed part way
    expect(holdFor(ID, ORDER_ID, stuckLedgers(dir))?.error).toBe(text);
    expect(holdFor("cmaaaaaaaaaaaaaaaaaaaaaaa", ORDER_ID, stuckLedgers(dir))?.error).toContain(`${ID}.json.tmp`);
    expect(noResult(f, undefined, { stdout: "", stderr: "" }, (l: object) => l)?.error).toBe(text);
    // a .tmp cut off too (NUL-filled) is named all the same: the appended row may be listed nowhere
    put(`${ID}.json.tmp`, Buffer.alloc(64));
    expect(stuckText(led, f)).toBe(text);
  });
});

// A writer killed by its runner's timeout (or that never started) prints no RESULT line.
describe("noResult", () => {
  const killed = { stdout: "", stderr: "", error: new Error("spawnSync powershell.exe ETIMEDOUT") };
  // an H3 written onto an existing PK: the ledger leaves the PK's number empty, the plan has it
  const fuelDocs = (l: { pkNo?: string; h3No?: string }) => ({ pkNo: l.pkNo || "PK0000003", h3No: l.h3No });
  // as the writer saves it during this attempt: the ledger's mtime moves
  const rewrite = (f: string, o: object | string) => {
    writeFileSync(f, typeof o === "string" ? o : ledger(o));
    const t = new Date(Date.now() + 5000);
    utimesSync(f, t, t);
  };

  it("a ledger the writer did not save (none, or an older one left as it was) means nothing was written", () => {
    const f = path.join(dir, `${ID}.json`);
    const none = noResult(f, ledgerTime(f), killed, fuelDocs);
    expect(none).toEqual({ ok: false, error: "โปรแกรมเขียนไม่ได้เริ่มเขียน ยังไม่มีอะไรลง Express (spawnSync powershell.exe ETIMEDOUT)" });
    put(`${ID}.json`, ledger({ status: "rolled-back", error: "ไม่พบผู้จำหน่าย 0009" }));
    expect(noResult(f, ledgerTime(f), killed, fuelDocs)).toEqual(none);
    expect(noResult(f, ledgerTime(f), { stdout: "", stderr: "" }, fuelDocs)).toEqual({ ok: false, error: "โปรแกรมเขียนไม่ได้เริ่มเขียน ยังไม่มีอะไรลง Express" });
  });

  it("a clean end saved before the kill counts as that end: the bill is in Express, not an error to key again", () => {
    const f = put(`${ID}.json`, ledger({ status: "rolled-back", error: "ไม่พบผู้จำหน่าย 0009" }));
    const before = ledgerTime(f);
    rewrite(f, { status: "done", pkNo: "", h3No: "H3691124-03" });
    expect(noResult(f, before, killed, fuelDocs)).toEqual({ ok: true, existed: false, pkNo: "PK0000003", h3No: "H3691124-03" });
    rewrite(f, { status: "exists", pkNo: "PK0000005", h3No: "H3691124-02" });
    expect(noResult(f, before, killed, fuelDocs)).toEqual({ ok: true, existed: true, pkNo: "PK0000005", h3No: "H3691124-02" });
    rewrite(f, { status: "done", poNo: "PO0002895", rrNo: "RR691124-01" });
    expect(noResult(f, before, killed, (l: { poNo?: string; rrNo?: string }) => ({ poNo: l.poNo, rrNo: l.rrNo }))).toEqual({ ok: true, existed: false, poNo: "PO0002895", rrNo: "RR691124-01" });
    rewrite(f, { status: "done", pk: "PK0000004", docNo: "R3691118-01" });
    expect(noResult(f, before, killed, (l: { docNo?: string }) => ({ docNo: l.docNo }))).toEqual({ ok: true, existed: false, docNo: "R3691118-01" });
  });

  it("busy stays queued; a write it undid itself is an error with its own message", () => {
    const f = path.join(dir, `${ID}.json`);
    rewrite(f, { status: "busy" });
    expect(noResult(f, undefined, killed, fuelDocs)).toMatchObject({ ok: false, busy: true });
    rewrite(f, { status: "rolled-back", error: "ไม่พบผู้จำหน่าย 0009 ใน APMAS/APBAL" });
    expect(noResult(f, undefined, killed, fuelDocs)).toEqual({ ok: false, error: "ไม่พบผู้จำหน่าย 0009 ใน APMAS/APBAL (spawnSync powershell.exe ETIMEDOUT)" });
    rewrite(f, { status: "failed-unopened", error: "Provider not registered" });
    expect(noResult(f, undefined, killed, fuelDocs)?.error).toContain("Provider not registered");
  });

  it("cut off part way, undone only in part, or unreadable is stuck: it holds the whole kind", () => {
    const f = path.join(dir, `${ID}.json`);
    const led = { status: "writing", pkNo: "PK0000005", h3No: "H3691124-03" };
    rewrite(f, led);
    expect(noResult(f, undefined, killed, fuelDocs)).toEqual({ ok: false, stuck: true, error: `${stuckText(led, f)} (spawnSync powershell.exe ETIMEDOUT)` });
    rewrite(f, { status: "ROLLBACK-FAILED", pkNo: "PK0000005" });
    expect(noResult(f, undefined, killed, fuelDocs)).toMatchObject({ ok: false, stuck: true });
    rewrite(f, Buffer.alloc(64).toString());
    expect(noResult(f, undefined, killed, fuelDocs)).toMatchObject({ ok: false, stuck: true });
    expect(noResult(f, undefined, killed, fuelDocs)?.error).toContain(UNREADABLE.status);
  });
});

describe("stuckLedgers", () => {
  it("lists every stuck ledger of a kind; clean ones, a writer's temp file and ledgers moved to a subfolder do not count", () => {
    put("cmaaaaaaaaaaaaaaaaaaaaaaa.json", ledger({ status: "done" }));
    put("cmbbbbbbbbbbbbbbbbbbbbbbb.json", ledger({ status: "writing", pkNo: "PK0000005" }));
    put("cmbbbbbbbbbbbbbbbbbbbbbbb.json.tmp", "");
    put("cmccccccccccccccccccccccc.json", "");
    mkdirSync(path.join(dir, "checked"));
    put(path.join("checked", "cmddddddddddddddddddddddd.json"), ledger({ status: "writing" }));
    const found = stuckLedgers(dir).map((s) => [s.name, s.led.status, s.file]);
    expect(found.sort()).toEqual([
      ["cmbbbbbbbbbbbbbbbbbbbbbbb", "writing", path.join(dir, "cmbbbbbbbbbbbbbbbbbbbbbbb.json")],
      ["cmccccccccccccccccccccccc", UNREADABLE.status, path.join(dir, "cmccccccccccccccccccccccc.json")],
    ]);
  });

  it("no ledger folder yet: nothing is stuck", () => {
    expect(stuckLedgers(path.join(dir, "none"))).toEqual([]);
  });
});

describe("holdFor", () => {
  it("refuses an order id that is not a cuid and an R3 PK that is not a plain document number: they name ledger files", () => {
    for (const bad of ["../../x", "..\\..\\x", `${ID}/..`, ID.toUpperCase(), "abc", "", null, 42, [ID]]) expect(holdFor(bad, ORDER_ID, [])?.status).toBe("error");
    expect(holdFor(ID, ORDER_ID, [])).toBeNull();
    for (const bad of ["..", "../PK0000001", "PK0000001\\x", "C:PK0000001", "PK 1", "PK0000001.json", null]) expect(holdFor(bad, DOC_NO, [])?.status).toBe("error");
    for (const ok of ["PK0000004", "PO0001234", "RR691118-01"]) expect(holdFor(ok, DOC_NO, [])).toBeNull();
  });

  it("holds every order of a kind while one write of it is stuck: its own order is an error, the others stay queued", () => {
    const file = path.join("C:\\nukyok-agent\\var\\fuel-ledger", `${ID}.json`);
    const stuck = [{ name: ID, file, led: { status: "writing", pkNo: "PK0000005", h3No: "H3691124-03" } }];
    const own = holdFor(ID, ORDER_ID, stuck);
    expect(own).toEqual({ status: "error", error: stuckText(stuck[0].led, file) });
    expect(own?.error).toContain("(writing PK0000005 H3691124-03)");
    expect(own?.error).toContain(file);
    const other = holdFor("cmaaaaaaaaaaaaaaaaaaaaaaa", ORDER_ID, stuck);
    expect(other?.status).toBe("busy");
    expect(other?.error).toContain("(writing PK0000005 H3691124-03)");
    expect(other?.error).toContain(file);
  });

  it("an R3 waits while the R3 of any PK is stuck (append mode adds to the same day's R3)", () => {
    const stuck = [{ name: "PK0000004", file: "PK0000004.json", led: { status: "ROLLBACK-FAILED", docNo: "R3691118-01" } }];
    expect(holdFor("PK0000009", DOC_NO, stuck)?.status).toBe("busy");
    expect(holdFor("PK0000004", DOC_NO, stuck)).toMatchObject({ status: "error" });
    expect(holdFor("PK0000004", DOC_NO, stuck)?.error).toContain("(ROLLBACK-FAILED R3691118-01)");
  });
});

describe("agent lock", () => {
  const lock = () => path.join(dir, "express-agent.lock");
  const age = (f: string, minutes: number) => {
    const t = new Date(Date.now() - minutes * 60 * 1000);
    utimesSync(f, t, t);
  };

  it("one run at a time: a live holder keeps it, and only the holder removes it", () => {
    const f = lock(), a = `${process.pid} A`, b = `${process.pid} B`;
    expect(takeLock(f, a)).toBe(true);
    expect(takeLock(f, b)).toBe(false);
    expect(keepLock(f, a)).toBe(true);
    expect(keepLock(f, b)).toBe(false);
    dropLock(f, b);
    expect(existsSync(f)).toBe(true);
    dropLock(f, a);
    expect(existsSync(f)).toBe(false);
  });

  it("is taken over from a run that is gone; that run then writes nothing more", () => {
    const f = lock();
    const gone = spawnSync(process.execPath, ["-e", ""]).pid!;
    const old = `${gone} 2026-11-24T01:00:00.000Z`;
    expect(processAlive(gone)).toBe(false);
    expect(processAlive(process.pid)).toBe(true);
    writeFileSync(f, old);
    expect(takeLock(f, `${process.pid} B`)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe(`${process.pid} B`);
    expect(keepLock(f, old)).toBe(false);
  });

  it("from a live pid only when it was not touched for 30 minutes (a hung run, or its pid given to another program)", () => {
    const f = lock(), a = `${process.pid} A`;
    writeFileSync(f, a);
    age(f, 29);
    expect(takeLock(f, `${process.pid} B`)).toBe(false);
    age(f, 31);
    expect(keepLock(f, a)).toBe(true); // a run that is still going touches it at every step
    expect(takeLock(f, `${process.pid} B`)).toBe(false);
    age(f, 31);
    expect(takeLock(f, `${process.pid} C`)).toBe(true);
    expect(keepLock(f, a)).toBe(false);
  });

  it("a lock without a pid (being written just now, or left by an older agent) holds until stale", () => {
    const f = lock();
    writeFileSync(f, "");
    expect(takeLock(f, `${process.pid} B`)).toBe(false);
    age(f, 31);
    expect(takeLock(f, `${process.pid} B`)).toBe(true);
  });
});

describe("companyOf", () => {
  it("is the Express folder's name, upper-case (x-express-company)", () => {
    expect(companyOf("D:\\ACExpress\\ExpressI\\DHEWA66")).toBe("DHEWA66");
    expect(companyOf("\\\\OFFICE-PC\\ACExpress\\ExpressI\\testr3\\")).toBe("TESTR3");
    expect(companyOf("D:/ACExpress/ExpressI/TestR3")).toBe("TESTR3");
  });
});
