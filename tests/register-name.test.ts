import { describe, expect, it } from "vitest";
import { nameOk } from "@/app/api/auth/register/name";

describe("nameOk (registration name, posted to the Office group)", () => {
  it("takes Thai and Latin names with titles and nicknames", () => {
    for (const n of ["สมชาย ใจดี", "น.ส. สมศรี มีสุข", "น.ส.สมศรี มีสุข", "นางสาวพิมพ์ใจ ศรีสุข (ต้น)", "John O'Neil", "Mr. John Smith", "ณัฐวุฒิ์ ฯ"]) expect(nameOk(n), n).toBe(true);
  });
  it("refuses links, digits and other text a bot post would spread", () => {
    for (const n of ["https://evil.example", "verify at line.me", "lin.ee/abc", "abc.COM", "โทร 0812345678", "a", "x".repeat(61), "ชื่อ\nลิงก์"]) expect(nameOk(n), n).toBe(false);
  });
  it("refuses a dot right before a Latin letter, as in a link: the message asks for a space (Mr. John)", () => {
    for (const n of ["Mr.John Smith", "J.Smith", "(Mr.A)"]) expect(nameOk(n), n).toBe(false);
  });
});
