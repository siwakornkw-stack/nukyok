import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@prisma/client";
import {
  fuelOrder,
  knownDepartments,
  parseMasters,
  repairOrder,
  saveMasters,
  vatClosedThrough,
  vatMonthClosed,
  type ExpressMasters,
  type FuelBill,
  type RepairBill,
} from "@/lib/express";
import { applyResults, companyRefused, queuedOrders } from "@/lib/express-queue";
import { POST as close } from "@/app/api/express/close/route";
import { GET as fuelGet } from "@/app/api/express/fuel/route";
import { GET as r3Get, POST as r3Post } from "@/app/api/express/r3/route";
import { POST as retry } from "@/app/api/express/retry/route";
import { POST as repairManual } from "@/app/api/express/repair-manual/route";
import { bkkDateKey, shiftMonth } from "@/lib/time";

// The database as the Prisma calls of express-queue, saveMasters and the /api/express routes use it, in memory:
// where clauses with equality, { not }, { is: null }, { in } and OR. LINE messages are collected in sent; user is who
// acts on the web routes.
const mem = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
      const op = v !== null && typeof v === "object" ? (v as Row) : {};
      if ("not" in op) return (row[k] ?? null) !== op.not;
      if ("is" in op) return (row[k] ?? null) === op.is;
      if ("in" in op) return (op.in as unknown[]).includes(row[k] ?? null);
      return (row[k] ?? null) === v;
    });
  const orders: Row[] = [];
  const repairs: Row[] = [];
  const settings = new Map<string, unknown>();
  const sent: string[] = [];
  const db = {
    expressOrder: {
      findMany: async ({ where }: { where: Row }) => orders.filter((r) => matches(r, where)),
      findFirst: async ({ where }: { where: Row }) => orders.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => orders.find((r) => matches(r, where)) ?? null,
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hit = orders.filter((r) => matches(r, where));
        for (const r of hit) Object.assign(r, data);
        return { count: hit.length };
      },
      create: async ({ data }: { data: Row }) => void orders.push({ id: `o${orders.length + 1}`, r3Status: null, ...data }),
    },
    // express: the repair's order (a relation in the database)
    repairRequest: {
      findFirst: async ({ where }: { where: Row }) =>
        repairs.map((r) => ({ ...r, express: orders.find((o) => o.repairRequestId === r.id) ?? null })).find((r) => matches(r, where)) ?? null,
    },
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, create }: { where: { key: string }; create: { value: unknown } }) => void settings.set(where.key, create.value),
    },
  };
  const prisma = { ...db, $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) };
  const user = { id: "u1", name: "สมศรี", roles: ["office"] };
  return { orders, repairs, settings, sent, prisma, user };
});

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/line", () => ({
  appLink: (path: string) => `https://app${path}`,
  notifyOfficeGroup: async (text: string) => (mem.sent.push(text), true),
  notifyRoles: async (_roles: unknown, text: string) => (mem.sent.push(text), true),
}));
vi.mock("@/lib/session", () => ({ apiUser: async () => ({ user: mem.user }) }));

beforeEach(() => {
  mem.orders.length = 0;
  mem.repairs.length = 0;
  mem.settings.clear();
  mem.sent.length = 0;
  mem.user.roles = ["office"];
});

