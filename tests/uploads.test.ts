import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST as report } from "@/app/api/repairs/route";
import { POST as quote } from "@/app/api/repairs/[id]/quote/route";
import { POST as cost } from "@/app/api/repairs/[id]/cost/route";
import { POST as sendLater } from "@/app/api/repairs/[id]/express/route";
import { POST as ask } from "@/app/api/fuel/route";
import { bkkDateKey, dateOnly } from "@/lib/time";

// The photo / file routes of the repair report, quotation and cost and of the fuel request (#46): a file saved for a
// write that is refused or fails is taken back, as no row shows it; one a save replaces is kept (the evidence that was
// reviewed). Also the repair's send-later route (/api/repairs/[id]/express), which works on the same repair.
// The database in memory: one repair and its Express order, the vehicles, the rows created and the AppSettings; where
// clauses with equality, Dates and { is } (the repair's order). meanwhile runs while a file is being saved, racing
// while an order is updated (another person acting); fail makes every write throw.
const mem = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const st = {
    repair: null as Row | null,
    orders: [] as Row[],
    settings: {} as Record<string, unknown>,
    vehicles: [] as Row[],
    saved: [] as string[],
    removed: [] as string[],
    meanwhile: null as (() => void) | null,
    racing: null as (() => void) | null,
    fail: false,
    created: [] as Row[],
  };
  const orderOf = (row: Row) => st.orders.find((o) => o.repairRequestId === row.id) ?? null;
  const matches = (row: Row, where: Row): boolean =>
    Object.entries(where).every(([k, v]) => {
      const value = k === "express" ? orderOf(row) : (row[k] ?? null);
      if (v instanceof Date) return value instanceof Date && value.getTime() === v.getTime();
      if (v !== null && typeof v === "object" && "is" in v) {
        const is = (v as { is: Row | null }).is;
        return is === null ? value === null : value !== null && matches(value as Row, is);
      }
      return value === v;
    });
  const boom = () => {
    if (st.fail) throw new Error("database down");
  };
  const repairRequest = {
    findUnique: async () => (st.repair ? { ...st.repair, express: orderOf(st.repair) } : null),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      boom();
      if (!st.repair || !matches(st.repair, where)) return { count: 0 };
      Object.assign(st.repair, data);
      return { count: 1 };
    },
    create: async ({ data }: { data: Row }) => {
      boom();
      st.created.push(data);
      return { id: "n1", no: 1, ...data };
    },
  };
  const expressOrder = {
    create: async ({ data }: { data: Row }) => void st.orders.push({ id: `o${st.orders.length + 1}`, status: "queued", error: null, ...data }),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      st.racing?.();
      const hit = st.orders.filter((o) => matches(o, where));
      for (const o of hit) Object.assign(o, data);
      return { count: hit.length };
    },
  };
  const appSetting = { findUnique: async ({ where }: { where: { key: string } }) => (where.key in st.settings ? { key: where.key, value: st.settings[where.key] } : null) };
  const fuelRequest = {
    create: async ({ data }: { data: Row }) => {
      boom();
      st.created.push(data);
      return { id: "f1", no: 2, ...data };
    },
  };
  const vehicle = {
    findFirst: async ({ where }: { where: Row }) => st.vehicles.find((v) => v.id === where.id && v.active) ?? null,
    findMany: async () => st.vehicles,
    upsert: async ({ create }: { create: Row }) => {
      const v = { id: "v9", active: true, ...create };
      st.vehicles.push(v);
      return v;
    },
  };
  const db = { repairRequest, expressOrder, appSetting, fuelRequest, vehicle, user: { update: async () => ({}) } };
  const prisma = {
    ...db,
    // a transaction that throws undoes its write to the repair (no route here writes an order before it throws)
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => {
      boom();
      const before = structuredClone(st.repair);
      try {
        return await fn(db);
      } catch (e) {
        st.repair = before;
        throw e;
      }
    },
  };
  return { st, prisma };
});

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/session", () => ({ apiUser: async () => ({ user: { id: "u1", name: "ผู้ใช้", rememberVehicleId: null } }) }));
vi.mock("@/lib/line", () => ({ appLink: (p: string) => p, notifyRoles: async () => true, notifyUsers: async () => true, notifyOfficeGroup: async () => true }));
vi.mock("@/lib/storage", () => {
  class UploadError extends Error {}
  return {
    UploadError,
    saveUpload: async (file: File, folder: string) => {
      if (file.name.endsWith(".gif")) throw new UploadError("ไฟล์ต้องเป็นรูป JPEG, PNG หรือ WebP");
      mem.st.meanwhile?.();
      const key = `${folder}/2026-11/new-${mem.st.saved.length + 1}.jpg`;
      mem.st.saved.push(key);
      return key;
    },
    removeUpload: async (key: string) => void mem.st.removed.push(key),
  };
});

