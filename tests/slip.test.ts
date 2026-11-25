import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSlip, slipFlags, type SlipRead } from "@/lib/fuel-checks";
import { POST as sendSlip } from "@/app/api/fuel/[id]/slip/route";
import { POST as fill } from "@/app/api/fuel/[id]/fill/route";
import FillerRequestPage from "@/app/(app)/filler/[id]/page";
import { bkkDateKey } from "@/lib/time";

// For the slip and fill routes and the filler's form: one fuel request in memory, and the photo files the routes save
// and take back. meanwhile runs while a photo is being saved (another phone or person acting), reading while the AI
// reads the slip.
const mem = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  const st = {
    row: null as Row | null,
    saved: [] as string[],
    removed: [] as string[],
    meanwhile: null as (() => void) | null,
    reading: null as (() => void) | null,
    fail: false, // the database write throws
  };
  const fits = (row: Row, where: Row) =>
    Object.entries(where).every(([k, v]) => {
      const set = v !== null && typeof v === "object" ? (v as { in: unknown[] }).in : null;
      return set ? set.includes(row[k]) : (row[k] ?? null) === v;
    });
  const fuelRequest = {
    findUnique: async ({ where }: { where: { id: string } }) => (st.row?.id === where.id ? { ...st.row } : null),
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      if (st.fail) throw new Error("database down");
      if (!st.row || !fits(st.row, where)) return { count: 0 };
      Object.assign(st.row, data);
      return { count: 1 };
    },
  };
  return { st, prisma: { fuelRequest } };
});

vi.mock("@/lib/db", () => ({ prisma: mem.prisma }));
vi.mock("@/lib/session", () => ({
  apiUser: async () => ({ user: { id: "f1", name: "คนเติม" } }),
  requirePage: async () => ({ id: "f1", name: "คนเติม", roles: ["filler"] }),
}));
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
    readUpload: async () => ({ body: Buffer.from("jpeg"), type: "image/jpeg" }),
  };
});
vi.mock("@/lib/slip", () => ({ readSlip: async () => (mem.st.reading?.(), { read: null, note: "" }) }));
vi.mock("@/lib/line", () => ({ notifyOfficeGroup: async () => true }));
vi.mock("@/lib/express", () => ({ getMasters: async () => null }));
vi.mock("@/lib/actions", () => ({ checkFill: async () => [], fillOf: () => ({}), fuelAlertText: () => "", recheckNext: async () => {} }));

beforeEach(() => {
  Object.assign(mem.st, { row: null, saved: [], removed: [], meanwhile: null, reading: null, fail: false });
});

// A made-up replacement slip (synthetic values, laid out like a station's tax invoice).
const answer = {
  invoice: "ต26010100000102",
  replaces: "ต26010100000101",
  date: "2026-01-15",
  plate: "12-3456 สงขลา",
  liters: "50.125",
  pricePerLiter: "39.90",
  amount: "2,000.00",
  station: "บริษัท ตัวอย่างปิโตรเลียม จำกัด 00001-สาขาตัวอย่าง",
  sellerTaxId: "0-9999-99999-99-2",
  buyerTaxId: "0999999999995",
};
const read = parseSlip(JSON.stringify(answer)) as SlipRead;
const typed = {
  liters: 50.125,
  pricePerLiter: 39.9,
  amount: 2000,
  invoice: "ต26010100000102",
  invoiceDate: "2026-01-15",
  vehicleCode: "12-3456",
  date: "2026-01-15",
  companyTaxId: "0999999999995",
  supplierTaxId: "0999999999992",
};