// An ExpressOrder row (a queued fuel bill unless told otherwise).
const order = (o: Record<string, unknown>) => ({ kind: "fuel", status: "queued", payload: {}, poNo: null, h3No: null, error: null, r3Status: null, r3No: null, r3Error: null, ...o });
const row = (id: string) => mem.orders.find((o) => o.id === id)!;
const post = (route: (req: Request) => Promise<Response>, body: object) =>
  route(new Request("http://localhost/api/express", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const answer = async (res: Response) => ({ status: res.status, ...(await res.json()) });
// The office PC's calls (Bearer EXPRESS_SYNC_SECRET): a GET, or a POST of results.
const SYNC = "test-sync-secret-0001";
const agent = (route: (req: Request) => Promise<Response>, body?: object) =>
  route(
    new Request("http://localhost/api/express", {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${SYNC}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
const asAgent = () => {
  vi.stubEnv("EXPRESS_SYNC_SECRET", SYNC);
  vi.stubEnv("EXPRESS_COMPANY", "");
};

// The masters as an agent sends them (departments: as a newer agent sends them).
const raw = (o: { fuelItems?: unknown[]; fuelSuppliers?: unknown[]; repairSuppliers?: unknown[]; departments?: unknown[]; writer?: boolean } = {}) => ({
  fuel: {
    suppliers: o.fuelSuppliers ?? [{ code: "บ015", name: "บางจาก", vat: true }],
    items: o.fuelItems ?? [
      { code: "140 SY", desc: "น้ำมัน SY140", depCode: "03", depName: "ขนส่ง", stock: false, vatClaim: true },
      { code: "VAN", desc: "น้ำมันรถตู้", depCode: "04", depName: "ธุรการ", stock: false, vatClaim: false },
    ],
    writer: o.writer ?? true,
  },
  repair: {
    suppliers: o.repairSuppliers ?? [
      { code: "อ001", name: "อู่ช่างเอก", vat: true, taxId: "0105512345678" },
      { code: "ร002", name: "ร้านยางเล็ก", vat: false },
    ],
    items: [{ code: "SV-REPAIR", desc: "ค่าซ่อม", depCode: "09", depName: "", stock: false, vatClaim: true }],
    ...(o.departments ? { departments: o.departments } : {}),
    writer: o.writer ?? true,
  },
});

// A transaction client that only answers the two AppSetting reads the order builders make.
const fakeDb = (masters: unknown, filed = "") =>
  ({
    appSetting: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) =>
        key === "express_masters" ? { value: { ...(masters as object), at: new Date().toISOString() } } : key === "vat_filed_through" && filed ? { value: filed } : null,
    },
  }) as unknown as Prisma.TransactionClient;

const thisMonth = bkkDateKey().slice(0, 7);
const today = bkkDateKey();
const longAgo = `${shiftMonth(thisMonth, -3)}-10`; // always in a closed VAT month
const day = (key: string) => new Date(`${key}T00:00:00Z`); // a @db.Date value

const fill = (o: Partial<FuelBill> = {}): FuelBill => ({
  id: "f1",
  source: "pump",
  supplierCode: "บ015",
  invoice: "ต2611090002",
  liters: 200,
  pricePerLiter: 32.5,
  amount: 6500,
  filledAt: new Date(),
  invoiceDate: day(today),
  vehicle: { expressItem: "140 SY", expressDep: "" },
  ...o,
});

const repair = (o: Partial<RepairBill> = {}): RepairBill => ({
  id: "r1",
  no: 7,
  supplierCode: "อ001",
  itemCode: "SV-REPAIR",
  invoice: "IV200",
  costAmount: 10700,
  vatMode: "1",
  costedAt: new Date(),
  invoiceDate: day(today),
  symptom: "ไฮดรอลิครั่ว",
  costDetail: "เปลี่ยนซีล",
  vehicle: { code: "SY55-02", expressDep: "03", expressItem: "140 SY" },
  ...o,
});

describe("parseMasters", () => {
  it("treats a fuel item without vatClaim as not claimable", () => {
    const m = parseMasters(raw({ fuelItems: [{ code: "NEW", desc: "รถใหม่", depCode: "03" }, { code: "OLD", desc: "รถเก่า", depCode: "03", vatClaim: true }] }))!;
    expect(m.fuel.items.map((i) => [i.code, i.vatClaim])).toEqual([
      ["NEW", false],
      ["OLD", true],
    ]);
  });

  it("keeps vat for every supplier but a tax ID only for juristic persons", () => {
    const m = parseMasters(
      raw({
        repairSuppliers: [
          { code: "A", name: "บริษัท", taxId: "0105512345678", branch: "0" }, // older agent: vat from the tax ID
          { code: "B", name: "นาย ก", taxId: "3100500123456" }, // a person's national ID: never kept
          { code: "C", name: "ร้านเล็ก", taxId: "" },
          { code: "D", name: "หจก.", taxId: "0-1035-51234-56-7" },
          { code: "E", name: "นาย ข", vat: true }, // new agent: vat as sent, no ID
          { code: "F", name: "ร้าน", vat: false, taxId: "0105512345678" },
          { code: "G", name: "ร้านยาง", taxId: "0000000000000" }, // older agent: a filler is no tax ID
          { code: "H", name: "ร้านแบตเตอรี่", taxId: "1111111111111" },
          { code: "I", name: "Mr. A", taxId: "0012345678901" }, // from 00: a non-Thai person's ID, never kept
          { code: "J", name: "ร้านสี", taxId: "010551234567" }, // 12 digits
        ],
      })
    )!;
    expect(m.repair.suppliers).toEqual([
      { code: "A", name: "บริษัท", vat: true, taxId: "0105512345678" },
      { code: "B", name: "นาย ก", vat: true },
      { code: "C", name: "ร้านเล็ก", vat: false },
      { code: "D", name: "หจก.", vat: true, taxId: "0103551234567" },
      { code: "E", name: "นาย ข", vat: true },
      { code: "F", name: "ร้าน", vat: false, taxId: "0105512345678" },
      { code: "G", name: "ร้านยาง", vat: false },
      { code: "H", name: "ร้านแบตเตอรี่", vat: false },
      { code: "I", name: "Mr. A", vat: true },
      { code: "J", name: "ร้านสี", vat: false },
    ]);
  });

  it("keeps every department of the repair book (a newer agent), up to 1000", () => {
    const m = parseMasters({ ...raw({ departments: [{ code: " 03 ", name: " ขนส่ง " }] }), fuel: { ...raw().fuel, departments: [{ code: "X", name: "" }] } })!;
    expect(m.repair.departments).toEqual([{ code: "03", name: "ขนส่ง" }]);
    expect(m.fuel).not.toHaveProperty("departments");
    expect(parseMasters(raw())!.repair.departments).toBeUndefined(); // an older agent
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ code: String(i), name: `แผนก ${i}` }));
    expect(parseMasters(raw({ departments: many(1000) }))?.repair.departments).toHaveLength(1000);
    expect(parseMasters(raw({ departments: many(1001) }))).toBeNull();
  });

  it("takes up to 1000 suppliers per book", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ code: `S${i}`, name: `ร้าน ${i}` }));
    expect(parseMasters(raw({ repairSuppliers: many(1000) }))?.repair.suppliers).toHaveLength(1000);
    expect(parseMasters(raw({ repairSuppliers: many(1001) }))).toBeNull();
  });
});

describe("knownDepartments", () => {
  it("lists the departments of every fuel and repair item, with a name when one has it", () => {
    const m: ExpressMasters = {
      ...parseMasters(
        raw({
          fuelItems: [
            { code: "A", desc: "", depCode: "03", depName: "" },
            { code: "B", desc: "", depCode: "03", depName: "ขนส่ง" },
            { code: "C", desc: "", depCode: "" },
          ],
        })
      )!,
      at: "",
    };
    expect([...knownDepartments(m)]).toEqual([
      ["03", "ขนส่ง"],
      ["09", ""],
    ]);
  });

  it("takes the departments a newer agent sends, with their names, also one no item uses", () => {
    const m: ExpressMasters = {
      ...parseMasters(raw({ departments: [{ code: "03", name: "ขนส่ง" }, { code: "C001", name: "สำนักงาน" }, { code: "", name: "ไม่มีรหัส" }] }))!,
      at: "",
    };
    expect([...knownDepartments(m)]).toEqual([
      ["03", "ขนส่ง"],
      ["C001", "สำนักงาน"],
    ]);
    // the list is every department Express has: an item's department missing from it (04, 09) is not one
    expect(knownDepartments(m).has("04")).toBe(false);
    // an empty list: the items' departments, as for an older agent
    expect([...knownDepartments({ ...parseMasters(raw({ departments: [] }))!, at: "" }).keys()]).toEqual(["03", "04", "09"]);
  });
});

