import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csv, exportToken } from "@/lib/csv";
import { GET as exportGet } from "@/app/api/export/[kind]/route";
import Home from "@/app/(app)/page";

// What the vehicles export and the home page read: vehicles, the Express masters (AppSetting) and the signed-in user.
const mem = vi.hoisted(() => ({ vehicles: [] as Record<string, unknown>[], masters: null as unknown, roles: ["office"] }));
vi.mock("@/lib/db", () => ({
  prisma: {
    vehicle: { findMany: async () => mem.vehicles },
    $queryRaw: async () => [], // latestHours: no fills
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (where.key === "express_masters" && mem.masters ? { key: where.key, value: mem.masters } : null),
      findMany: async () => [],
    },
  },
}));
vi.mock("@/lib/line", () => ({ appLink: (p: string) => p, notifyOfficeGroup: async () => true }));
vi.mock("@/lib/session", () => ({ requirePage: async () => ({ id: "u1", name: "สมศรี Office", displayName: "สมศรี", roles: mem.roles }) }));

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

  it("puts a ' before text a spreadsheet would run as a formula and leaves numbers as numbers", () => {
    expect(csv([["=1+1", "+66 81", "- เปลี่ยนยาง", "@SUM(A1)", "\tx", -5, -0.25, "a=b", "ยาง -2 เส้น"]])).toBe(
      "'=1+1,'+66 81,'- เปลี่ยนยาง,'@SUM(A1),'\tx,-5,-0.25,a=b,ยาง -2 เส้น\r\n"
    );
  });

  it("still quotes a neutralised field holding a quote or line break", () => {
    expect(csv([['=HYPERLINK("http://x/?"&A1,"ดู")', "\r=1+1"]])).toBe('"\'=HYPERLINK(""http://x/?""&A1,""ดู"")","\'\r=1+1"\r\n');
  });
});

describe("exportToken", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("is the first 32 hex characters of HMAC-SHA256(EXPORT_SECRET, kind), a different one per kind", () => {
    vi.stubEnv("EXPORT_SECRET", "dev-export");
    expect(exportToken("fuel")).toBe("0dcecae9185eecd81d0817dc2267585a");
    expect(exportToken("attendance")).toBe("c6dfc18ba4d1a424033bf4dcb8b23dca");
    expect(new Set(["fuel", "repairs", "attendance", "vehicles"].map(exportToken)).size).toBe(4);
    vi.stubEnv("EXPORT_SECRET", "another-secret");
    expect(exportToken("fuel")).not.toBe("0dcecae9185eecd81d0817dc2267585a");
  });

  it("is empty while EXPORT_SECRET is empty, so the export stays off", () => {
    vi.stubEnv("EXPORT_SECRET", "");
    expect(exportToken("fuel")).toBe("");
  });

  it("never uses the old EXPORT_TOKEN, which every older sheet formula showed", () => {
    vi.stubEnv("EXPORT_SECRET", "");
    vi.stubEnv("EXPORT_TOKEN", "dev-export");
    expect(exportToken("attendance")).toBe("");
  });

  it("is empty in production while EXPORT_SECRET is weak (short, a placeholder or a dev- value), so the export stays off", () => {
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const weak of ["dev-export", "dev-export-secret-long-enough", "change-me-to-a-long-random-string", "short"]) {
      vi.stubEnv("EXPORT_SECRET", weak);
      expect(exportToken("fuel"), weak).toBe("");
    }
    expect(log).toHaveBeenCalledTimes(4);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/dev-export|change-me-to/);
  });

  it("gives a strong EXPORT_SECRET the same tokens in production as outside it", () => {
    vi.stubEnv("EXPORT_SECRET", "q8Vh2kLm9Zr4Tx7Bn3Wc");
    vi.stubEnv("NODE_ENV", "development");
    const dev = exportToken("repairs");
    vi.stubEnv("NODE_ENV", "production");
    expect(exportToken("repairs")).toMatch(/^[0-9a-f]{32}$/);
    expect(exportToken("repairs")).toBe(dev);
  });
});

