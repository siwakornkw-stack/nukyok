import { createHmac } from "crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { currentUser, setSession } from "@/lib/session";

// One browser's cookie jar and the one user row currentUser reads.
const mem = vi.hoisted(() => ({ jar: new Map<string, string>(), user: { id: "u1", status: "active", roles: ["office"], sessionsAfter: null as Date | null } }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (mem.jar.has(name) ? { name, value: mem.jar.get(name) } : undefined),
    set: (name: string, value: string) => void mem.jar.set(name, value),
    delete: ({ name }: { name: string }) => void mem.jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: async ({ where }: { where: { id: string } }) => (where.id === mem.user.id ? mem.user : null) } } }));

const SECRET = "q8Vh2kLm9Zr4Tx7Bn3Wc-session";
const MAX_AGE = 30 * 24 * 3600;
const COOKIE = "nk_session"; // outside production
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const payload = () => JSON.parse(Buffer.from(mem.jar.get(COOKIE)!.split(".")[0], "base64url").toString("utf8"));
// a cookie as setSession made it before the issue time (i) was added
const oldCookie = (data: object) => {
  const d = Buffer.from(JSON.stringify(data)).toString("base64url");
  return `${d}.${createHmac("sha256", SECRET).update(d).digest("base64url")}`;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.stubEnv("SESSION_SECRET", SECRET);
  mem.jar.clear();
  mem.user.sessionsAfter = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("session cookie vs User.sessionsAfter (disable / re-enable)", () => {
  it("keeps a sign-in made in the same second after a re-enable: the cookie carries its issue time in ms", async () => {
    at("2026-11-24T03:00:00.700Z");
    mem.user.sessionsAfter = new Date(); // re-enabled
    at("2026-11-24T03:00:00.900Z");
    await setSession("u1");
    expect(payload()).toEqual({ u: "u1", e: Date.parse("2026-11-24T03:00:00Z") / 1000 + MAX_AGE, i: Date.parse("2026-11-24T03:00:00.900Z") });
    expect((await currentUser())?.id).toBe("u1");
  });

  it("refuses a cookie made before a disable or re-enable, also within the same second", async () => {
    at("2026-11-24T03:00:00.500Z");
    await setSession("u1");
    expect((await currentUser())?.id).toBe("u1");
    at("2026-11-24T03:00:00.700Z");
    mem.user.sessionsAfter = new Date();
    expect(await currentUser()).toBeNull();
  });

  it("reads a cookie made before i existed as made at e - MAX_AGE (whole seconds)", async () => {
    mem.jar.set(COOKIE, oldCookie({ u: "u1", e: Date.parse("2026-11-24T03:00:00Z") / 1000 + MAX_AGE }));
    at("2026-11-25T03:00:00.000Z");
    mem.user.sessionsAfter = new Date("2026-11-24T02:59:59.999Z");
    expect((await currentUser())?.id).toBe("u1");
    mem.user.sessionsAfter = new Date("2026-11-24T03:00:00.001Z");
    expect(await currentUser()).toBeNull();
  });

  it("still refuses an expired cookie and one whose signature does not match", async () => {
    at("2026-11-24T03:00:00.000Z");
    await setSession("u1");
    const made = mem.jar.get(COOKIE)!;
    at("2026-12-24T03:00:00.000Z"); // MAX_AGE later
    expect(await currentUser()).toBeNull();
    at("2026-11-24T04:00:00.000Z");
    expect((await currentUser())?.id).toBe("u1");
    const forged = Buffer.from(JSON.stringify({ ...payload(), i: Date.parse("2026-11-25T00:00:00Z") })).toString("base64url");
    mem.jar.set(COOKIE, `${forged}.${made.split(".")[1]}`);
    mem.user.sessionsAfter = new Date("2026-11-24T03:30:00Z");
    expect(await currentUser()).toBeNull();
  });
});
