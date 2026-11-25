import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { prisma } from "./db";
import { foreignOrigin, weakSecret } from "./http";
import type { Role } from "./roles";

// Session = signed cookie { u: user id, e: expiry in unix seconds, i: issue time in ms }. The user row is re-read on
// every request, so disabling someone or changing their roles applies at once. A cookie made before the user's
// sessionsAfter (set when Office disables or re-enables them) stays refused, so re-enabling brings no old session back.
// In production the name has the __Host- prefix: the browser then takes this cookie only from this host (Secure,
// Path=/, no Domain), so a page on a sibling subdomain (same site, *.phuketnukyok.com) cannot plant a session of its
// own in a visitor's browser (login CSRF by cookie tossing). Plain-http dev keeps the old name. The old name is not
// read in production: everyone signs in once more after this change (inside LINE, /liff does it without a click).
const SECURE = process.env.NODE_ENV === "production";
const COOKIE = SECURE ? "__Host-nk_session" : "nk_session";
const MAX_AGE = 30 * 24 * 3600;

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16 || weakSecret(s)) throw new Error("SESSION_SECRET must be a long random string (16+ characters; in production no placeholder and no dev- value)");
  return s;
}
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest("base64url");

// The user id and when the cookie was made (ms): i, or e - MAX_AGE for a cookie made before i existed (whole seconds:
// such a cookie made in the same second as a later sessionsAfter counts as older, and that person signs in again).
function readToken(token: string | undefined): { id: string; at: number } | null {
  const [data, sig] = (token ?? "").split(".");
  if (!data || !sig) return null;
  const a = Buffer.from(sig), b = Buffer.from(sign(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
    if (typeof p.u !== "string" || typeof p.e !== "number" || p.e <= Date.now() / 1000) return null;
    return { id: p.u, at: typeof p.i === "number" ? p.i : (p.e - MAX_AGE) * 1000 };
  } catch {
    return null;
  }
}

export async function setSession(userId: string) {
  // i in ms: sessionsAfter is stored in ms, so a sign-in in the same second after a re-enable must not count as older
  const now = Date.now();
  const data = Buffer.from(JSON.stringify({ u: userId, e: Math.floor(now / 1000) + MAX_AGE, i: now })).toString("base64url");
  (await cookies()).set(COOKIE, `${data}.${sign(data)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: SECURE,
    path: "/",
    maxAge: MAX_AGE,
  });
}

// With the same attributes: a browser ignores a __Host- cookie without Secure, also the one that deletes it.
export async function clearSession() {
  (await cookies()).delete({ name: COOKIE, httpOnly: true, sameSite: "lax", secure: SECURE, path: "/" });
}

// The signed-in user, whatever their status (null = not signed in, or signed in before sessionsAfter).
export async function currentUser(): Promise<User | null> {
  const t = readToken((await cookies()).get(COOKIE)?.value);
  const u = t ? await prisma.user.findUnique({ where: { id: t.id } }) : null;
  return u && t && !(u.sessionsAfter && t.at < u.sessionsAfter.getTime()) ? u : null;
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

// Where /liff/<path> goes. LINE sends the page in ?liff.state; the LIFF SDK may then load /liff/<path>?<query>
// itself (before sign-in, too): keep that page's own query (?vehicle=..&pm=1), not what LIFF and LINE Login add.
const LINE_PARAMS = ["code", "state", "error", "error_description", "friendship_status_changed"];
export function liffTarget(path: string[], sp: Record<string, string | string[] | undefined>): string {
  const state = sp["liff.state"];
  if (typeof state === "string" && state) return loginTarget({ "liff.state": state });
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (!/^liff/i.test(k) && !LINE_PARAMS.includes(k)) for (const x of [v ?? []].flat()) q.append(k, x);
  const qs = q.toString();
  return loginTarget({ next: `/${path.map(encodeURIComponent).join("/")}${qs ? `?${qs}` : ""}` });
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
// Refuses a request another site's page made: a page on a sibling subdomain gets our SameSite=Lax cookie and can
// post a plain form. Bearer routes (office PC, cron, เลขา AI, LINE webhook) do not come through here.
export async function apiUser(roles?: Role[]): Promise<{ user: User } | { res: NextResponse }> {
  if (foreignOrigin(await headers())) return { res: NextResponse.json({ error: "ระบบไม่รับคำขอที่ส่งมาจากเว็บอื่น" }, { status: 403 }) };
  const u = await currentUser();
  if (!u || u.status !== "active") return { res: NextResponse.json({ error: "กรุณาเข้าสู่ระบบใหม่" }, { status: 401 }) };
  if (roles && !roles.some((r) => u.roles.includes(r))) return { res: NextResponse.json({ error: "ไม่มีสิทธิ์ทำรายการนี้" }, { status: 403 }) };
  return { user: u };
}