describe("vehicles export: Express แผนก", () => {
  beforeEach(() => vi.stubEnv("EXPORT_SECRET", "q8Vh2kLm9Zr4Tx7Bn3Wc-export"));
  afterEach(() => vi.unstubAllEnvs());
  const vehicle = (code: string, expressItem: string, expressDep: string) => ({
    id: code, code, model: "", litersPerHour: null, tankLiters: null, pmEveryHours: null, pmLastHours: null, expressItem, expressDep, active: true, note: "",
  });
  // the "Express แผนก" column of each row, by vehicle code
  const departments = async () => {
    const res = await exportGet(new Request(`http://x/api/export/vehicles?token=${exportToken("vehicles")}`), { params: Promise.resolve({ kind: "vehicles" }) });
    const [head, ...rows] = (await res.text()).trimEnd().split("\r\n").map((l) => l.split(","));
    const col = head.indexOf("Express แผนก");
    return Object.fromEntries(rows.map((r) => [r[0], r[col]]));
  };

  it("prints the department bills are booked to: the typed one, else the fuel item's own, marked as on the vehicle card", async () => {
    mem.masters = {
      fuel: { suppliers: [], items: [{ code: "140 SY", desc: "น้ำมัน SY140", depCode: "03", depName: "ขนส่ง", stock: false, vatClaim: true }], writer: true },
      repair: { suppliers: [], items: [], writer: true },
      at: new Date().toISOString(),
    };
    mem.vehicles = [vehicle("SY140-01", "140 SY", ""), vehicle("SY140-02", "140 SY", "07"), vehicle("VAN-01", "GONE", ""), vehicle("CAR-01", "", "")];
    expect(await departments()).toEqual({ "SY140-01": "03 (ตามรหัสน้ำมัน)", "SY140-02": "07", "VAN-01": "", "CAR-01": "" });
    mem.masters = null; // no masters from the office PC yet
    expect(await departments()).toEqual({ "SY140-01": "", "SY140-02": "07", "VAN-01": "", "CAR-01": "" });
  });
});

describe("Office home page: Google Sheets formulas", () => {
  beforeEach(() => {
    mem.roles = ["office"];
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  // every text the page puts on screen (the element tree as returned, not rendered)
  const text = (n: unknown): string =>
    typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(text).join(" ") : n && typeof n === "object" && "props" in n ? text((n as { props: { children?: unknown } }).props.children) : "";
  const page = async () => text(await Home({ searchParams: Promise.resolve({}) }));

  it("shows one formula per kind, each with its own token", async () => {
    vi.stubEnv("EXPORT_SECRET", "q8Vh2kLm9Zr4Tx7Bn3Wc-export");
    vi.stubEnv("NODE_ENV", "production");
    const t = await page();
    for (const kind of ["fuel", "repairs", "attendance", "vehicles"]) expect(t).toContain(`/api/export/${kind}?token=${exportToken(kind)}")`);
    expect(t).not.toContain("ปิดการ export");
  });

  it("shows a notice instead of formulas ending in token= while a production EXPORT_SECRET is refused", async () => {
    vi.stubEnv("EXPORT_SECRET", "dev-export");
    vi.stubEnv("NODE_ENV", "production");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = await page();
    expect(t).not.toContain("IMPORTDATA");
    expect(t).toContain("ปิดการ export ไป Google Sheets อยู่");
    expect(log).toHaveBeenCalledTimes(1); // one kind asked, not four
  });

  it("shows neither while EXPORT_SECRET is unset, nor to anyone but Office", async () => {
    vi.stubEnv("EXPORT_SECRET", "");
    expect(await page()).not.toMatch(/IMPORTDATA|ปิดการ export/);
    vi.stubEnv("EXPORT_SECRET", "q8Vh2kLm9Zr4Tx7Bn3Wc-export");
    mem.roles = ["driver"];
    expect(await page()).not.toMatch(/IMPORTDATA|ปิดการ export/);
  });
});