beforeEach(() => {
  Object.assign(mem.st, {
    repair: null,
    orders: [],
    settings: {},
    vehicles: [{ id: "v1", code: "12-3456", model: "รถทดสอบ", active: true }],
    saved: [],
    removed: [],
    meanwhile: null,
    racing: null,
    fail: false,
    created: [],
  });
});

const jpeg = (name = "p.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
const post = (fields: [string, string | File][]) => {
  const fd = new FormData();
  for (const [k, v] of fields) fd.append(k, v);
  return new Request("http://localhost/x", { method: "POST", body: fd });
};
const params = { params: Promise.resolve({ id: "r1" }) };
const quotedAt = new Date("2026-11-20T03:00:00Z");

describe("repair report (openRepair)", () => {
  const send = (files: File[], vehicle: [string, string][] = [["vehicleId", "v1"]]) =>
    report(post([...vehicle, ["symptom", "เบรกไม่อยู่"], ["urgency", "normal"], ...files.map((f) => ["photos", f] as [string, File])]));
  it("keeps every photo of a stored report", async () => {
    expect((await send([jpeg(), jpeg()])).status).toBe(200);
    expect(mem.st.created[0].photos).toEqual(["repair/2026-11/new-1.jpg", "repair/2026-11/new-2.jpg"]);
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back the photos saved before a refused one", async () => {
    const res = await send([jpeg(), jpeg(), jpeg("x.gif")]);
    expect(res.status).toBe(400);
    expect(mem.st.removed).toEqual(["repair/2026-11/new-1.jpg", "repair/2026-11/new-2.jpg"]);
    expect(mem.st.created).toEqual([]);
  });
  it("takes back every photo when the report cannot be stored", async () => {
    mem.st.fail = true;
    await expect(send([jpeg(), jpeg()])).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["repair/2026-11/new-1.jpg", "repair/2026-11/new-2.jpg"]);
  });
  it("matches a typed plate to the listed vehicle ignoring spaces, dots and dashes (plateKey)", async () => {
    expect((await send([jpeg()], [["vehicleId", "new"], ["newCode", "12 3456"], ["newModel", "x"]])).status).toBe(200);
    expect(mem.st.created[0].vehicleId).toBe("v1");
    expect(mem.st.vehicles).toHaveLength(1);
    expect((await send([jpeg()], [["vehicleId", "new"], ["newCode", "12.34-56"], ["newModel", "x"]])).status).toBe(200);
    expect(mem.st.created[1].vehicleId).toBe("v1");
    expect((await send([jpeg()], [["vehicleId", "new"], ["newCode", "12-3457"], ["newModel", "x"]])).status).toBe(200);
    expect(mem.st.created[2].vehicleId).toBe("v9");
  });
});

describe("fuel request (requestFuel)", () => {
  const send = (extra: [string, string | File][]) => ask(post([["vehicleId", "v1"], ["engineHours", "1000"], ["photo", jpeg()], ...extra]));
  it("keeps both photos of a stored request", async () => {
    expect((await send([["odometer", "5000"], ["odoPhoto", jpeg()]])).status).toBe(200);
    expect(mem.st.created[0]).toMatchObject({ dashPhoto: "fuel-dash/2026-11/new-1.jpg", odoPhoto: "fuel-dash/2026-11/new-2.jpg" });
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back the dashboard photo when the odometer photo is refused", async () => {
    expect((await send([["odometer", "5000"], ["odoPhoto", jpeg("o.gif")]])).status).toBe(400);
    expect(mem.st.removed).toEqual(["fuel-dash/2026-11/new-1.jpg"]);
  });
  it("takes back both photos when the request cannot be stored, the one when there is no odometer", async () => {
    mem.st.fail = true;
    await expect(send([["odometer", "5000"], ["odoPhoto", jpeg()]])).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["fuel-dash/2026-11/new-1.jpg", "fuel-dash/2026-11/new-2.jpg"]);
    mem.st.removed = [];
    await expect(send([])).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["fuel-dash/2026-11/new-3.jpg", ""]); // "" = no odometer photo, ignored by removeUpload
  });
});