describe("vatClosedThrough", () => {
  const at = (iso: string) => new Date(iso);
  it("closes every month before last, and last month after the 15th (Bangkok)", () => {
    expect(vatClosedThrough("", at("2026-11-15T12:00:00+07:00"))).toBe("2026-09");
    expect(vatClosedThrough("", at("2026-11-15T17:30:00Z"))).toBe("2026-10"); // 16 Nov 00:30 in Bangkok
    expect(vatClosedThrough("", at("2027-01-10T12:00:00+07:00"))).toBe("2026-11");
    expect(vatClosedThrough("", at("2027-01-20T12:00:00+07:00"))).toBe("2026-12");
  });

  it("closes the month Office marked as filed, never less than the deadline rule", () => {
    expect(vatClosedThrough("2026-10", at("2026-11-05T12:00:00+07:00"))).toBe("2026-10");
    expect(vatClosedThrough("2026-08", at("2026-11-05T12:00:00+07:00"))).toBe("2026-09");
    expect(vatClosedThrough("2026-13", at("2026-11-05T12:00:00+07:00"))).toBe("2026-09");
    expect(vatClosedThrough("x", at("2026-11-20T12:00:00+07:00"))).toBe("2026-10");
  });

  it("vatMonthClosed reads the filed month", async () => {
    const now = at("2026-11-05T12:00:00+07:00");
    expect(await vatMonthClosed("2026-10-31", fakeDb(raw()), now)).toBe(false);
    expect(await vatMonthClosed("2026-10-31", fakeDb(raw(), "2026-10"), now)).toBe(true);
    expect(await vatMonthClosed("2026-09-30", fakeDb(raw()), now)).toBe(true);
    expect(await vatMonthClosed("2026-11-01", fakeDb(raw(), "2026-10"), now)).toBe(false);
  });
});

describe("fuelOrder", () => {
  it("dates the PK + H3 by the tax invoice, else the Bangkok day of the fill", async () => {
    const o = await fuelOrder(fakeDb(raw()), fill());
    expect(o).toEqual({
      payload: { withH3: true, supplier: "บ015", item: "140 SY", dep: "03", date: today, invoice: "2611090002", liters: 200, price: 32.5, amount: 6500 },
      note: undefined,
    });
    const filledAt = new Date("2026-10-31T17:05:00Z"); // 1 Nov 00:05 in Bangkok
    expect(await fuelOrder(fakeDb(raw()), fill({ invoiceDate: null, filledAt }))).toMatchObject({ payload: { date: "2026-11-01" } });
  });

  it("refuses a vehicle department Express does not have", async () => {
    const o = await fuelOrder(fakeDb(raw()), fill({ vehicle: { expressItem: "140 SY", expressDep: "C01" } }));
    expect(o).toEqual({ reason: expect.stringContaining("แผนก C01") });
    expect(await fuelOrder(fakeDb(raw()), fill({ vehicle: { expressItem: "140 SY", expressDep: "04" } }))).toMatchObject({ payload: { dep: "04" } });
    // a newer agent sends every Express department: one no item uses is known
    const all = raw({ departments: [{ code: "03", name: "ขนส่ง" }, { code: "C01", name: "สำนักงาน" }] });
    expect(await fuelOrder(fakeDb(all), fill({ vehicle: { expressItem: "140 SY", expressDep: "C01" } }))).toMatchObject({ payload: { dep: "C01" } });
  });

  it("opens the PK only, with a note, when the bill's VAT month is closed", async () => {
    const o = await fuelOrder(fakeDb(raw()), fill({ invoiceDate: day(longAgo) }));
    expect(o).toMatchObject({ payload: { withH3: false, date: longAgo }, note: expect.stringContaining("เปิดเฉพาะ PK") });
    const filed = await fuelOrder(fakeDb(raw(), shiftMonth(thisMonth, -1)), fill({ invoiceDate: day(`${shiftMonth(thisMonth, -1)}-28`) }));
    expect(filed).toMatchObject({ payload: { withH3: false }, note: expect.any(String) });
  });

  it("opens the PK only, without a note, for a vehicle whose VAT is not claimable", async () => {
    expect(await fuelOrder(fakeDb(raw()), fill({ vehicle: { expressItem: "VAN" } }))).toMatchObject({ payload: { withH3: false, dep: "04" }, note: undefined });
  });

  it("opens the PK only, with a note, for a pump without a usable tax ID in Express (no input VAT, as for repair)", async () => {
    const m = raw({
      fuelSuppliers: [
        { code: "บ015", name: "บางจาก", vat: true },
        { code: "ป020", name: "ปั๊มเล็ก", vat: false },
        { code: "ป021", name: "ปั๊มเก่า", taxId: "0000000000000" }, // an older agent's filler tax ID is none
      ],
    });
    expect(await fuelOrder(fakeDb(m), fill({ supplierCode: "ป020" }))).toMatchObject({
      payload: { withH3: false, supplier: "ป020", item: "140 SY" },
      note: expect.stringContaining("ป020 ไม่มีเลขประจำตัวผู้เสียภาษี"),
    });
    expect(await fuelOrder(fakeDb(m), fill({ supplierCode: "ป021" }))).toMatchObject({ payload: { withH3: false }, note: expect.stringContaining("เปิดเฉพาะ PK") });
    expect(await fuelOrder(fakeDb(m), fill())).toMatchObject({ payload: { withH3: true }, note: undefined });
    // nothing to say for a vehicle whose VAT is not claimable anyway
    expect(await fuelOrder(fakeDb(m), fill({ supplierCode: "ป020", vehicle: { expressItem: "VAN" } }))).toMatchObject({ payload: { withH3: false }, note: undefined });
  });

  it("refuses while the fuel writer is off", async () => {
    expect(await fuelOrder(fakeDb(raw({ writer: false })), fill())).toEqual({ reason: expect.stringContaining("ยังไม่เปิดใช้") });
  });
});

