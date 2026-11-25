import { beforeEach, describe, expect, it, vi } from "vitest";
import { flagCodes, fuelFlags, invoiceDateError, readingText, replacement, vatOnTopOff } from "@/lib/fuel-checks";
import { reviewFuel } from "@/lib/actions";

// For reviewFuel (one purchase on two requests): the fuel requests in memory, each with its Express order (express, a
// relation in the database), as the Prisma calls of reviewFuel use them. LINE messages are collected in sent, raw SQL
// (row locks) in raw; meanwhile runs once before the next write (another person acting).
const mem = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const fills: Row[] = [];
  const sent: string[] = [];
  const raw: { sql: string; values: unknown[] }[] = [];
  const hook = { meanwhile: null as (() => void) | null };
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "AND") return (v as Row[]).every((w) => matches(row, w));
      if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
      const value = row[k] ?? null;
      if (v instanceof Date) return value instanceof Date && value.getTime() === v.getTime();
      if (v === null || typeof v !== "object") return value === v;
      const op = v as Row;
      if ("is" in op) return op.is === null ? value === null : value !== null && matches(value as Row, op.is as Row);
      if ("not" in op) return value !== op.not;
      if ("in" in op) return (op.in as unknown[]).includes(value);
      if ("lt" in op) return value instanceof Date && value < (op.lt as Date);
      if ("gt" in op) return value instanceof Date && value > (op.gt as Date);
      if ("equals" in op) return JSON.stringify(value) === JSON.stringify(op.equals);
      if ("endsWith" in op) return String(value ?? "").toUpperCase().endsWith(String(op.endsWith).toUpperCase());
      if ("string_ends_with" in op) return String((value as Row | null)?.replaces ?? "").endsWith(String(op.string_ends_with));
      throw new Error(`the mock has no filter for ${k}`);
    });
  const fuelRequest = {
    findUnique: async ({ where }: { where: { id: string } }) => {
      const f = fills.find((x) => x.id === where.id);
      return f ? { ...f, express: f.express ? { ...(f.express as Row) } : null } : null;
    },
    findFirst: async ({ where }: { where: Row }) => fills.find((x) => matches(x, where)) ?? null,
    findMany: async ({ where }: { where: Row }) => fills.filter((x) => matches(x, where)),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      hook.meanwhile?.();
      hook.meanwhile = null;
      const hit = fills.filter((x) => matches(x, where));
      for (const x of hit) Object.assign(x, data);
      return { count: hit.length };
    },
  };
  // the order of a fill, by fuelRequestId
  const expressOrder = {
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const { fuelRequestId, ...rest } = where;
      const hit = fills.filter((x) => x.id === fuelRequestId && x.express && matches(x.express as Row, rest));
      for (const x of hit) Object.assign(x.express as Row, data);
      return { count: hit.length };
    },
  };
  const $queryRaw = async (sql: TemplateStringsArray, ...values: unknown[]) => (raw.push({ sql: sql.join("?"), values }), []);
  const db = { fuelRequest, expressOrder, $queryRaw };
  return { fills, sent, raw, hook, prisma: { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) } };
});

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/line", () => ({
  appLink: (path: string) => `https://app${path}`,
  notifyOfficeGroup: async (text: string) => (mem.sent.push(text), true),
  notifyRoles: async (_roles: unknown, text: string) => (mem.sent.push(text), true),
  notifyUsers: async (_users: unknown, text: string) => (mem.sent.push(text), true),
}));
vi.mock("@/lib/express", () => ({ getMasters: async () => null, queueFuelExpress: async () => ({ queued: true }) }));
vi.mock("@/lib/storage", () => ({ removeUpload: async () => {} }));

type Input = Parameters<typeof fuelFlags>[0];

const t0 = new Date("2026-11-01T08:00:00+07:00");
const after = (h: number) => new Date(t0.getTime() + h * 3_600_000);

// A normal day: 24 h after the last fill, +10 engine hours, +100 km, 100 L at 30 baht
// (10 L/h against a standard of 12), the driver clocked 10 h.
const normal: Input = {
  liters: 100,
  pricePerLiter: 30,
  amount: 3000,
  engineHours: 1010,
  odometer: 5100,
  at: after(24),
  vehicle: { litersPerHour: 12, tankLiters: 230 },
  prev: { engineHours: 1000, odometer: 5000, at: t0 },
  workedHours: 10,
  asked: null,
};
const codes = (o: Partial<Input> = {}) => fuelFlags({ ...normal, ...o }).map((f) => f.code);

