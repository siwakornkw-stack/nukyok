import { describe, expect, it } from "vitest";
import { liffTarget, loginTarget, safePath } from "@/lib/session";

describe("liffTarget (where /liff goes after the LIFF sign-in)", () => {
  it("keeps the page's own query when the LIFF SDK loads /liff/<path>?<query>", () => {
    // the service-due link: the repair must keep its vehicle and service mark after signing in again
    expect(liffTarget(["driver", "repair"], { vehicle: "abc", pm: "1" })).toBe("/driver/repair?vehicle=abc&pm=1");
    expect(liffTarget(["driver", "repair"], { vehicle: "abc", pm: "1", code: "x", state: "y", liffClientId: "1", liffRedirectUri: "u", "liff.referrer": "r" })).toBe(
      "/driver/repair?vehicle=abc&pm=1"
    );
    expect(liffTarget(["office", "fuel"], { tab: ["a", "b"] })).toBe("/office/fuel?tab=a&tab=b");
    expect(liffTarget(["office users"], {})).toBe("/office%20users");
    expect(liffTarget([], { code: "x", state: "y" })).toBe("/");
  });
  it("takes liff.state first, and never goes to /login or off-site", () => {
    expect(liffTarget([], { "liff.state": "/driver/repair?vehicle=abc&pm=1" })).toBe("/driver/repair?vehicle=abc&pm=1");
    expect(liffTarget(["driver"], { "liff.state": "", vehicle: "abc" })).toBe("/driver?vehicle=abc");
    expect(liffTarget(["login"], {})).toBe("/");
    expect(liffTarget(["login"], { next: "/driver/my" })).toBe("/driver/my");
    expect(liffTarget([], { "liff.state": "//evil.example" })).toBe("/");
    expect(liffTarget(["", "evil.example"], {})).toBe("/");
  });
});

describe("loginTarget (where /login goes afterwards)", () => {
  it("follows LIFF paths and nested logins, never back to /login or off-site", () => {
    expect(loginTarget({ "liff.state": "/driver/fuel" })).toBe("/driver/fuel");
    expect(loginTarget({ "liff.state": "/login?next=%2F" })).toBe("/");
    expect(loginTarget({ next: "/?liff.state=%2Ffiller%2Fabc" })).toBe("/filler/abc");
    expect(loginTarget({ next: "/office/fuel?tab=review" })).toBe("/office/fuel?tab=review");
    expect(loginTarget({ next: "/login?next=%2Fdriver%2Fmy" })).toBe("/driver/my");
    expect(loginTarget({ "liff.state": "//evil.example" })).toBe("/");
    expect(loginTarget({ next: "/?liff.state=%2F%2Fevil.example" })).toBe("/");
    expect(loginTarget({})).toBe("/");
  });
});

describe("safePath (redirect targets)", () => {
  it("keeps paths on this site", () => {
    expect(safePath("/driver/fuel")).toBe("/driver/fuel");
    expect(safePath("/office/fuel/abc?tab=review")).toBe("/office/fuel/abc?tab=review");
    expect(safePath("/")).toBe("/");
  });
  it("refuses anything that a browser would send elsewhere", () => {
    for (const p of ["//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "https://evil.example", "evil", "", null, { a: 1 }])
      expect(safePath(p)).toBe("/");
  });
});