describe("repairOrder", () => {
  it("books a VAT bill of a garage with a tax ID for a claimable vehicle, dated by the tax invoice", async () => {
    const o = await repairOrder(fakeDb(raw()), repair({ invoiceDate: day(`${thisMonth}-01`) }));
    expect(o).toEqual({
      payload: { supplier: "อ001", item: "SV-REPAIR", dep: "03", date: `${thisMonth}-01`, invoice: "IV200", amount: 10700, vat: "1", job: "เปลี่ยนซีล", plate: "SY55-02" },
    });
  });

  it("refuses VAT 1 / 2 from a supplier without a tax ID, but not VAT 0", async () => {
    expect(await repairOrder(fakeDb(raw()), repair({ supplierCode: "ร002", vatMode: "2" }))).toEqual({ reason: expect.stringContaining("ไม่มีเลขประจำตัวผู้เสียภาษี") });
    expect(await repairOrder(fakeDb(raw()), repair({ supplierCode: "ร002", vatMode: "0" }))).toHaveProperty("payload");
    // an older agent's supplier with a filler tax ID has none
    const filler = raw({ repairSuppliers: [{ code: "ร004", name: "ร้านยาง", taxId: "0000000000000" }] });
    expect(await repairOrder(fakeDb(filler), repair({ supplierCode: "ร004", vatMode: "1" }))).toEqual({ reason: expect.stringContaining("ไม่มีเลขประจำตัวผู้เสียภาษี") });
  });

  it("refuses VAT 1 / 2 unless the vehicle's fuel item is found and claimable, saying which", async () => {
    const none = { code: "SY55-02", expressDep: "03", expressItem: "" };
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: none }))).toEqual({ reason: expect.stringContaining("ยังไม่ได้ตั้งรหัสน้ำมัน") });
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: { ...none, expressItem: "GONE" } }))).toEqual({ reason: expect.stringContaining("ไม่มีใน Express แล้ว") });
    // found but not claimable (or no H3 yet): nothing to set on the vehicle page
    const van = await repairOrder(fakeDb(raw()), repair({ vehicle: { ...none, expressItem: "VAN" } }));
    expect(van).toEqual({ reason: expect.stringContaining("VAN ของรถคันนี้ไม่ได้ลงภาษีซื้อ") });
    expect(van).not.toEqual({ reason: expect.stringContaining("ตั้งรหัสน้ำมัน") });
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: none, vatMode: "0" }))).toMatchObject({ payload: { dep: "03", vat: "0" } });
  });

  it("refuses VAT 1 / 2 in a closed VAT month, but not VAT 0", async () => {
    expect(await repairOrder(fakeDb(raw()), repair({ invoiceDate: day(longAgo) }))).toEqual({ reason: expect.stringContaining("ปิดแล้ว") });
    expect(await repairOrder(fakeDb(raw()), repair({ invoiceDate: day(longAgo), vatMode: "0" }))).toMatchObject({ payload: { date: longAgo } });
  });

  it("takes the vehicle's department, else its fuel item's, and refuses one Express does not have", async () => {
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: { code: "X", expressDep: "", expressItem: "140 SY" } }))).toMatchObject({ payload: { dep: "03" } });
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: { code: "X", expressDep: "c03", expressItem: "140 SY" } }))).toEqual({ reason: expect.stringContaining("แผนก c03") });
    expect(await repairOrder(fakeDb(raw()), repair({ vehicle: { code: "X", expressDep: "", expressItem: "" }, vatMode: "0" }))).toEqual({
      reason: expect.stringContaining("ยังไม่ได้ตั้งแผนก"),
    });
  });
});

describe("companyRefused (x-express-company)", () => {
  const call = (company?: string) => new Request("http://localhost/api/express/fuel", { headers: company === undefined ? {} : { "x-express-company": company } });
  afterEach(() => vi.unstubAllEnvs());

  it("checks nothing while EXPRESS_COMPANY is not set", () => {
    vi.stubEnv("EXPRESS_COMPANY", " ");
    expect(companyRefused(call())).toBeNull();
    expect(companyRefused(call("TESTR3"))).toBeNull();
  });

  it("lets the server's own company in, in any case, and refuses another one or none with 409", async () => {
    vi.stubEnv("EXPRESS_COMPANY", " dhewa66 ");
    expect(companyRefused(call("DHEWA66"))).toBeNull();
    expect(companyRefused(call("dhewa66"))).toBeNull();
    const other = companyRefused(call("TESTR3"))!;
    expect(other.status).toBe(409);
    expect((await other.json()).error).toMatch(/TESTR3.*DHEWA66/);
    const none = companyRefused(call())!;
    expect([none.status, (await none.json()).error]).toEqual([409, expect.stringContaining("(ไม่ระบุ)")]);
  });
});