describe("quotation", () => {
  const send = (files: File[], seen = "") =>
    quote(post([["quoteAmount", "5000"], ["seen", seen], ...files.map((f) => ["quoteFiles", f] as [string, File])]), params);
  beforeEach(() => void (mem.st.repair = { id: "r1", no: 3, status: "quote", symptom: "s", quoteAmount: null, quotedAt: null, vehicle: { code: "12-3456" } }));
  it("keeps the files of a stored quotation", async () => {
    expect((await send([jpeg()])).status).toBe(200);
    expect(mem.st.repair!.quoteFiles).toEqual(["repair-quote/2026-11/new-1.jpg"]);
    expect(mem.st.removed).toEqual([]);
  });
  it("keeps the files of the quotation a new one replaces (the one the executive decided on)", async () => {
    Object.assign(mem.st.repair!, { status: "rejected", quoteAmount: 4000, quotedAt, quoteFiles: ["repair-quote/2026-11/old.jpg"] });
    expect((await send([jpeg()], quotedAt.toISOString())).status).toBe(200);
    expect(mem.st.repair).toMatchObject({ status: "approval", quoteFiles: ["repair-quote/2026-11/new-1.jpg"] });
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back the files of a quotation refused because the repair changed meanwhile", async () => {
    mem.st.meanwhile = () => void (mem.st.repair!.status = "approval");
    expect((await send([jpeg(), jpeg()])).status).toBe(400);
    expect(mem.st.removed).toEqual(["repair-quote/2026-11/new-1.jpg", "repair-quote/2026-11/new-2.jpg"]);
  });
  it("takes back the files saved before a refused one, and on a failed save", async () => {
    expect((await send([jpeg(), jpeg("x.gif")])).status).toBe(400);
    expect(mem.st.removed).toEqual(["repair-quote/2026-11/new-1.jpg"]);
    mem.st.removed = [];
    mem.st.fail = true;
    await expect(send([jpeg()])).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["repair-quote/2026-11/new-2.jpg"]);
  });
});

describe("repair cost", () => {
  const send = (files: File[]) =>
    cost(post([["costAmount", "1000"], ["invoiceDate", bkkDateKey()], ...files.map((f) => ["billFiles", f] as [string, File])]), params);
  beforeEach(
    () =>
      void (mem.st.repair = {
        id: "r1",
        no: 3,
        status: "approved",
        symptom: "s",
        driverId: "d1",
        quoteAmount: 1000,
        quotedAt,
        vehicle: { code: "12-3456", expressDep: "", expressItem: "" },
      })
  );
  it("keeps the bills of a stored cost", async () => {
    const res = await send([jpeg()]);
    expect(res.status).toBe(200);
    expect(mem.st.repair!.billFiles).toEqual(["repair-bill/2026-11/new-1.jpg"]);
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back the bills of a cost refused because a re-quote was approved meanwhile", async () => {
    mem.st.meanwhile = () => void (mem.st.repair!.quotedAt = new Date());
    expect((await send([jpeg(), jpeg()])).status).toBe(400);
    expect(mem.st.repair!.status).toBe("approved");
    expect(mem.st.removed).toEqual(["repair-bill/2026-11/new-1.jpg", "repair-bill/2026-11/new-2.jpg"]);
  });
  it("takes back the bills saved before a refused one, and on a failed save", async () => {
    expect((await send([jpeg(), jpeg("x.gif")])).status).toBe(400);
    expect(mem.st.removed).toEqual(["repair-bill/2026-11/new-1.jpg"]);
    mem.st.removed = [];
    mem.st.fail = true;
    await expect(send([jpeg()])).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["repair-bill/2026-11/new-2.jpg"]);
  });
});

