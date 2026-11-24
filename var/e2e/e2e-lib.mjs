// Tiny HTTP helpers for the end-to-end smoke test against a running app.
import { readFileSync } from "fs";

export const BASE = process.env.BASE || "http://127.0.0.1:3000";
export const JPG = new Blob([readFileSync(new URL("./fixtures/test.jpg", import.meta.url))], { type: "image/jpeg" });
export const PDF = new Blob([readFileSync(new URL("./fixtures/test.pdf", import.meta.url))], { type: "application/pdf" });

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

export async function bearer(secret, path, body, method = body ? "POST" : "GET") {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${secret}`, ...(body ? { "Content-Type": "application/json" } : {}) },
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