describe("queuedOrders (what the office PC gets)", () => {
  it("turns a bill whose input VAT would land in a closed VAT month into an error and tells the Office group once", async () => {
    mem.orders.push(
      order({ id: "late", payload: { withH3: true, date: longAgo, invoice: "2608100001" } }),
      order({ id: "pk", payload: { withH3: false, date: longAgo, invoice: "2608100002" } }),
      order({ id: "now", payload: { withH3: true, date: today, invoice: "2611240003" } })
    );
    expect((await queuedOrders("fuel")).map((o) => o.id)).toEqual(["pk", "now"]);
    expect(row("late")).toMatchObject({ status: "error", error: expect.stringContaining("ลองใหม่") });
    expect(mem.sent).toEqual([expect.stringMatching(/PK \/ H3 1 รายการ.*2608100001/)]);
    expect((await queuedOrders("fuel")).map((o) => o.id)).toEqual(["pk", "now"]);
    expect(mem.sent).toHaveLength(1);
  });

  it("holds back a VAT 1 / 2 repair of a month Office marked as filed, not a VAT 0 one", async () => {
    const last = `${shiftMonth(thisMonth, -1)}-28`;
    mem.settings.set("vat_filed_through", shiftMonth(thisMonth, -1));
    mem.orders.push(order({ id: "v", kind: "repair", payload: { vat: "2", date: last, invoice: "IV1" } }), order({ id: "n", kind: "repair", payload: { vat: "0", date: last, invoice: "IV2" } }));
    expect((await queuedOrders("repair")).map((o) => o.id)).toEqual(["n"]);
    expect(row("v")).toMatchObject({ status: "error", error: expect.stringContaining("คีย์เองแล้ว") });
  });
});

describe("saveMasters", () => {
  it("turns the queued bills of a writer sent as off into errors and tells the Office group", async () => {
    mem.orders.push(order({ id: "f" }), order({ id: "r", kind: "repair" }), order({ id: "w", status: "written" }));
    const m = raw();
    expect(await saveMasters({ ...m, fuel: { ...m.fuel, writer: false } })).toBe(true);
    expect(mem.settings.get("express_masters")).toMatchObject({ fuel: { writer: false }, repair: { writer: true } });
    expect(row("f")).toMatchObject({ status: "error", error: expect.stringContaining("ถูกปิดที่เครื่อง Office") });
    expect([row("r").status, row("w").status]).toEqual(["queued", "written"]);
    expect(mem.sent).toEqual([expect.stringContaining('PK / H3 อัตโนมัติที่เครื่อง Office: 1 รายการที่รอเขียนย้ายไปที่ "ไม่สำเร็จ"')]);
    expect(await saveMasters(m)).toBe(true); // back on: nothing to move, nothing said
    expect(mem.sent).toHaveLength(1);
  });

  it("turns the R3 steps still to do into R3 errors when the fuel writer (and with it the R3) goes off, telling the Office group once", async () => {
    mem.orders.push(
      order({ id: "q", status: "written", poNo: "PK1", h3No: "H31", r3Status: "queued" }),
      order({ id: "f", status: "written", poNo: "PK2", h3No: "H32", r3Status: "force" }),
      order({ id: "w", status: "written", poNo: "PK3", r3Status: "waiting", r3Error: "ยังไม่มี H3 ที่อ้างถึงใบนี้ใน Express" }),
      order({ id: "d", status: "written", poNo: "PK4", r3Status: "done", r3No: "R31" }),
      order({ id: "e", status: "written", poNo: "PK5", r3Status: "error", r3Error: "R3 ถูกล็อก" }),
      order({ id: "c", status: "cancelled", poNo: "PK6", r3Status: "done", r3No: "R32" }),
      order({ id: "rr", kind: "repair", status: "written", poNo: "PO1", h3No: "RR1" }),
      order({ id: "nq" }) // a fuel bill still queued
    );
    const m = raw();
    // the repair writer off leaves every R3 alone
    expect(await saveMasters({ ...m, repair: { ...m.repair, writer: false } })).toBe(true);
    expect(row("q").r3Status).toBe("queued");
    expect(mem.sent).toEqual([]);
    expect(await saveMasters({ ...m, fuel: { ...m.fuel, writer: false } })).toBe(true);
    for (const id of ["q", "f", "w"]) expect(row(id)).toMatchObject({ status: "written", r3Status: "error", r3Error: expect.stringContaining("ปิดพร้อม PK / H3") });
    expect([row("d").r3Status, row("e").r3Error, row("c").r3Status, row("rr").r3Status, row("nq").status]).toEqual(["done", "R3 ถูกล็อก", "done", null, "error"]);
    expect(mem.sent).toEqual([expect.stringContaining('PK / H3 อัตโนมัติที่เครื่อง Office: 1 รายการที่รอเขียน และ R3 3 รายการที่รอเปิดย้ายไปที่ "ไม่สำเร็จ"')]);
    // still off at the next masters: nothing more to move or say
    expect(await saveMasters({ ...m, fuel: { ...m.fuel, writer: false } })).toBe(true);
    expect(mem.sent).toHaveLength(1);
  });

  it("refuses a body that is not masters", async () => {
    expect(await saveMasters({ fuel: { suppliers: [] } })).toBe(false);
    expect(mem.settings.has("express_masters")).toBe(false);
  });

  it("stores an older agent's supplier with a filler tax ID (0000000000000) as one without: vat false, no taxId", async () => {
    expect(await saveMasters(raw({ repairSuppliers: [{ code: "ร004", name: "ร้านยาง", taxId: "0000000000000" }] }))).toBe(true);
    expect((mem.settings.get("express_masters") as ExpressMasters).repair.suppliers).toEqual([{ code: "ร004", name: "ร้านยาง", vat: false }]);
  });
});

