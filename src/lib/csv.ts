import { createHmac } from "crypto";
import { weakSecret } from "./http";

// RFC 4180: a field holding a comma, quote or line break is quoted (quotes doubled); CRLF line ends.
// Text starting with = + - @ tab or CR gets a leading ' so a spreadsheet shows it as text instead of running it as a
// formula (a symptom typed as =HYPERLINK(...), opened in Excel); numbers are written as they are (-5 stays a number).
export function csv(rows: (string | number | null | undefined)[][]): string {
  const field = (v: string | number | null | undefined) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(field).join(",") + "\r\n").join("");
}

// Token of one kind of /api/export/<kind>: the first 32 hex characters of HMAC-SHA256(EXPORT_SECRET, kind), so the
// formula in a sheet opens only its own kind. "" while EXPORT_SECRET is unset (the export is off), and in production
// while it is weak (weakSecret in lib/http, as for the Bearer secrets). The old EXPORT_TOKEN is not read: every sheet
// that used it showed it in its formula, so tokens made from it would open every kind to those viewers. Office copies
// the formulas from the home page.
export function exportToken(kind: string): string {
  const secret = process.env.EXPORT_SECRET;
  if (!secret) return "";
  if (weakSecret(secret)) {
    console.error("[csv] EXPORT_SECRET is shorter than 16 characters, a placeholder or a dev- value: the export is off");
    return "";
  }
  return createHmac("sha256", secret).update(kind).digest("hex").slice(0, 32);
}
