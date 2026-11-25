// Minimal read-only reader for Express Accounting tables (Visual FoxPro .DBF,
// Thai text in windows-874), and for the ledgers the writers leave. Plain Node,
// no dependencies: it runs on the office PC that holds the Express data, not
// only inside the app.
//
// Express must never be modified, so this only ever reads: readFileSync opens
// the file read-only and nothing here writes, locks or creates files next to it.
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";

const td = new TextDecoder("windows-874");

// "20250109" -> "2025-01-09"; blank -> null.
function dbfDate(s) {
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

// Parse a whole table from a Buffer. Deleted rows (marked "*") are skipped.
// Types: C text, N numeric text, D date, L logical, B double, I int32, Y currency.
export function parseDbf(buf) {
  const count = buf.readUInt32LE(4);
  const headerLen = buf.readUInt16LE(8);
  const recLen = buf.readUInt16LE(10);
  const fields = [];
  let off = 1; // byte 0 of a record is the deleted flag
  for (let p = 32; p + 32 <= headerLen && buf[p] !== 0x0d; p += 32) {
    const name = buf.toString("latin1", p, p + 11).replace(/\0.*$/, "");
    const type = String.fromCharCode(buf[p + 11]);
    const len = buf[p + 16];
    fields.push({ name, type, len, off });
    off += len;
  }
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = headerLen + i * recLen;
    if (start + recLen > buf.length) break; // file still being appended to
    if (buf[start] === 0x2a) continue;
    const row = {};
    for (const f of fields) {
      const raw = buf.subarray(start + f.off, start + f.off + f.len);
      switch (f.type) {
        case "B": row[f.name] = raw.readDoubleLE(0); break;
        case "I": row[f.name] = raw.readInt32LE(0); break;
        case "Y": row[f.name] = Number(raw.readBigInt64LE(0)) / 10000; break;
        case "N": case "F": { const t = raw.toString("latin1").trim(); row[f.name] = t ? Number(t) : 0; break; }
        case "D": row[f.name] = dbfDate(raw.toString("latin1").trim()); break;
        case "L": row[f.name] = /^[TtYy]/.test(raw.toString("latin1")); break;
        case "C": row[f.name] = td.decode(raw).replace(/\0/g, "").trim(); break;
        default: break; // memo/general fields are not needed
      }
    }
    rows.push(row);
  }
  return rows;
}

export function readDbf(path) {
  return parseDbf(readFileSync(path));
}

// The writers' ledgers (var/<kind>-ledger/<name>.json, rewritten by fuel- / repair- /
// r3-write.ps1 at every step). null = there is none. A ledger that cannot be read (a power cut
// while it was rewritten: empty, NUL-filled, cut off), is not an object or has no status reads
// as { status: "ไฟล์บันทึกอ่านไม่ได้" }.
const UNREADABLE = "ไฟล์บันทึกอ่านไม่ได้";
export function readLedger(file) {
  let led;
  try {
    led = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    if (e?.code === "ENOENT") return null;
  }
  return typeof led?.status === "string" ? led : { status: UNREADABLE };
}

// null = no ledger, or its write ended cleanly. Else the ledger: a write that died half way
// ("writing"), could not undo itself ("ROLLBACK-FAILED"), or left a ledger that cannot be read
// needs a person to check Express before anything of its kind is written again.
const LEDGER_CLEAN = ["done", "exists", "busy", "rolled-back", "failed-unopened"];
export function stuckLedger(file) {
  const led = readLedger(file);
  return led && !LEDGER_CLEAN.includes(led.status) ? led : null;
}