describe("applyResults (same bill twice)", () => {
  it("turns a bill reported with another order's numbers into an error, also with every number a cancelled order holds", async () => {
    mem.orders.push(
      // cancelled on the web as a wrong entry: its PK / H3 stay live in Express until staff void them there
      order({ id: "wrong", status: "cancelled", poNo: "PK0000120", h3No: "H3691120-01", error: "ยกเลิกโดย สมศรี: ผิดรายการ" }),
      // cancelled while it had its PK only
      order({ id: "pkOnly", status: "cancelled", poNo: "PK0000121", error: "ยกเลิกโดย สมศรี: ผิดรายการ" }),
      order({ id: "again" }),
      order({ id: "onPk" }),
      order({ id: "real" }),
      order({ id: "twin" })
    );
    // the fill entered again: the office PC finds the cancelled order's documents as this bill. คีย์เองแล้ว would leave
    // it without an R3 step, and the cancel dropped the cancelled order's R3 still to do: staff do the R3 too
    expect(await applyResults("fuel", [{ id: "again", status: "done", pkNo: "PK0000120", h3No: "H3691120-01" }])).toBe(1);
    expect(row("again")).toMatchObject({ status: "error", error: expect.stringContaining("ยังเป็นของรายการที่ยกเลิกแล้ว: ยกเลิกเอกสารนั้นใน Express ก่อน"), poNo: null, r3Status: null });
    expect(row("again").error).toContain("และทำ R3 ของบิลนี้ใน Express เองด้วย (รายการที่ยกเลิกยังไม่มี R3)");
    // every number the cancelled order holds is reported: its PK, with an H3 the run put on it
    await applyResults("fuel", [{ id: "onPk", status: "done", pkNo: "PK0000121", h3No: "H3691120-02" }]);
    expect(row("onPk")).toMatchObject({ status: "error", error: expect.stringContaining("PK0000121 H3691120-02 ใน Express ยังเป็นของรายการที่ยกเลิกแล้ว") });
    // a live twin keeps its own message
    expect(await applyResults("fuel", [{ id: "real", status: "done", pkNo: "PK0000101", h3No: "H3691118-02" }])).toBe(1);
    expect(row("real")).toMatchObject({ status: "written", poNo: "PK0000101", h3No: "H3691118-02", r3Status: "queued" });
    await applyResults("fuel", [{ id: "twin", status: "done", pkNo: "PK0000101", h3No: "H3691118-02" }]);
    expect(row("twin")).toMatchObject({ status: "error", error: expect.stringContaining("เป็นของอีกรายการแล้ว"), poNo: null });
    expect(row("twin").error).not.toContain("R3");
    expect(mem.sent).toEqual([expect.stringContaining("ยกเลิกแล้ว"), expect.stringContaining("ยกเลิกแล้ว"), expect.stringContaining("อีกรายการ")]);
    // a result for an order no longer queued changes nothing and says nothing
    await applyResults("fuel", [{ id: "again", status: "done", pkNo: "PK0000120", h3No: "H3691120-01" }]);
    expect(mem.sent).toHaveLength(3);
  });

  it("says when the cancelled order's R3 already holds the bill, and nothing of R3 for a repair", async () => {
    mem.orders.push(
      order({ id: "wrong", status: "cancelled", poNo: "PK0000120", h3No: "H3691120-01", r3Status: "done", r3No: "R3691120-01" }),
      order({ id: "keyed", status: "cancelled", poNo: "PK0000122", h3No: "H3691120-03", r3Status: "manual" }),
      order({ id: "rr", kind: "repair", status: "cancelled", poNo: "PO0000009", h3No: "RR691120-01" }),
      order({ id: "a" }),
      order({ id: "b" }),
      order({ id: "c", kind: "repair" })
    );
    await applyResults("fuel", [
      { id: "a", status: "done", pkNo: "PK0000120", h3No: "H3691120-01" },
      { id: "b", status: "done", pkNo: "PK0000122", h3No: "H3691120-03" },
    ]);
    expect(row("a").error).toContain(`กด "คีย์เองแล้ว" แทน: R3 R3691120-01 ของรายการที่ยกเลิกมีบิลนี้แล้ว)`);
    expect(row("b").error).toContain(`กด "คีย์เองแล้ว" แทน: R3 ของรายการที่ยกเลิกมีบิลนี้แล้ว)`);
    await applyResults("repair", [{ id: "c", status: "done", poNo: "PO0000009", rrNo: "RR691120-01" }]);
    expect(row("c")).toMatchObject({ status: "error", error: expect.stringContaining(`ยังเป็นของรายการที่ยกเลิกแล้ว`) });
    expect(row("c").error).toContain(`กด "คีย์เองแล้ว" แทน)`);
  });

  it("books a real bill sharing one number only with a cancelled test order of another company (TESTR3)", async () => {
    mem.orders.push(
      // the 18 Nov test bill the TESTR3 office PC wrote and reported: DHEWA66 numbers its own documents the same way
      order({ id: "test", status: "cancelled", poNo: "PK0000004", h3No: "H3691118-01", r3Status: "done", r3No: "R3691118-01" }),
      order({ id: "first18" }),
      order({ id: "onPk4" }),
      order({ id: "dup" })
    );
    // the first real H3 of 18 Nov, on its own PK
    await applyResults("fuel", [{ id: "first18", status: "done", pkNo: "PK0000102", h3No: "H3691118-01" }]);
    expect(row("first18")).toMatchObject({ status: "written", poNo: "PK0000102", h3No: "H3691118-01", error: null, r3Status: "queued" });
    // DHEWA66's own open PK0000004 gets its H3
    await applyResults("fuel", [{ id: "onPk4", status: "done", pkNo: "PK0000004", h3No: "H3691110-01" }]);
    expect(row("onPk4")).toMatchObject({ status: "written", poNo: "PK0000004", h3No: "H3691110-01" });
    expect(mem.sent).toEqual([]);
    // a live order holding the number still counts, though the cancelled test order is found first
    await applyResults("fuel", [{ id: "dup", status: "done", pkNo: "PK0000103", h3No: "H3691118-01" }]);
    expect(row("dup")).toMatchObject({ status: "error", error: expect.stringContaining("เป็นของอีกรายการแล้ว") });
  });
});

