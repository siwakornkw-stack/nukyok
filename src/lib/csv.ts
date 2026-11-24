// RFC 4180: a field holding a comma, quote or line break is quoted (quotes doubled); CRLF line ends.
export function csv(rows: (string | number | null | undefined)[][]): string {
  const field = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(field).join(",") + "\r\n").join("");
}