// What a person does about a stuck ledger, shown with its own order and with every order it
// holds: undo the bill fully from its ledger, then move the ledger out and ลองใหม่. Every row in
// "added" is marked deleted by its record number once its document number is checked (never PACK:
// record numbers would shift under the other entries and skipped numbers could be reused). Every
// "changed" field goes back to its logged old value, from the last entry up: a field listed more
// than once (fuel's STMAS totreo, +litres then -litres) ends at the old value of its first entry,
// and one that already holds it needs nothing. That is right whether or not the changes reached
// disk, as long as nobody changed those fields since: the field must hold its old value or what the
// bill wrote (ISRUN counter: the ledger's PK / PO + 1; totreo: old +- litres; APMAS / APBAL: old +
// the bill total; lasrcv: the later of old and the bill date); anything else is left and accounting
// asked. Each step is flushed (a changed row gone back to before the flush) before the next is
// logged, so all the ledger lists is in Express but perhaps its last "changed" entry (logged just
// before its step). A "<ledger>.tmp" left next to it means the writer stopped while saving the
// ledger (it writes that file, then swaps it in): an append listed only in the .tmp is in Express
// (appended before it was logged), a change listed only there was not written (logged before its
// step), and with the .tmp cut off too an append may be listed nowhere. So the .tmp is named
// whenever it is there, to be read and moved with the ledger. A ledger that cannot be read points
// to the .tmp, else to the tables saved before the run (var/express-backups). The web keeps the
// first 500 characters of an error (str), so the file, those notes and what to do come first; the
// rules after them may be cut there (agent.log and README-TH have them whole).
export function stuckText(led, file) {
  const what = [led.status, led.pk, led.pkNo, led.h3No, led.poNo, led.rrNo, led.docNo].filter(Boolean).join(" ");
  const unreadable = led.status === UNREADABLE
    ? ` (ใช้ added / changed จาก ${path.basename(file)}.tmp ข้างกันแทน ถ้าไม่มีหรืออ่านไม่ได้ เทียบตารางใน Express กับชุดสำรองก่อนบิลนี้ใน var\\express-backups)`
    : "";
  const tmp = existsSync(`${file}.tmp`)
    ? ` (มี ${path.basename(file)}.tmp ข้างกันด้วย: แถวใน added ของ .tmp อยู่ใน Express แล้วแม้ไม่อยู่ใน .json ให้ลบด้วย ส่วน changed ที่มีแค่ใน .tmp ยังไม่ได้เขียน ไม่ต้องแก้ แล้วย้ายไปพร้อมกัน)`
    : "";
  return (
    `เขียนลง Express ค้างไว้ไม่สมบูรณ์ (${what}) ไฟล์บันทึก ${file}${unreadable}${tmp}: ` +
    `ย้อนบิลนี้ออกจาก Express ทั้งบิลตามไฟล์ แล้วย้ายไฟล์ออกจากโฟลเดอร์นั้นก่อนกดลองใหม่หรือคีย์เอง (ขั้นตอนใน README-TH.txt): ` +
    `ลบทุกแถวใน added (ทำเครื่องหมายลบตามเลขระเบียนหลังตรวจเลขเอกสาร ห้าม PACK) ` +
    `แก้ทุกช่องใน changed กลับเป็นค่าเดิม (old) ทำจากรายการล่างสุดของ changed ขึ้นไป ช่องเดียวกันที่มีหลายรายการ ค่าที่ถูกคือ old ของรายการแรก ` +
    `ค่าที่เห็นต้องเป็น old (ไม่ต้องแก้: changed รายการสุดท้ายอาจยังไม่ได้เขียน) หรือค่าที่บิลนี้ใส่ ` +
    `(เลขรัน ISRUN = เลข PK / PO ในไฟล์ + 1, totreo = old ± ลิตร, ยอดใน APMAS / APBAL = old + ยอดบิล, lasrcv = วันที่บิลถ้าใหม่กว่า old) ` +
    `ถ้าเป็นค่าอื่น (เช่น มีคนออกเลข PO / PK ใหม่ไปแล้ว) อย่าแก้ช่องนั้น ให้ปรึกษาฝ่ายบัญชี`
  );
}

// The ledger's mtime (undefined: there is none), taken just before a writer starts: see noResult.
export const ledgerTime = (file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs;

// A writer that printed no RESULT line was killed by its runner's timeout (no rollback, no
// RESULT; it may have ended cleanly just before) or never started. It saves its ledger right
// after opening Express, before any change: a ledger it did not save (mtime still `before`)
// means nothing was written, one it saved says how far it got. r: spawnSync's result. docs: the
// document numbers of a write that ended cleanly, from its ledger.
export function noResult(file, before, r, docs) {
  const detail = (r.stderr || r.stdout || r.error?.message || "").trim().slice(0, 300);
  const why = detail ? ` (${detail})` : "";
  if (ledgerTime(file) === before) return { ok: false, error: `โปรแกรมเขียนไม่ได้เริ่มเขียน ยังไม่มีอะไรลง Express${why}` };
  const led = readLedger(file) || { status: UNREADABLE };
  if (led.status === "done" || led.status === "exists") return { ok: true, existed: led.status === "exists", ...docs(led) };
  if (led.status === "busy") return { ok: false, busy: true, error: `มีคนกำลังแก้ข้อมูลที่ต้องใช้ใน Express อยู่${why}` };
  if (led.status === "rolled-back" || led.status === "failed-unopened") return { ok: false, error: `${led.error || "เขียนลง Express ไม่สำเร็จ"}${why}` };
  return { ok: false, stuck: true, error: `${stuckText(led, file)}${why}` };
}