describe("POST /api/express/close (Office settles an order by hand)", () => {
  it("marks the failed order the page showed as keyed by hand, with who and the note", async () => {
    mem.orders.push(order({ id: "e", status: "error", error: "ตารางถูกล็อก" }));
    expect(await answer(await post(close, { id: "e", action: "manual", seen: "error", seenR3: null, note: "PK0000123" }))).toEqual({ status: 200, ok: true });
    expect(row("e")).toMatchObject({ status: "manual", error: expect.stringMatching(/สมศรี.*PK0000123/) });
  });

  it("refuses a stale page: the order was retried and written since, and its R3 failed", async () => {
    mem.orders.push(order({ id: "e", status: "written", poNo: "PK1", h3No: "H31", r3Status: "error", r3Error: "R3 ถูกล็อก" }));
    expect(await answer(await post(close, { id: "e", action: "manual", seen: "error", seenR3: null }))).toMatchObject({ status: 400, error: expect.stringContaining("รีเฟรช") });
    expect((await post(close, { id: "e", action: "manual" })).status).toBe(400); // no state shown at all
    expect(row("e")).toMatchObject({ status: "written", r3Status: "error" });
    // the R3 meaning only from a page that showed the failed R3
    expect((await post(close, { id: "e", action: "manual", seen: "written", seenR3: "error" })).status).toBe(200);
    expect(row("e")).toMatchObject({ status: "written", r3Status: "manual", r3Error: expect.stringContaining("ทำ R3 ใน Express เองแล้ว") });
  });

  it("cancels only the state the page showed, with a reason, dropping an R3 still to do and its error", async () => {
    mem.orders.push(order({ id: "c", status: "written", poNo: "PK1", h3No: "H31", r3Status: "error", r3Error: "R3 ถูกล็อก" }));
    expect(await answer(await post(close, { id: "c", action: "cancel", seen: "written", seenR3: "error" }))).toMatchObject({ status: 400, error: "ต้องกรอกเหตุผล" });
    expect((await post(close, { id: "c", action: "cancel", seen: "error", seenR3: null, note: "บิลทดสอบ" })).status).toBe(400);
    expect(row("c").status).toBe("written");
    expect((await post(close, { id: "c", action: "cancel", seen: "written", seenR3: "error", note: "บิลทดสอบ" })).status).toBe(200);
    expect(row("c")).toMatchObject({ status: "cancelled", error: expect.stringMatching(/สมศรี.*บิลทดสอบ/), r3Status: null, r3Error: null, poNo: "PK1" });
  });

  it("keeps an R3 already in Express, and waits while one is queued for the office PC", async () => {
    mem.orders.push(order({ id: "d", status: "written", r3Status: "done", r3No: "R31" }), order({ id: "q", status: "written", r3Status: "queued" }));
    expect((await post(close, { id: "d", action: "cancel", seen: "written", seenR3: "done", note: "ผิดรายการ" })).status).toBe(200);
    expect(row("d")).toMatchObject({ status: "cancelled", r3Status: "done", r3No: "R31" });
    expect((await post(close, { id: "q", action: "cancel", seen: "written", seenR3: "queued", note: "ผิดรายการ" })).status).toBe(400);
    expect(row("q")).toMatchObject({ status: "written", r3Status: "queued" });
  });
});

describe("/api/express/r3 (the office PC's R3 steps)", () => {
  beforeEach(asAgent);
  afterEach(() => vi.unstubAllEnvs());

  it("keeps an R3 the office PC wrote while Office cancelled the order on that order, and tells the Office group once", async () => {
    mem.orders.push(order({ id: "w", status: "written", poNo: "PK0000012", r3Status: "waiting", r3Error: "ยังไม่มี H3 ที่อ้างถึงใบนี้ใน Express" }));
    // a run takes the PK while its R3 waits for the H3 ...
    expect(await answer(await agent(r3Get))).toMatchObject({ status: 200, po: ["PK0000012"] });
    // ... Office cancels it meanwhile (allowed while waiting) ...
    expect((await post(close, { id: "w", action: "cancel", seen: "written", seenR3: "waiting", note: "ผิดรายการ" })).status).toBe(200);
    expect(row("w")).toMatchObject({ status: "cancelled", r3Status: null, r3Error: null });
    // ... and the run finds the H3 keyed and writes the R3
    expect(await answer(await agent(r3Post, { results: [{ po: "PK0000012", status: "done", docNo: "R3691120-01" }] }))).toEqual({ status: 200, ok: true, applied: 1 });
    expect(row("w")).toMatchObject({ status: "cancelled", r3Status: "done", r3No: "R3691120-01", r3Error: null });
    expect(mem.sent).toEqual([expect.stringMatching(/R3691120-01.*PK0000012.*ยกเลิก.*ยกเลิกบรรทัดนั้นใน Express/)]);
    // reported again: nothing more; a cancelled order is never handed out
    await agent(r3Post, { results: [{ po: "PK0000012", status: "done", docNo: "R3691120-01" }] });
    expect(mem.sent).toHaveLength(1);
    expect(await answer(await agent(r3Get))).toMatchObject({ po: [] });
  });

  it("ignores a waiting or failed R3 of a cancelled order (nothing of it reached Express)", async () => {
    mem.orders.push(order({ id: "c", status: "cancelled", poNo: "PK0000013" }));
    await agent(r3Post, { results: [{ po: "PK0000013", status: "waiting", error: "ยังไม่มี H3" }, { po: "PK0000013", status: "error", error: "R3 ถูกล็อก" }] });
    expect(row("c")).toMatchObject({ status: "cancelled", r3Status: null, r3Error: null });
    expect(mem.sent).toEqual([]);
  });

  it("books a done R3 on its written order, never on a cancelled one holding the same PK", async () => {
    mem.orders.push(order({ id: "q", status: "written", poNo: "PK0000014", r3Status: "queued" }), order({ id: "c", status: "cancelled", poNo: "PK0000014" }));
    await agent(r3Post, { results: [{ po: "PK0000014", status: "done", docNo: "R3691120-02" }] });
    expect([row("q").r3Status, row("q").r3No, row("c").r3Status]).toEqual(["done", "R3691120-02", null]);
    expect(mem.sent).toEqual([]);
  });
});

