import { describe, expect, it } from "vitest";
import { readUserAudit } from "@/app/api/users/log";

describe("readUserAudit (who approved / disabled / changed roles, shown on /office/users)", () => {
  it("keeps well-formed entries in order and drops anything else", () => {
    const ok = { at: "2026-11-24T03:00:00.000Z", by: "สมศรี Office", text: "อนุมัติผู้ใช้ ผู้สมัคร ใหม่ บทบาท คนขับ" };
    expect(readUserAudit([ok, null, "x", { at: "x", by: "a", text: "b" }, { at: ok.at, by: 1, text: "b" }, { ...ok, text: "ปิดการใช้งาน ผู้สมัคร ใหม่" }])).toEqual([
      ok,
      { ...ok, text: "ปิดการใช้งาน ผู้สมัคร ใหม่" },
    ]);
    expect(readUserAudit(undefined)).toEqual([]);
    expect(readUserAudit({ at: ok.at })).toEqual([]);
  });
});
