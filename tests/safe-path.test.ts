import { describe, expect, it } from "vitest";
import { loginTarget, safePath } from "@/lib/session";

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