describe("POST /api/express/retry", () => {
  const approved = (vehicle: { expressItem: string; expressDep: string }) => ({
    id: "f1",
    status: "approved",
    source: "pump",
    supplierCode: "บ015",
    invoice: "ต2611090002",
    liters: 200,
    pricePerLiter: 32.5,
    amount: 6500,
    filledAt: new Date(),
    invoiceDate: day(today),
    vehicle,
  });
  beforeEach(() => mem.settings.set("express_masters", { ...raw(), at: new Date().toISOString() }));

  it("builds a failed order again from the current fill and vehicle, never the payload that failed", async () => {
    mem.orders.push(order({ id: "e", status: "error", error: "แผนก C01 ไม่มีใน Express", payload: { dep: "C01" }, fuelRequest: approved({ expressItem: "140 SY", expressDep: "03" }) }));
    expect(await answer(await post(retry, { id: "e" }))).toEqual({ status: 200, ok: true });
    expect(row("e")).toMatchObject({ status: "queued", error: null, payload: { withH3: true, dep: "03", date: today, invoice: "2611090002", amount: 6500 } });
  });

  it("leaves it failed, saying why, while the fill still cannot be booked", async () => {
    mem.orders.push(order({ id: "e", status: "error", error: "x", fuelRequest: approved({ expressItem: "GONE", expressDep: "" }) }));
    expect(await answer(await post(retry, { id: "e" }))).toMatchObject({ status: 200, notice: expect.stringContaining("ยังไม่ได้ตั้งรหัสน้ำมัน") });
    expect(row("e")).toMatchObject({ status: "error", error: "x" });
  });

  describe("ยืนยันว่าไม่ซ้ำ on a fuel bill held as a possible duplicate (one tax invoice split over vehicles)", () => {
    const held = 'อาจซ้ำ: ใบกำกับ 2611090002 ของผู้จำหน่ายนี้มี H3691109-01 (ยอด 3250.00) ใน Express แล้ว ไม่ตรงกับบิลนี้ ... ให้กด "ยืนยันว่าไม่ซ้ำ" หรือคีย์เอง';
    const split = (id: string, error = held) => order({ id, status: "error", error, payload: { withH3: true }, fuelRequest: approved({ expressItem: "140 SY", expressDep: "03" }) });
    beforeEach(asAgent);
    afterEach(() => vi.unstubAllEnvs());

    it("queues it again with force: true, which the office PC gets", async () => {
      mem.orders.push(split("s"));
      expect(await answer(await post(retry, { id: "s", force: true }))).toEqual({ status: 200, ok: true });
      expect(row("s")).toMatchObject({ status: "queued", error: null, payload: { withH3: true, supplier: "บ015", invoice: "2611090002", amount: 6500, force: true } });
      expect(await answer(await agent(fuelGet))).toMatchObject({ status: 200, orders: [expect.objectContaining({ id: "s", invoice: "2611090002", force: true })] });
    });

    it("sends no force on a plain ลองใหม่", async () => {
      mem.orders.push(split("s"));
      expect((await post(retry, { id: "s" })).status).toBe(200);
      expect(row("s").status).toBe("queued");
      expect(row("s").payload).not.toHaveProperty("force");
    });

    it("is Office's call only, and only on an error that says อาจซ้ำ", async () => {
      mem.orders.push(split("s"), split("x", "ตารางถูกล็อก"), order({ id: "r", kind: "repair", status: "error", error: held }));
      mem.user.roles = ["accounting"];
      expect(await answer(await post(retry, { id: "s", force: true }))).toMatchObject({ status: 403, error: expect.stringContaining("Office") });
      mem.user.roles = ["office"];
      // the page showed อาจซ้ำ, the order failed otherwise since (or it is no fuel bill): a stale page
      expect(await answer(await post(retry, { id: "x", force: true }))).toMatchObject({ status: 400, error: expect.stringContaining("รีเฟรช") });
      expect((await post(retry, { id: "r", force: true })).status).toBe(400);
      expect([row("s").status, row("x").status, row("r").status]).toEqual(["error", "error", "error"]);
      expect(await answer(await agent(fuelGet))).toMatchObject({ orders: [] });
    });
  });

  it("puts a failed R3 back (forced on request), not while the fuel writer, and with it the R3, is off", async () => {
    mem.orders.push(order({ id: "e", status: "written", poNo: "PK1", h3No: "H31", r3Status: "error", r3Error: "อาจซ้ำ: R3691109-01 ..." }));
    mem.settings.set("express_masters", { ...raw({ writer: false }), at: new Date().toISOString() });
    expect(await answer(await post(retry, { id: "e", force: true }))).toMatchObject({ status: 200, notice: expect.stringContaining("ปิดอยู่ที่เครื่อง Office") });
    expect(row("e")).toMatchObject({ r3Status: "error", r3Error: expect.stringContaining("อาจซ้ำ") });
    mem.settings.set("express_masters", { ...raw(), at: new Date().toISOString() });
    mem.user.roles = ["accounting"]; // an R3 is accounting's to confirm too
    expect(await answer(await post(retry, { id: "e", force: true }))).toEqual({ status: 200, ok: true });
    expect(row("e")).toMatchObject({ status: "written", r3Status: "force", r3Error: null });
  });
});

describe("POST /api/express/repair-manual", () => {
  it("marks a costed repair without an order as keyed by hand, once", async () => {
    mem.repairs.push({ id: "r1", costedAt: new Date(), invoice: "IV9", costAmount: 500 }, { id: "r2", costedAt: null, invoice: "", costAmount: null });
    expect(await answer(await post(repairManual, { id: "r1" }))).toEqual({ status: 200, ok: true, manual: true });
    expect(mem.orders).toEqual([expect.objectContaining({ kind: "repair", repairRequestId: "r1", status: "manual", payload: { invoice: "IV9", amount: 500 } })]);
    expect((await post(repairManual, { id: "r1" })).status).toBe(400); // it has an order now
    expect((await post(repairManual, { id: "r2" })).status).toBe(400); // no cost saved
  });
});