describe("fuelFlags", () => {
  it("passes a clean fill", () => {
    expect(fuelFlags(normal)).toEqual([]);
  });

  it("flags an amount that does not match litres x price", () => {
    expect(codes({ amount: 3002 })).toEqual(["amount_mismatch"]);
    expect(codes({ amount: 3000.9 })).toEqual([]);
    expect(fuelFlags({ ...normal, amount: 3002 })[0].text).toContain("3,000.00");
  });

  it("flags more litres than the tank holds", () => {
    expect(codes({ liters: 245, amount: 7350, engineHours: 1020, workedHours: 20 })).toEqual(["over_tank"]);
    expect(codes({ liters: 240, amount: 7200, engineHours: 1020, workedHours: 20 })).toEqual([]);
  });

  it("flags engine hours going back or growing faster than the clock", () => {
    expect(codes({ engineHours: 990 })).toEqual(["hours_back"]);
    expect(codes({ engineHours: 1030, workedHours: 30 })).toEqual(["hours_jump"]);
  });

  it("flags the odometer going back or jumping", () => {
    expect(codes({ odometer: 4990 })).toEqual(["odo_back"]);
    expect(codes({ odometer: 5000 + 120 * 24 + 1 })).toEqual(["odo_jump"]);
  });

  it("flags litres per engine hour above the standard", () => {
    const f = fuelFlags({ ...normal, liters: 150, amount: 4500 });
    expect(f.map((x) => x.code)).toEqual(["lph_high"]);
    expect(f[0].text).toBe("ใช้น้ำมัน 15 ลิตร/ชม. เกินมาตรฐาน 12 ลิตร/ชม.");
    expect(codes({ liters: 140, amount: 4200 })).toEqual([]);
  });

  it("flags engine hours above the hours clocked in", () => {
    expect(codes({ workedHours: 5 })).toEqual(["hours_over_work"]);
    expect(codes({ workedHours: 9 })).toEqual([]);
    expect(codes({ workedHours: null })).toEqual([]);
  });

  it("flags litres put in with no change in engine hours", () => {
    expect(codes({ engineHours: 1000, workedHours: 10 })).toEqual(["hours_same"]);
  });

  it("flags fills too close together", () => {
    expect(codes({ at: after(5), engineHours: 1004, liters: 40, amount: 1200, odometer: 5050 })).toEqual(["too_frequent"]);
  });

  it("without a previous fill runs only the self-contained checks", () => {
    expect(codes({ prev: null, workedHours: null, engineHours: 1 })).toEqual([]);
    expect(codes({ prev: null, workedHours: null, liters: 300, amount: 1 })).toEqual(["amount_mismatch", "over_tank"]);
  });

  it("flags a pump reading the driver's could not have become (meters only go up, as fast as the clock)", () => {
    // asked 30 min before the fill: up to 0.5 h + 0.5 h slack, up to 120 km/h x 0.5 h + 5 km
    const asked = (engineHours: number | null, odometer: number | null) => ({ asked: { engineHours, odometer, at: after(23.5) } });
    expect(codes(asked(1009.6, 5090))).toEqual([]);
    expect(codes(asked(1009, 5100 - 65))).toEqual([]);
    expect(codes(asked(1010.5, 5100))).toEqual(["hours_driver"]);
    expect(codes(asked(1008.9, 5100))).toEqual(["hours_driver"]);
    expect(codes(asked(1010, 5101))).toEqual(["odo_driver"]);
    expect(codes(asked(1010, 5100 - 65.1))).toEqual(["odo_driver"]);
    // no odometer on either side, or the driver typed none (an old request: no hours either)
    expect(codes({ ...asked(1010, 5000), odometer: null })).toEqual([]);
    expect(codes(asked(null, null))).toEqual([]);
    expect(fuelFlags({ ...normal, ...asked(1012, null) })[0].text).toBe("ชั่วโมงเครื่องตอนเติม 1,010 ต่างจากที่คนขับแจ้ง 1,012 (-2 ชม. ห่างกัน 0.5 ชม.)");
  });

  it("shows the pump reading with its difference from the driver's", () => {
    expect(readingText(1236.5, 1235)).toBe("1,236.5 (คนขับแจ้ง 1,235 ต่าง +1.5)");
    expect(readingText(1100.3, 1100.1)).toBe("1,100.3 (คนขับแจ้ง 1,100.1 ต่าง +0.2)");
    expect(readingText(5000, 5000)).toBe("5,000 (คนขับแจ้ง 5,000 ต่าง 0)");
    expect(readingText(5000, null)).toBe("5,000");
    expect(readingText(null, 5000)).toBe("-");
  });

  it("skips checks whose inputs are missing", () => {
    const tank = { pricePerLiter: null, amount: null, odometer: null, vehicle: { litersPerHour: null, tankLiters: null } };
    expect(codes({ ...tank, liters: 400 })).toEqual([]);
  });
});

