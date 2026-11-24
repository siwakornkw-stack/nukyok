import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { prisma } from "./db";
import type { Role } from "./roles";

// Session = signed cookie holding the user id. The user row is re-read on every
// request, so disabling someone or changing their roles applies at once.
const COOKIE = "nk_session";
const MAX_AGE = 30 * 24 * 3600;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET must be set (16+ characters)");
  return s;
}
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

function readToken(token: string | undefined): string | null {
  const [data, sig] = (token ?? "").split(".");
  if (!data || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    return typeof p.u === "string" && typeof p.e === "number" && p.e > Date.now() / 1000 ? p.u : null;
  } catch {
    return null;
  }
}

export async function setSession(userId: string) {
  const data = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(Date.now() / 1000) + MAX_AGE })).toString("base64url");
  (await cookies()).set(COOKIE, `${data}.${sign(data)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

// The signed-in user, whatever their status (null = not signed in).
export async function currentUser(): Promise<User | null> {
  const id = readToken((await cookies()).get(COOKIE)?.value);
  return id ? prisma.user.findUnique({ where: { id } }) : null;
}

// Only paths on this site ("/x", not "//evil" or "https://…") may be redirect targets. No control
// characters, spaces or backslashes anywhere: browsers drop tabs / newlines, so "/\t/evil" is "//evil".
export const safePath = (p: unknown) => (typeof p === "string" && /^\/(?![/\\])[^\x00-\x20\\]*$/.test(p) ? p : "/");

// Where /login sends people afterwards. A LIFF link lands on "/?liff.state=<path>" (on
// /login directly when the proxy rewrote a LINE callback, or inside ?next=): keep that
// path; a nested "/login?next=<path>" means <path>; never back to /login itself.
export function loginTarget(sp: Record<string, string | undefined>): string {
  let target = safePath(sp["liff.state"] ?? sp.next);
  for (let i = 0; i < 3; i++) {
    const u = new URL(target, "http://x");
    const inner = u.searchParams.get("liff.state") ?? (u.pathname === "/login" ? u.searchParams.get("next") : null);
    if (!inner) break;
    target = safePath(inner);
  }
  return target.startsWith("/login") ? "/" : target;
}

// Server pages: an active user holding one of `roles` (any role when omitted),
// else redirect to login / registration / home.
export async function requirePage(roles?: Role[]): Promise<User> {
  const u = await currentUser();
  if (!u) redirect(`/login?next=${encodeURIComponent(safePath((await headers()).get("x-path")))}`);
  if (u.status === "pending" || !u.roles.length) redirect("/register");
  if (u.status !== "active") redirect("/login?disabled=1");
  if (roles && !roles.some((r) => u.roles.includes(r))) redirect("/?denied=1");
  return u;
}

// Route handlers: `const a = await apiUser(["office"]); if ("res" in a) return a.res;`
export async function apiUser(roles?: Role[]): Promise<{ user: User } | { res: NextResponse }> {
  const u = await currentUser();
  if (!u || u.status !== "active") return { res: NextResponse.json({ error: "กรุณาเข้าสู่ระบบใหม่" }, { status: 401 }) };
  if (roles && !roles.some((r) => u.roles.includes(r))) return { res: NextResponse.json({ error: "ไม่มีสิทธิ์ทำรายการนี้" }, { status: 403 }) };
  return { user: u };
}
