import "server-only";
import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "crypto";

// Helpers for route handlers. Answer shape: { ok: true, ... } or { error: "<Thai message>" }.
export const ok = (data: Record<string, unknown> = {}) => NextResponse.json({ ok: true, ...data });
export const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

// Declared size of the body (nginx always sends Content-Length upstream).
const size = (req: Request) => Number(req.headers.get("content-length") || 0);

// JSON body as a plain object (a literal null / array / garbage / over maxBytes becomes {}).
export async function jsonBody(req: Request, maxBytes = 1_000_000): Promise<Record<string, unknown>> {
  if (size(req) > maxBytes) return {};
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

// "Authorization: Bearer <secret>", constant time; an unset secret never matches.
export function bearerOk(req: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(digest(req.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
}
