// Tiny HTTP helpers for the end-to-end smoke test against a running app.
import { readFileSync } from "fs";
import zlib from "zlib";

export const BASE = process.env.BASE || "http://127.0.0.1:3000";
export const JPG = new Blob([readFileSync(new URL("./fixtures/test.jpg", import.meta.url))], { type: "image/jpeg" });
export const PDF = new Blob([readFileSync(new URL("./fixtures/test.pdf", import.meta.url))], { type: "application/pdf" });
// A PNG of a few KB whose header claims 12000 x 9000 RGB (108 MP, over 300 MB decoded): the upload must refuse it
// from the header, before decoding it into memory.
export const BIG_PNG = new Blob([pngHeader(12000, 9000)], { type: "image/png" });

function pngHeader(w, h) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 8-bit
  ihdr[9] = 2; // RGB, no interlace
  const rows = zlib.deflateSync(Buffer.alloc((w * 3 + 1) * 10)); // 10 rows of those claimed
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", rows), chunk("IEND", Buffer.alloc(0))]);
}

let failures = 0;
export const check = (cond, msg, extra) => {
  if (cond) console.log("  ok  ", msg);
  else {
    failures++;
    console.log("  FAIL", msg, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : "");
  }
};
export const done = () => {
  console.log(failures ? `\n${failures} FAILED` : "\nALL OK");
  process.exit(failures ? 1 : 0);
};

export async function login(userId) {
  const r = await fetch(`${BASE}/api/auth/dev`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId }) });
  const c = r.headers.get("set-cookie") || "";
  if (!r.ok) throw new Error(`login ${userId} ${r.status}`);
  return c.split(";")[0];
}

export async function json(cookie, path, body, method = "POST") {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// The office PC names its Express company in x-express-company on every /api/express call: sent when EXPRESS_COMPANY
// is set (the project's .env is loaded by @prisma/client); `headers` adds or overrides headers.
export async function bearer(secret, path, body, method = body ? "POST" : "GET", headers = {}) {
  const company = process.env.EXPRESS_COMPANY;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(company && path.startsWith("/api/express/") ? { "x-express-company": company } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// fields: { name: value | Blob | [Blob, ...] }
export async function form(cookie, path, fields) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (x instanceof Blob) fd.append(k, x, x.type === "application/pdf" ? "a.pdf" : "a.jpg");
      else if (x !== undefined && x !== null) fd.append(k, String(x));
    }
  }
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { Cookie: cookie }, body: fd });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

export async function page(cookie, path) {
  const r = await fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
  const text = r.status === 200 ? await r.text() : "";
  return { status: r.status, location: r.headers.get("location") || "", text };
}