describe("repair sent to Express later (/api/repairs/[id]/express)", () => {
  const today = bkkDateKey();
  // as the office PC sends them: a garage with a usable tax ID and one without, the vehicle's fuel item (its department)
  const masters = {
    fuel: { suppliers: [], items: [{ code: "140 SY", desc: "น้ำมัน SY140", depCode: "03", depName: "ขนส่ง", stock: false, vatClaim: true }], writer: true },
    repair: {
      suppliers: [
        { code: "อ001", name: "อู่ช่างเอก", vat: true },
        { code: "ร002", name: "ร้านยางเล็ก", vat: false },
      ],
      items: [{ code: "SV-REPAIR", desc: "ค่าซ่อม", depCode: "09", depName: "", stock: false, vatClaim: true }],
      writer: true,
    },
    at: new Date().toISOString(),
  };
  const bill = { supplierCode: "ร002", itemCode: "SV-REPAIR", invoice: "IV201", invoiceDate: today, vatMode: "0" };
  const send = (o: Partial<typeof bill> = {}) => sendLater(post(Object.entries({ ...bill, ...o })), params);
  // what the office PC answered for a bill queued as VAT 1 from a garage that has no usable tax ID (any more)
  const failed = () => ({
    id: "o1",
    kind: "repair",
    repairRequestId: "r1",
    status: "error",
    error: 'ร002 ไม่มีเลขประจำตัวผู้เสียภาษีใน Express (บิลไม่ใช่ใบกำกับภาษี): เลือก "ไม่มี VAT" หรือคีย์ PO / RR ใน Express เอง',
    payload: { supplier: "ร002", vat: "1", invoice: "IV200", amount: 1070 },
  });
  beforeEach(() => {
    mem.st.settings = { express_masters: masters };
    mem.st.repair = {
      id: "r1",
      no: 3,
      status: "repairing",
      symptom: "เบรกไม่อยู่",
      costAmount: 1070,
      costDetail: "เปลี่ยนผ้าเบรก",
      costedAt: quotedAt,
      supplierCode: "ร002",
      supplierName: "ร้านยางเล็ก",
      itemCode: "SV-REPAIR",
      invoice: "IV200",
      invoiceDate: null,
      vehicle: { code: "12-3456", expressDep: "", expressItem: "140 SY" },
    };
  });

  it("queues a costed repair without an order", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: true });
    expect(mem.st.orders).toMatchObject([{ kind: "repair", repairRequestId: "r1", status: "queued", payload: { supplier: "ร002", vat: "0", invoice: "IV201", date: today } }]);
  });
  it("replaces the repair's failed order with the bill sent again, and saves the bill on the repair", async () => {
    mem.st.orders = [failed()];
    const res = await send();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ queued: true });
    expect(mem.st.orders).toHaveLength(1);
    expect(mem.st.orders[0]).toMatchObject({ id: "o1", status: "queued", error: null, payload: { supplier: "ร002", vat: "0", invoice: "IV201", date: today, amount: 1070, dep: "03" } });
    expect(mem.st.repair).toMatchObject({ invoice: "IV201", invoiceDate: dateOnly(today) });
  });
  it("keeps the failed order as it was when the bill still cannot be booked, and says why", async () => {
    mem.st.orders = [failed()];
    mem.st.repair!.vehicle = { code: "12-3456", expressDep: "", expressItem: "" };
    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).notice).toMatch(/ยังส่งเข้า Express ไม่ได้: รถคันนี้ยังไม่ได้ตั้งแผนก Express/);
    expect(mem.st.orders[0]).toMatchObject({ status: "error", payload: failed().payload });
    expect(mem.st.repair!.invoice).toBe("IV201"); // the bill typed is kept, as for a repair without an order
  });
  it("refuses a repair whose order is queued, written, keyed by hand or cancelled", async () => {
    for (const status of ["queued", "written", "manual", "cancelled"]) {
      mem.st.orders = [{ ...failed(), status }];
      expect((await send()).status).toBe(400);
      expect(mem.st.orders[0]).toMatchObject({ status, payload: failed().payload });
      expect(mem.st.repair!.invoice).toBe("IV200");
    }
  });
  it("changes nothing when the failed order was retried or settled meanwhile", async () => {
    mem.st.orders = [failed()];
    mem.st.racing = () => void (mem.st.orders[0].status = "queued"); // ลองใหม่ on /office/express in between
    const res = await send();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/ถูกเปลี่ยนไปแล้ว/);
    expect(mem.st.orders[0]).toMatchObject({ status: "queued", payload: failed().payload });
    expect(mem.st.repair).toMatchObject({ invoice: "IV200", invoiceDate: null });
  });
});
