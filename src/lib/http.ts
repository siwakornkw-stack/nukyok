import "server-only";
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

// Helpers for route handlers. Answer shape: { ok: true, ... } or { error: "<Thai message>" }.
export const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

// Declared size of the body (nginx always sends Content-Length upstream).
const size = (req: Request) => Number(req.headers.get("content-length") || 0);

// JSON body as a plain object (a literal null / array / garbage / over maxBytes becomes {}). Only with
// Content-Type application/json: a page on another site can send a plain form or text/plain without asking
// the browser first (no CORS preflight), never JSON.
export async function jsonBody(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  if (!/^application\/json\s*(;|$)/i.test(req.headers.get("content-type") ?? "") || size(req) > maxBytes) return {};
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

// Untrusted values -> plain strings / numbers (never let an object reach a Prisma `where`).
export const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// "" -> null, "1,234.5" -> 1234.5, garbage -> NaN (callers reject NaN).
export function numOrNull(v: unknown): number | null {
  const s = typeof v === "number" ? String(v) : str(v, 30).replace(/,/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export const formStr = (fd: FormData, k: string, max = 500) => str(fd.get(k), max);
export const formNum = (fd: FormData, k: string) => numOrNull(fd.get(k));
export const formFiles = (fd: FormData, k: string) => fd.getAll(k).filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f && (f as File).size > 0);

// Multipart only (what ApiForm sends): a big urlencoded body costs far more memory to parse.
// Forms without photos pass a much smaller maxBytes.
export async function readForm(req: Request, maxBytes = 100_000_000): Promise<FormData | null> {
  if (!(req.headers.get("content-type") ?? "").startsWith("multipart/form-data") || size(req) > maxBytes) return null;
  return req.formData().catch(() => null);
}

// A browser request that another site's page made (CSRF), from its headers. Browsers send Origin with every
// POST ("null" when the page hides it) and with a GET only when a script of another origin asks, so an Origin
// that is not this host is refused on any method. No Origin = not a browser page (the office PC, cron, a
// script): it passes. nginx passes the Host the browser asked for.
export function foreignOrigin(h: Headers): boolean {
  const origin = h.get("origin");
  if (origin === null) return false;
  try {
    return new URL(origin).host !== (h.get("host") ?? "").toLowerCase();
  } catch {
    return true;
  }
}

// For requests that only change something (POST): Sec-Fetch-Site cross-site counts too. Not for a GET, where
// it is also a link on another site (a photo link sent by e-mail).
export const crossSite = (h: Headers) => h.get("sec-fetch-site") === "cross-site" || foreignOrigin(h);

// In production a secret anyone could guess counts as unset: shorter than 16 characters, a placeholder of an older
// .env.example (anything holding "change-me", such as "change-me" and "change-me-to-a-long-random-string") or a dev /
// e2e value (anything starting with "dev-", such as "dev-cron" and "dev-export"). Outside production the dev values work.
export const weakSecret = (s: string) => process.env.NODE_ENV === "production" && (s.length < 16 || /change-me|^dev-/i.test(s));

// "Authorization: Bearer <secret>", constant time; an unset or weak secret never matches.
export function bearerOk(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  if (weakSecret(secret)) {
    console.error("[http] a Bearer secret in .env is shorter than 16 characters, a placeholder or a dev- value: every call is refused");
    return false;
  }
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(req.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}