describe("parseSlip", () => {
  it("reads numbers with commas, keeps every decimal and the tax IDs' digits", () => {
    expect(read).toMatchObject({ liters: 50.125, pricePerLiter: 39.9, amount: 2000, invoice: "ต26010100000102", sellerTaxId: "0999999999992", buyerTaxId: "0999999999995" });
  });
  it("turns a Buddhist-era year into a Gregorian one", () => {
    expect(parseSlip(JSON.stringify({ ...answer, date: "2569-01-15" }))?.date).toBe("2026-01-15");
  });
  it("drops what is not a number or a date", () => {
    expect(parseSlip(JSON.stringify({ ...answer, liters: "", amount: "abc", date: "15/01/2026" }))).toMatchObject({ liters: null, amount: null, date: "" });
  });
  it("drops a date that does not exist, so it is never offered as the invoice date", () => {
    expect(parseSlip(JSON.stringify({ ...answer, date: "2026-02-30" }))?.date).toBe("");
    expect(parseSlip(JSON.stringify({ ...answer, date: "2569-02-30" }))?.date).toBe("");
    expect(parseSlip(JSON.stringify({ ...answer, date: "2026-13-01" }))?.date).toBe("");
    // 29 February of a leap year (2571 is 2028), the rest of the reading kept
    expect(parseSlip(JSON.stringify({ ...answer, date: "2571-02-29" }))).toMatchObject({ date: "2028-02-29", amount: 2000 });
  });
  it("is null for non-JSON, an array or an answer with nothing a slip holds", () => {
    expect(parseSlip("not json")).toBeNull();
    expect(parseSlip("[]")).toBeNull();
    expect(parseSlip(JSON.stringify({ station: "x" }))).toBeNull();
  });
});

describe("slipFlags", () => {
  const codes = (x: Partial<typeof typed>, r: SlipRead | null = read) => slipFlags(r, { ...typed, ...x }).map((f) => f.code);

  it("only notes the replacement when everything matches", () => {
    expect(codes({})).toEqual(["slip_replaces"]);
  });
  it("matches a plate with its province and an invoice typed without the Thai prefix", () => {
    expect(codes({ vehicleCode: "12 3456", invoice: "26010100000102" })).toEqual(["slip_replaces"]);
  });
  it("tolerates litres rounded to 2 decimals", () => {
    expect(codes({ liters: 50.13 })).toEqual(["slip_replaces"]);
  });
  it("flags each number, the invoice, the plate and the slip date that differ", () => {
    expect(codes({ liters: 60, pricePerLiter: 40, amount: 2400, invoice: "ต26010100000101", vehicleCode: "12-9999", invoiceDate: "2026-01-16", date: "2026-01-16" })).toEqual([
      "slip_liters",
      "slip_price",
      "slip_amount",
      "slip_invoice",
      "slip_plate",
      "slip_date",
      "slip_replaces",
    ]);
  });
  it("flags an invoice date that is not the fill date, with or without a reading", () => {
    expect(codes({ date: "2026-01-16" })).toEqual(["invoice_date", "slip_replaces"]);
    expect(codes({ date: "2026-01-16" }, null)).toEqual(["invoice_date"]);
    // a central-tank fill has no invoice date
    expect(codes({ invoiceDate: "", date: "2026-01-16" }, null)).toEqual([]);
    expect(slipFlags(null, { ...typed, invoiceDate: "2026-01-15", date: "2026-01-16" })[0].text).toBe("วันที่ในใบกำกับ 15/01/2026 ไม่ใช่วันที่เติม 16/01/2026");
  });
  it("flags a buyer that is not the company and a seller that is not the pump picked", () => {
    expect(codes({ companyTaxId: "0999999999993" })).toEqual(["slip_buyer", "slip_replaces"]);
    expect(codes({ supplierTaxId: "0999999999994" })).toEqual(["slip_seller", "slip_replaces"]);
  });
  it("does not compare a tax ID nobody knows", () => {
    expect(codes({ companyTaxId: "", supplierTaxId: "" })).toEqual(["slip_replaces"]);
    expect(codes({ supplierTaxId: "0999999999994" }, { ...read, sellerTaxId: "", buyerTaxId: "" })).toEqual(["slip_replaces"]);
    // a reading saved before the seller's tax ID was read
    const old = { ...read } as Partial<SlipRead>;
    delete old.sellerTaxId;
    expect(codes({ supplierTaxId: "0999999999994" }, old as SlipRead)).toEqual(["slip_replaces"]);
  });
  it("checks nothing but the dates without a reading", () => {
    expect(codes({ liters: 999, companyTaxId: "0999999999993" }, null)).toEqual([]);
  });
});

