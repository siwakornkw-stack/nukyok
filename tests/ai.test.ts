import { describe, expect, it } from "vitest";
import { filterError } from "@/lib/ai";
import { GET } from "@/app/api/ai/openapi.json/route";

const req = (qs: string) => new Request(`http://localhost/api/ai/fuel?${qs}`);
const FUEL = { no: "no", status: ["waiting", "filled"], vehicle: null, from: "date", to: "date", flagged: ["1"], limit: null } as const;

describe("filterError (เลขา AI list filters)", () => {
  it("passes filters that are valid, not sent, or sent empty", () => {
    expect(filterError(req(""), FUEL)).toBe("");
    expect(filterError(req("no=%2312&status=filled&vehicle=SY140-01&from=2026-11-01&to=2026-11-30&flagged=1&limit=5"), FUEL)).toBe("");
    expect(filterError(req("status=&date="), FUEL)).toBe("");
  });
  it("refuses a value it would otherwise drop, naming it and what is allowed", () => {
    expect(filterError(req("from=2026-11-1"), FUEL)).toMatch(/^from ไม่ถูกต้อง: "2026-11-1" ต้องเป็นวันที่ที่มีจริง แบบ YYYY-MM-DD ปี ค\.ศ\. \(วันนี้คือ 20\d\d-\d\d-\d\d\)$/);
    expect(filterError(req("from=2026-11-01&to=2026-11-31"), FUEL)).toMatch(/^to ไม่ถูกต้อง: "2026-11-31"/);
    expect(filterError(req("from=2569-11-01"), FUEL)).toMatch(/^from ไม่ถูกต้อง/);
    expect(filterError(req("status=pending"), FUEL)).toBe('status ไม่ถูกต้อง: "pending" ใช้ได้ waiting, filled');
    expect(filterError(req("no=abc"), FUEL)).toBe('no ไม่ถูกต้อง: "abc" ต้องเป็นเลขรายการ เช่น 12');
    expect(filterError(req("no=0"), FUEL)).toMatch(/^no ไม่ถูกต้อง/);
    expect(filterError(req("flagged=true"), FUEL)).toBe('flagged ไม่ถูกต้อง: "true" ใช้ได้ 1');
  });
  it("refuses a name the endpoint does not take, and a name sent twice", () => {
    expect(filterError(req("date=2026-11-24"), FUEL)).toBe("ไม่รู้จักตัวกรอง date: ใช้ได้ no, status, vehicle, from, to, flagged, limit");
    expect(filterError(req("vehicle_code=SY140-01"), FUEL)).toMatch(/^ไม่รู้จักตัวกรอง vehicle_code:/);
    expect(filterError(req("constructor=1"), FUEL)).toMatch(/^ไม่รู้จักตัวกรอง constructor:/);
    expect(filterError(new Request("http://localhost/api/ai/vehicles?vehicle=SY140-01"), { code: null })).toBe("ไม่รู้จักตัวกรอง vehicle: ใช้ได้ code");
    expect(filterError(req("status=filled&status=approved"), FUEL)).toBe("status ส่งได้ค่าเดียว");
    expect(filterError(req("status=&status=filled"), FUEL)).toBe("status ส่งได้ค่าเดียว");
  });
});

type Op = {
  summary: string;
  description: string;
  parameters?: { name: string; description: string }[];
  requestBody?: { content: Record<string, { schema: { properties: Record<string, { description: string }> } }> };
};

// https://developers.openai.com/api/docs/actions/production: an action whose spec is over these is not accepted.
describe("OpenAPI of the เลขา AI (GPT Actions limits)", () => {
  it("keeps summaries and descriptions to 300 characters and parameter or property descriptions to 700", async () => {
    const spec = (await GET().json()) as { paths: Record<string, Record<string, Op>> };
    const over: string[] = [];
    const check = (where: string, text: string, max: number) => {
      expect(typeof text, where).toBe("string");
      if (text.length > max) over.push(`${where}: ${text.length} > ${max}`);
    };
    let ops = 0;
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, o] of Object.entries(methods)) {
        ops++;
        check(`${method} ${path} summary`, o.summary, 300);
        check(`${method} ${path} description`, o.description, 300);
        for (const p of o.parameters ?? []) check(`${method} ${path} ?${p.name}`, p.description, 700);
        for (const [k, v] of Object.entries(o.requestBody?.content["application/json"].schema.properties ?? {})) check(`${method} ${path} ${k}`, v.description, 700);
      }
    }
    expect(ops).toBeGreaterThan(10);
    expect(over).toEqual([]);
  });

  it("says POST bodies are JSON only, documents the fuel approval amount (C9) and each fuel row's invoiceDate", async () => {
    type Res = Record<string, { description: string; content?: { "application/json": { schema: { properties: Record<string, Record<string, unknown>> } } } }>;
    type Ops = Record<string, Record<string, Op & { responses: Res }>>;
    const spec = (await GET().json()) as { info: { description: string }; paths: Ops };
    expect(spec.info.description).toContain("Content-Type: application/json");
    const props = (r: Res[string]) => r.content?.["application/json"].schema.properties ?? {};

    const review = spec.paths["/api/ai/fuel/review"].post;
    expect(Object.keys(review.requestBody?.content["application/json"].schema.properties ?? {})).toContain("amount");
    expect(review.responses["409"].description).toMatch(/amount/);
    expect(Object.keys(props(review.responses["200"]))).toEqual(expect.arrayContaining(["express", "notice"]));
    expect(review.description).toContain("notice");

    const row = props(spec.paths["/api/ai/fuel"].get.responses["200"]).fuel as { items: { properties: Record<string, { format?: string }> } };
    expect(row.items.properties.invoiceDate.format).toBe("date");
  });
});