describe("invoiceDateError", () => {
  // 10:00 on 24 Nov 2026 in Bangkok; 183 days earlier is 25 May
  const now = new Date("2026-11-24T10:00:00+07:00");

  it("takes a real date from 183 days ago up to today (Bangkok)", () => {
    expect(invoiceDateError("2026-11-24", now)).toBeNull();
    expect(invoiceDateError("2026-05-25", now)).toBeNull();
    // 00:30 in Bangkok is still the day before in UTC
    expect(invoiceDateError("2026-11-24", new Date("2026-11-24T00:30:00+07:00"))).toBeNull();
  });
  it("refuses a missing, impossible, future or too old date", () => {
    expect(invoiceDateError("", now)).toBe("กรอกวันที่ในใบกำกับภาษี");
    expect(invoiceDateError("2026-02-30", now)).toBe("กรอกวันที่ในใบกำกับภาษี");
    expect(invoiceDateError("2569-11-24", now)).toBe("กรอกวันที่ในใบกำกับภาษี");
    expect(invoiceDateError("2026-11-25", now)).toMatch(/เลยวันนี้/);
    expect(invoiceDateError("2026-05-24", now)).toMatch(/183 วัน/);
  });
});

describe("flagCodes", () => {
  it("is the codes of the stored flags in order, what an approval sends back", () => {
    expect(flagCodes([{ code: "lph_high", text: "a" }, { code: "invoice_dup", text: "b" }])).toBe("lph_high,invoice_dup");
    // the text changes with the figures, the codes are what was shown
    expect(flagCodes([{ code: "lph_high", text: "other text" }])).toBe("lph_high");
    expect(flagCodes([])).toBe("");
    expect(flagCodes(null)).toBe("");
    expect(flagCodes("garbage")).toBe("");
  });
});

describe("replacement", () => {
  const bill = (invoice: string, replaces = "") => ({ invoice, replaces });

  it("pairs a replacement tax invoice with the one it cancels, either way round", () => {
    // the Thai prefix, dashes, spaces and case do not count
    expect(replacement(bill("ต2611090077", "ต2611090001"), bill("2611-090001"))).toBe("replaces");
    expect(replacement(bill("inv 2611090001"), bill("ต2611090077", "INV2611090001"))).toBe("replaced");
  });

  it("does not pair anything else", () => {
    expect(replacement(bill("2611090077", "2611090001"), bill("2611090002"))).toBeNull();
    // the same invoice twice is a slip used twice (invoice_dup), not a replacement
    expect(replacement(bill("2611090001"), bill("2611090001"))).toBeNull();
    // the whole key, not its end: another station's number
    expect(replacement(bill("2611090077", "2611090001"), bill("92611090001"))).toBeNull();
    // keys shorter than 6 characters match too much
    expect(replacement(bill("A1", "ต12345"), bill("12345"))).toBeNull();
    expect(replacement(bill(""), bill("2611090077", ""))).toBeNull();
  });
});

