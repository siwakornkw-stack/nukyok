import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "./db";
import type { Role } from "./roles";

// LINE Messaging API over plain fetch. Without credentials (local dev) messages
// are only logged. Sending never throws: a failed notification must not fail the
// request that triggered it.
const API = "https://api.line.me";

// Channel access token: LINE_CHANNEL_ACCESS_TOKEN (long-lived) when set, else a
// stateless 15-minute token issued from LINE_CHANNEL_ID + LINE_CHANNEL_SECRET
// (no issuance limit), kept until a minute before it expires.
let issued: { token: string; until: number } | null = null;
async function accessToken(): Promise<string> {
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) return process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const id = process.env.LINE_CHANNEL_ID, secret = process.env.LINE_CHANNEL_SECRET;
  if (!id || !secret) return "";
  if (issued && issued.until > Date.now()) return issued.token;
  const r = await fetch(`${API}/oauth2/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error(`token ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  issued = { token: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
  return issued.token;
}

// The last failed call, for the Office home page: { at, path, status (0 = no answer), message }.
// The message is LINE's answer (or the error), never a token. Never throws.
async function recordError(path: string, status: number, message: string) {
  const value = { at: new Date().toISOString(), path, status, message: message.slice(0, 200) };
  try {
    await prisma.appSetting.upsert({ where: { key: "line_last_error" }, update: { value }, create: { key: "line_last_error", value } });
  } catch (e) {
    console.error("[line] could not record the error", e);
  }
}

// true when LINE took it (or dry-run).
async function call(path: string, body: unknown): Promise<boolean> {
  let token = "";
  try {
    token = await accessToken();
    if (!token) {
      console.log("[line:dry-run]", path, JSON.stringify(body).slice(0, 800));
      return true;
    }
    const r = await fetch(API + path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const answer = (await r.text().catch(() => "")).slice(0, 300);
      console.error("[line]", path, r.status, answer);
      await recordError(path, r.status, answer);
    }
    return r.ok;
  } catch (e) {
    console.error("[line]", path, e);
    // fetch quotes the whole Authorization header when the token holds a bad character: never store it
    const message = e instanceof Error ? e.message : String(e);
    const t = token.trim();
    await recordError(path, 0, t ? message.replaceAll(t, "***") : message);
    return false;
  }
}

const text = (t: string) => [{ type: "text", text: t.slice(0, 4900) }];

// to: a LINE user id or group id
export const pushText = (to: string, t: string) => call("/v2/bot/message/push", { to, messages: text(t) });

// true only when it reached someone: every batch went out. No recipient is false, so the cron does not count an
// audience without an active user as told.
export async function multicastText(lineUserIds: string[], t: string): Promise<boolean> {
  const ids = [...new Set(lineUserIds.filter(Boolean))];
  let all = true;
  for (let i = 0; i < ids.length; i += 500) if (!(await call("/v2/bot/message/multicast", { to: ids.slice(i, i + 500), messages: text(t) }))) all = false;
  return ids.length > 0 && all;
}

// Every active user holding one of the roles.
export async function notifyRoles(roles: Role[], t: string): Promise<boolean> {
  const users = await prisma.user.findMany({ where: { status: "active", roles: { hasSome: roles } }, select: { lineUserId: true } });
  return multicastText(users.map((u) => u.lineUserId), t);
}

// By our user ids (not LINE ids).
export async function notifyUsers(userIds: string[], t: string): Promise<boolean> {
  const users = await prisma.user.findMany({ where: { id: { in: userIds }, status: "active" }, select: { lineUserId: true } });
  return multicastText(users.map((u) => u.lineUserId), t);
}

// The Office LINE group (LINE_OFFICE_GROUP_ID); without one, every Office user.
export async function notifyOfficeGroup(t: string): Promise<boolean> {
  const g = process.env.LINE_OFFICE_GROUP_ID;
  return g ? pushText(g, t) : notifyRoles(["office"], t);
}

// This month's messages: limit null = no target limit set. null without credentials or when LINE does not answer.
export async function quotaUsage(): Promise<{ limit: number | null; used: number } | null> {
  try {
    const token = await accessToken();
    if (!token) return null;
    const get = async (path: string) => {
      const r = await fetch(API + path, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`${path} ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return r.json();
    };
    const [q, c] = (await Promise.all([get("/v2/bot/message/quota"), get("/v2/bot/message/quota/consumption")])) as [
      { type?: unknown; value?: unknown },
      { totalUsage?: unknown },
    ];
    if (typeof c.totalUsage !== "number") return null;
    return { limit: q.type === "limited" && typeof q.value === "number" ? q.value : null, used: c.totalUsage };
  } catch (e) {
    console.error("[line] quota", e);
    return null;
  }
}

export const replyText = (replyToken: string, t: string) => call("/v2/bot/message/reply", { replyToken, messages: text(t) });

// Rich Menu per role: LINE_RICHMENU_<ROLE> holds a rich menu id made in LINE OA
// Manager / the Messaging API. The first of the user's roles that has one wins.
export async function linkRichMenu(lineUserId: string, roles: string[]) {
  const role = roles.find((r) => process.env[`LINE_RICHMENU_${r.toUpperCase()}`]);
  if (!role) return;
  await call(`/v2/bot/user/${encodeURIComponent(lineUserId)}/richmenu/${process.env[`LINE_RICHMENU_${role.toUpperCase()}`]}`, {});
}

// A link that opens inside LINE (LIFF) when LIFF_ID is set.
export function appLink(path: string) {
  const liff = process.env.LIFF_ID;
  if (liff) return `https://liff.line.me/${liff}${path}`;
  return `${(process.env.APP_URL || "").replace(/\/$/, "")}${path}`;
}

// LIFF ID token -> the LINE user (LINE Login channel id in LINE_LOGIN_CHANNEL_ID).
export async function verifyIdToken(idToken: string): Promise<{ sub: string; name: string } | null> {
  const clientId = process.env.LINE_LOGIN_CHANNEL_ID;
  if (!clientId || !idToken) return null;
  try {
    const r = await fetch(`${API}/oauth2/v2.1/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ id_token: idToken, client_id: clientId }),
    });
    if (!r.ok) return null;
    const p = (await r.json()) as { sub?: unknown; name?: unknown };
    return typeof p.sub === "string" ? { sub: p.sub, name: typeof p.name === "string" ? p.name : "" } : null;
  } catch {
    return null;
  }
}

// Webhook signature (x-line-signature), constant time.
export function signatureOk(raw: string, signature: string | null) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const a = Buffer.from(createHmac("sha256", secret).update(raw).digest("base64"));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
