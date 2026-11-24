import "server-only";
import { createHash, randomBytes } from "crypto";
import { NextResponse } from "next/server";
import type { User } from "@prisma/client";
import { prisma } from "./db";
import { ROLES, type Role } from "./roles";

// เลขา AI: each user can make one API key (/ai). The secretary sends it as "Authorization: Bearer nk_..."
// and acts as that user with that user's roles, so it can do exactly what the person can do in the app.
// Only the sha256 is stored; disabling the user or making a new key stops the old one at once.
export const hashAiKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const newAiKey = () => `nk_${randomBytes(32).toString("base64url")}`;

// `const a = await aiUser(req, ["exec"]); if ("res" in a) return a.res;`
export async function aiUser(req: Request, roles?: Role[]): Promise<{ user: User } | { res: NextResponse }> {
  const m = /^Bearer (nk_[A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") ?? "");
  const u = m ? await prisma.user.findUnique({ where: { aiKeyHash: hashAiKey(m[1]) } }) : null;
  if (!u || u.status !== "active") return { res: NextResponse.json({ error: "รหัสเลขา AI ไม่ถูกต้อง หรือถูกยกเลิกแล้ว" }, { status: 401 }) };
  if (roles && !roles.some((r) => u.roles.includes(r))) {
    return { res: NextResponse.json({ error: `ไม่มีสิทธิ์: ต้องเป็น ${roles.map((r) => ROLES[r]).join(" / ")}` }, { status: 403 }) };
  }
  return { user: u };
}

// Who acted, as kept on the record ("decidedBy", "reviewedBy"): the person, marked as done by the secretary.
export const aiActor = (u: User) => ({ id: u.id, name: `${u.name} (เลขา AI)` });

// Query string of a GET: q("from") -> trimmed text, "" when absent.
export const query = (req: Request) => {
  const sp = new URL(req.url).searchParams;
  return (k: string) => (sp.get(k) ?? "").trim().slice(0, 100);
};
export const limitOf = (v: string, max = 200) => Math.min(Math.max(Math.trunc(Number(v)) || 50, 1), max);
// The secretary names vehicles by their code ("SY140-01"), any letter case.
export const vehicleByCode = (code: string) =>
  code ? prisma.vehicle.findFirst({ where: { code: { equals: code, mode: "insensitive" } } }) : Promise.resolve(null);
// "#12" / "12" -> 12
export const docNo = (v: unknown) => {
  const n = Number(String(v ?? "").replace(/^#/, ""));
  return Number.isInteger(n) && n > 0 && n < 2 ** 31 ? n : null;
};