describe("reviewFuel: a replacement tax invoice and the approved fill it cancels", () => {
  const office = { id: "u1", name: "สมศรี" };
  // #1 approved with the old invoice; #2 filled with the slip that replaces it (another vehicle: no baseline between them)
  const fill = (o: Record<string, unknown>) => ({
    driverId: "d1",
    fillerId: "f1",
    source: "pump",
    supplierCode: "บ015",
    slipRead: null,
    flags: [],
    reviewedAt: null,
    invoiceDate: null,
    liters: 100,
    pricePerLiter: 30,
    amount: 3000,
    vehicle: { code: "12-3456", expressItem: "140 SY", expressDep: "" },
    express: null,
    ...o,
  });
  const old = () => mem.fills.find((f) => f.id === "a")!;
  const approve = () => reviewFuel(office, "b", "approve", "", { reviewedAt: null, flags: "" });
  const cancelOld = () => reviewFuel(office, "a", "cancel", "ใช้ใบกำกับที่ออกแทนใน #2", { reviewedAt: null, flags: "" });
  beforeEach(() => {
    mem.fills.length = 0;
    mem.sent.length = 0;
    mem.raw.length = 0;
    mem.hook.meanwhile = null;
    mem.fills.push(
      fill({ id: "a", no: 1, status: "approved", vehicleId: "v1", invoice: "ต2611090001", filledAt: new Date("2026-11-20T03:00:00Z") }),
      fill({ id: "b", no: 2, status: "filled", vehicleId: "v2", invoice: "ต2611090077", slipRead: { replaces: "ต2611090001" }, filledAt: new Date("2026-11-21T03:00:00Z") })
    );
  });

  it("holds the replacement while the fill it cancels is approved, even once that one's Express order is cancelled", async () => {
    for (const express of [null, { status: "written" }, { status: "cancelled" }, { status: "manual" }]) {
      old().express = express;
      const r = await approve();
      expect("error" in r && r.error).toMatch(/^ใบกำกับนี้ออกแทนใบเลขที่ ต2611090001 ของคำขอ #1 ที่อนุมัติแล้ว.*แล้วยกเลิกคำขอ #1 .*จากนั้นจึงอนุมัติรายการนี้/);
      expect(mem.fills.find((f) => f.id === "b")!.status).toBe("filled");
    }
  });
  it("cancels an approved fill of which nothing is in Express; the replacement is then approved", async () => {
    for (const express of [null, { status: "cancelled" }]) {
      old().status = "approved";
      old().express = express;
      expect(await cancelOld()).toEqual({ data: {} });
      expect(old()).toMatchObject({ status: "cancelled", returnNote: "ใช้ใบกำกับที่ออกแทนใน #2", reviewedBy: "สมศรี" });
    }
    expect(mem.sent).toContain("ยกเลิกคำขอเติมน้ำมัน #1: ใช้ใบกำกับที่ออกแทนใน #2"); // the driver hears it
    expect(await approve()).toEqual({ data: { express: "queued" } });
    expect(mem.fills.find((f) => f.id === "b")!.status).toBe("approved");
  });
  it("cancels an approved fill keyed in Express by hand with its order; staff are told to void that PK / H3", async () => {
    old().express = { status: "manual", error: "คีย์ใน Express เองแล้ว (โดย สมชาย)" };
    expect(await cancelOld()).toEqual({ data: { notice: "ยกเลิกแล้ว: PK / H3 ของ #1 ที่คีย์ไว้เองยังอยู่ใน Express ให้ยกเลิกเอกสารนั้นใน Express ด้วย" } });
    expect(old()).toMatchObject({
      status: "cancelled",
      reviewedBy: "สมศรี",
      express: { status: "cancelled", error: "ยกเลิกพร้อมคำขอโดย สมศรี: ใช้ใบกำกับที่ออกแทนใน #2 (เดิม คีย์ใน Express เองแล้ว (โดย สมชาย))" },
    });
    expect(await approve()).toEqual({ data: { express: "queued" } });
  });
  it("refuses to cancel an approved fill whose order the office PC still has to write or has written", async () => {
    for (const status of ["queued", "written", "error"]) {
      old().express = { status };
      const r = await cancelOld();
      expect("error" in r && r.error).toMatch(/อนุมัติแล้วและมีรายการ Express อยู่/);
      expect(old()).toMatchObject({ status: "approved", express: { status } });
    }
  });
  it("refuses when the approved fill was sent to Express or keyed by hand meanwhile", async () => {
    for (const status of ["queued", "manual"]) {
      old().express = null;
      mem.hook.meanwhile = () => void (old().express = { status }); // ส่งเข้า Express / คีย์เองแล้ว on /office/express
      expect(await cancelOld()).toEqual({ error: "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า" });
      expect(old()).toMatchObject({ status: "approved", express: { status } });
    }
  });
  it("locks an approved fill's row before its guarded write (an order being made for it is waited for, then seen)", async () => {
    let before: unknown[] = [];
    mem.hook.meanwhile = () => void (before = mem.raw.map((q) => [q.sql, ...q.values]));
    expect(await cancelOld()).toEqual({ data: {} });
    expect(before).toEqual([['SELECT 1 FROM "FuelRequest" WHERE "id" = ? FOR UPDATE', "a"]]);
  });
  it("still cancels an open request, never a cancelled one", async () => {
    old().status = "filled";
    expect(await cancelOld()).toEqual({ data: {} });
    expect(await cancelOld()).toEqual({ error: "รายการนี้ถูกเปลี่ยนไปแล้ว รีเฟรชหน้า" });
    expect(mem.raw).toEqual([]); // no row lock: nothing makes an order for an open request
  });
});

describe("vatOnTopOff", () => {
  it("accepts a total some price + ROUND(price x 7%, 2) gives", () => {
    expect(vatOnTopOff(10700)).toBe(false); // 10,000 + 700
    expect(vatOnTopOff(856)).toBe(false); // 800 + 56
    expect(vatOnTopOff(1000.06)).toBe(false); // 934.64 + 65.42
  });
  it("refuses a total no price gives", () => {
    expect(vatOnTopOff(1000.07)).toBe(true);
  });
});
