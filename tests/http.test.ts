import { afterEach, describe, expect, it, vi } from "vitest";
import { bearerOk, crossSite, foreignOrigin, jsonBody, weakSecret } from "@/lib/http";
import { GET as health } from "@/app/api/health/route";

// /api/health reads every table; here none holds a row.
vi.mock("@/lib/db", () => {
  const none = { findUnique: async () => null };
  return { prisma: { user: none, vehicle: none, attendance: none, fuelRequest: none, repairRequest: none, expressOrder: none, appSetting: none } };
});

const h = (x: Record<string, string>) => new Headers(x);

describe("foreignOrigin / crossSite (requests another site's page made)", () => {
  it("lets this site's pages and non-browser callers through", () => {
    expect(crossSite(h({ host: "nukyok.phuketnukyok.com", origin: "https://nukyok.phuketnukyok.com", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(crossSite(h({ host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(false);
    // the office PC, cron, a script: no Origin, no Sec-Fetch-Site
    expect(crossSite(h({ host: "127.0.0.1:3004" }))).toBe(false);
    // a link from LINE chat opens with Sec-Fetch-Site none
    expect(crossSite(h({ host: "nukyok.phuketnukyok.com", "sec-fetch-site": "none" }))).toBe(false);
  });
  it("refuses other origins, sibling subdomains included, and hidden ones", () => {
    expect(foreignOrigin(h({ host: "nukyok.phuketnukyok.com", origin: "https://evil.phuketnukyok.com" }))).toBe(true);
    expect(foreignOrigin(h({ host: "nukyok.phuketnukyok.com", origin: "https://evil.example" }))).toBe(true);
    expect(foreignOrigin(h({ host: "nukyok.phuketnukyok.com", origin: "null" }))).toBe(true);
    expect(foreignOrigin(h({ host: "localhost:3000", origin: "http://localhost:3001" }))).toBe(true);
    expect(crossSite(h({ host: "nukyok.phuketnukyok.com", "sec-fetch-site": "cross-site" }))).toBe(true);
  });
  it("leaves a link from another site (GET, no Origin) to foreignOrigin alone", () => {
    expect(foreignOrigin(h({ host: "nukyok.phuketnukyok.com", "sec-fetch-site": "cross-site" }))).toBe(false);
  });
});

describe("jsonBody (JSON content type only)", () => {
  const req = (type: string | null, body: string) => new Request("http://x/api", { method: "POST", headers: type ? { "content-type": type } : {}, body });
  it("reads application/json", async () => {
    expect(await jsonBody(req("application/json", '{"a":1}'))).toEqual({ a: 1 });
    expect(await jsonBody(req("application/json; charset=utf-8", '{"a":1}'))).toEqual({ a: 1 });
  });
  it("ignores what a plain cross-site form can send", async () => {
    expect(await jsonBody(req("text/plain", '{"a":1}'))).toEqual({});
    expect(await jsonBody(req("application/x-www-form-urlencoded", '{"a":1}'))).toEqual({});
    expect(await jsonBody(req(null, '{"a":1}'))).toEqual({});
    expect(await jsonBody(req("application/jsonx", '{"a":1}'))).toEqual({});
  });
});

describe("weakSecret / bearerOk (placeholder secrets in production)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  const call = (secret: string) => new Request("http://x/api/cron/tick", { headers: { authorization: `Bearer ${secret}` } });
  it("keeps the dev values working outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(weakSecret("dev-cron")).toBe(false);
    expect(weakSecret("dev-express-sync-secret")).toBe(false);
    expect(bearerOk(call("dev-cron"), "dev-cron")).toBe(true);
    expect(bearerOk(call("dev-express-sync-secret"), "dev-express-sync-secret")).toBe(true);
  });
  it("refuses short or placeholder secrets in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(weakSecret("dev-cron")).toBe(true);
    expect(weakSecret("change-me")).toBe(true);
    expect(weakSecret("change-me-to-a-long-random-string")).toBe(true);
    expect(weakSecret("Change-Me-Before-Going-Live")).toBe(true);
    expect(weakSecret("q8Vh2kLm9Zr4Tx7Bn3Wc")).toBe(false);
    expect(bearerOk(call("change-me"), "change-me")).toBe(false);
    expect(bearerOk(call("q8Vh2kLm9Zr4Tx7Bn3Wc"), "q8Vh2kLm9Zr4Tx7Bn3Wc")).toBe(true);
    expect(bearerOk(call("wrong-but-long-enough"), "q8Vh2kLm9Zr4Tx7Bn3Wc")).toBe(false);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).not.toContain("change-me");
  });
  it("refuses dev / e2e values (starting with dev-) of any length in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(weakSecret("dev-express-sync-secret")).toBe(true);
    expect(weakSecret("DEV-SESSION-SECRET-1234")).toBe(true);
    expect(bearerOk(call("dev-express-sync-secret"), "dev-express-sync-secret")).toBe(false);
    // only the prefix counts: "dev-" inside a random value is fine
    expect(weakSecret("q8Vh2kLmdev-Zr4Tx7Bn3Wc")).toBe(false);
  });
});

describe("/api/health (deploy.sh rolls back unless it answers 200)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const env = (o: Record<string, string> = {}) => {
    const strong = { SESSION_SECRET: "q8Vh2kLm9Zr4Tx7Bn3Wc-session", CRON_SECRET: "q8Vh2kLm9Zr4Tx7Bn3Wc-cron", EXPRESS_SYNC_SECRET: "q8Vh2kLm9Zr4Tx7Bn3Wc-sync", EXPORT_SECRET: "" };
    for (const [k, v] of Object.entries({ ...strong, ...o })) vi.stubEnv(k, v);
  };
  const failure = () => health().then(() => "", (e: Error) => e.message);

  it("answers ok in production with strong secrets; EXPORT_SECRET is optional (unset or weak = export off)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    env();
    expect(await (await health()).json()).toEqual({ ok: true });
    env({ EXPORT_SECRET: "dev-export" });
    expect((await health()).status).toBe(200);
  });

  it("fails in production on an unset or weak CRON_SECRET / EXPRESS_SYNC_SECRET, naming the variable, never the value", async () => {
    vi.stubEnv("NODE_ENV", "production");
    for (const [k, v] of [["CRON_SECRET", ""], ["CRON_SECRET", "dev-cron"], ["EXPRESS_SYNC_SECRET", "change-me-to-a-long-random-string"], ["EXPRESS_SYNC_SECRET", "short"]]) {
      env({ [k]: v });
      const msg = await failure();
      expect(msg, `${k}=${v}`).toMatch(new RegExp(`^${k} is unset or refused`));
      if (v) expect(msg).not.toContain(v);
    }
    env({ SESSION_SECRET: "dev-session-secret-1234" });
    expect(await failure()).toMatch(/^SESSION_SECRET /);
  });

  it("leaves the Bearer secrets alone outside production (dev values, or none)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    env({ CRON_SECRET: "dev-cron", EXPRESS_SYNC_SECRET: "" });
    expect((await health()).status).toBe(200);
  });
});