// A photo saved for a write that is refused or fails is taken back: no request shows it (#46). One a save replaces is
// kept: the slip and dashboard photo of a returned fill are the evidence Office reviewed.
const OLD_SLIP = "fuel-slip/2026-11/old.jpg";
const OLD_DASH = "fuel-dash/2026-11/old.jpg";
const jpeg = (name = "photo.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff])], name, { type: "image/jpeg" });
const post = (path: string, fields: Record<string, string | File>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return new Request(`http://localhost${path}`, { method: "POST", body: fd });
};
const params = { params: Promise.resolve({ id: "r1" }) };

describe("POST /api/fuel/[id]/slip: slip files", () => {
  const send = () => sendSlip(post("/api/fuel/r1/slip", { slip: jpeg() }), params);

  it("keeps the new slip and the one it replaced", async () => {
    mem.st.row = { id: "r1", status: "returned", slipPhoto: OLD_SLIP };
    const res = await send();
    expect(res.status).toBe(200);
    expect((await res.json()).key).toBe("fuel-slip/2026-11/new-1.jpg");
    expect(mem.st.row.slipPhoto).toBe("fuel-slip/2026-11/new-1.jpg");
    expect(mem.st.removed).toEqual([]);
  });
  it("removes nothing for the request's first slip", async () => {
    mem.st.row = { id: "r1", status: "waiting", slipPhoto: null };
    expect((await send()).status).toBe(200);
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back a slip refused because another phone's came first, and keeps that one", async () => {
    mem.st.row = { id: "r1", status: "waiting", slipPhoto: null };
    mem.st.meanwhile = () => void (mem.st.row!.slipPhoto = "fuel-slip/2026-11/other.jpg");
    expect((await send()).status).toBe(400);
    expect(mem.st.row.slipPhoto).toBe("fuel-slip/2026-11/other.jpg");
    expect(mem.st.removed).toEqual(["fuel-slip/2026-11/new-1.jpg"]);
  });
  it("takes back a slip for a request no longer being filled, and keeps the slip it holds", async () => {
    mem.st.row = { id: "r1", status: "waiting", slipPhoto: OLD_SLIP };
    mem.st.meanwhile = () => void (mem.st.row!.status = "filled");
    expect((await send()).status).toBe(400);
    expect(mem.st.row.slipPhoto).toBe(OLD_SLIP);
    expect(mem.st.removed).toEqual(["fuel-slip/2026-11/new-1.jpg"]);
  });
  it("takes back a slip whose save fails", async () => {
    mem.st.row = { id: "r1", status: "waiting", slipPhoto: OLD_SLIP };
    mem.st.fail = true;
    await expect(send()).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["fuel-slip/2026-11/new-1.jpg"]);
  });
  it("keeps a slip replaced while the AI read it, and the one it had replaced", async () => {
    mem.st.row = { id: "r1", status: "waiting", slipPhoto: OLD_SLIP };
    mem.st.reading = () => void (mem.st.row!.slipPhoto = "fuel-slip/2026-11/other.jpg");
    const res = await send();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/มีการส่งรูปสลิปอื่นแทนแล้ว/);
    // new-1 was saved on the request (then replaced by the other phone's), so it is no orphan
    expect(mem.st.row.slipPhoto).toBe("fuel-slip/2026-11/other.jpg");
    expect(mem.st.removed).toEqual([]);
  });
});

