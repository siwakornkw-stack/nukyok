import { describe, expect, it } from "vitest";
import { csv } from "@/lib/csv";

describe("csv", () => {
  it("joins plain fields with commas and ends every line with CRLF", () => {
    expect(csv([["รถ", 1, null, undefined], ["SY140-01", 1004.67, "", "x"]])).toBe("รถ,1,,\r\nSY140-01,1004.67,,x\r\n");
  });

  it("quotes fields with a comma, quote or line break and doubles the quotes", () => {
    expect(csv([["7.1,98.3", 'ยาง "แตก"', "บรรทัด1\nบรรทัด2", "a\rb"]])).toBe('"7.1,98.3","ยาง ""แตก""","บรรทัด1\nบรรทัด2","a\rb"\r\n');
  });

  it("returns an empty string for no rows", () => {
    expect(csv([])).toBe("");
  });
});