describe("POST /api/fuel/[id]/fill: slip and dashboard photo files", () => {
  // a pump fill Office returned, with its slip and dashboard photo
  const returned = () => ({
    id: "r1",
    no: 7,
    vehicleId: "v1",
    vehicle: { code: "12-3456" },
    status: "returned",
    driverOdometer: null,
    filledAt: new Date(),
    slipRead: null,
    slipPhoto: OLD_SLIP,
    fillDashPhoto: OLD_DASH,
  });
  const save = (files: Record<string, string | File>) =>
    fill(
      post("/api/fuel/r1/fill", {
        engineHours: "1010",
        liters: "50",
        pricePerLiter: "40",
        amount: "2000",
        source: "pump",
        supplierName: "ปั๊มตัวอย่าง",
        invoice: "IV0001",
        invoiceDate: bkkDateKey(),
        ...files,
      }),
      params
    );

  it("keeps the new slip and dashboard photo and the ones they replaced (the evidence Office reviewed)", async () => {
    mem.st.row = returned();
    expect((await save({ slip: jpeg(), fillDash: jpeg() })).status).toBe(200);
    expect(mem.st.row).toMatchObject({ status: "filled", slipPhoto: "fuel-slip/2026-11/new-1.jpg", fillDashPhoto: "fuel-dash/2026-11/new-2.jpg" });
    expect(mem.st.removed).toEqual([]);
  });
  it("removes nothing when no new photo is sent, nor when only the dashboard photo is new", async () => {
    mem.st.row = returned();
    expect((await save({ slipKey: OLD_SLIP })).status).toBe(200);
    expect(mem.st.row).toMatchObject({ slipPhoto: OLD_SLIP, fillDashPhoto: OLD_DASH });
    expect(mem.st.removed).toEqual([]);
    mem.st.row = returned();
    expect((await save({ slipKey: OLD_SLIP, fillDash: jpeg() })).status).toBe(200);
    expect(mem.st.row).toMatchObject({ slipPhoto: OLD_SLIP, fillDashPhoto: "fuel-dash/2026-11/new-1.jpg" });
    expect(mem.st.removed).toEqual([]);
  });
  it("takes back the new photos of a save refused because the request changed meanwhile, and keeps the old ones", async () => {
    mem.st.row = returned();
    mem.st.meanwhile = () => void (mem.st.row!.status = "cancelled");
    expect((await save({ slip: jpeg(), fillDash: jpeg() })).status).toBe(400);
    expect(mem.st.row).toMatchObject({ status: "cancelled", slipPhoto: OLD_SLIP, fillDashPhoto: OLD_DASH });
    expect(mem.st.removed).toEqual(["fuel-slip/2026-11/new-1.jpg", "fuel-dash/2026-11/new-2.jpg"]);
  });
  it("takes back the slip saved before a refused dashboard photo", async () => {
    mem.st.row = returned();
    const res = await save({ slip: jpeg(), fillDash: jpeg("dash.gif") });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/JPEG/);
    expect(mem.st.row.status).toBe("returned");
    expect(mem.st.removed).toEqual(["fuel-slip/2026-11/new-1.jpg"]);
  });
  it("takes back the new photo of a save that fails", async () => {
    mem.st.row = returned();
    mem.st.fail = true;
    await expect(save({ slipKey: OLD_SLIP, fillDash: jpeg() })).rejects.toThrow("database down");
    expect(mem.st.removed).toEqual(["fuel-dash/2026-11/new-1.jpg"]);
  });
});

describe("/filler/[id]: the invoice date the form starts with", () => {
  // a request as the page reads it: waiting, or a pump fill Office returned (saved before the invoice date was asked)
  const request = (o: Record<string, unknown>) => ({
    id: "r1",
    no: 7,
    status: "waiting",
    driver: { name: "คนขับ" },
    driverName: "",
    filler: null,
    vehicle: { code: "12-3456", model: "" },
    driverHours: 1000,
    engineHours: 1000,
    driverOdometer: null,
    odometer: null,
    createdAt: new Date("2026-11-03T01:00:00Z"),
    dashPhoto: "fuel-dash/2026-11/d.jpg",
    odoPhoto: null,
    fillDashPhoto: null,
    slipPhoto: null,
    slipRead: null,
    liters: null,
    pricePerLiter: null,
    amount: null,
    source: null,
    supplierCode: "",
    supplierName: "",
    invoice: "",
    invoiceDate: null,
    filledAt: null,
    returnNote: "",
    ...o,
  });
  // the defaultValue of the form's input of that name, found in the elements the page returns
  const field = (node: unknown, name: string): unknown => {
    if (Array.isArray(node)) {
      for (const n of node) {
        const v = field(n, name);
        if (v !== undefined) return v;
      }
      return undefined;
    }
    const props = (node as { props?: { name?: string; defaultValue?: unknown; children?: unknown } } | null)?.props;
    if (!props) return undefined;
    return props.name === name ? props.defaultValue : field(props.children, name);
  };
  const shown = async (o: Record<string, unknown>) => {
    mem.st.row = request(o);
    return field(await FillerRequestPage({ params: Promise.resolve({ id: "r1" }) }), "invoiceDate");
  };
  const returned = { status: "returned", source: "pump", filledAt: new Date("2026-11-03T20:00:00Z") }; // 04/11 03:00 in Bangkok

  it("is the Bangkok date a returned fill was filled when neither a saved date nor a slip reading has one", async () => {
    expect(await shown(returned)).toBe("2026-11-04");
  });
  it("is the saved date first, then the slip's date", async () => {
    expect(await shown({ ...returned, invoiceDate: new Date("2026-11-01T00:00:00Z"), slipRead: { ...read, date: "2026-11-02" } })).toBe("2026-11-01");
    expect(await shown({ ...returned, slipRead: { ...read, date: "2026-11-02" } })).toBe("2026-11-02");
  });
  it("is today for a request not filled yet", async () => {
    expect(await shown({})).toBe(bkkDateKey());
  });
});
