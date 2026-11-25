import "server-only";
import { z } from "zod";
import { prisma } from "./db";

// Purchase prices read from Express for จัดซื้อ's เทียบราคา page: two years of item lines bought from
// suppliers, with the suppliers' details, sent by the office PC with the masters whenever they change
// (scripts/express/prices.mjs). Read-only: nothing here goes back to Express.
const PRICES_KEY = "express_prices";

// Express pads some codes with a no-break space (0xA0 in windows-874): plain spaces here.
const plain = (s: string) => s.replace(/ /g, " ").trim();
const text = (max: number) => z.string().catch("").transform((s) => plain(s).slice(0, max));
const amount = z.number().finite().catch(0);
const line = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  doc: text(20),
  sup: text(10),
  item: text(25),
  desc: text(80),
  qty: amount,
  unit: text(20),
  price: amount, // as keyed (VAT included when vat is "1")
  net: amount, // the line before VAT
  vat: text(1),
});
const supplier = z.object({
  code: text(10),
  name: text(150),
  address: text(300),
  zip: text(10),
  phone: text(60),
  taxId: text(20),
  branch: text(10),
  remark: text(200),
  vat: text(1),
});
const pricesSchema = z.object({
  since: text(10),
  lines: z.array(line).max(200_000),
  items: z.record(z.string(), text(100)).transform((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [plain(k), v]))),
  suppliers: z.array(supplier).max(10_000),
});

export type PriceLine = z.infer<typeof line>;
export type PriceSupplier = z.infer<typeof supplier>;
export type Prices = z.infer<typeof pricesSchema> & { at: string };

// Items purchasing buys: real stock items, and of the service items that stand for an account of DHEWA66's
// chart ("5360-08") only job costs 5110, office supplies 5302, services and rent 5320, utilities 5330,
// repairs / parts 5360 and tools / equipment 1203, 122x, without their lease down payments, wages,
// contractor pay, refunds, legal fees, foreign-worker costs, damages and commissions. Never payroll, staff
// costs, loans, advances, cash, deposits or taxes. Twin of purchaseItem in scripts/express/prices.mjs, which
// leaves them out at the source; kept here too for an older agent.
export const purchaseItem = (code: string) =>
  !/^\d{4}-\d{2}/.test(code) ||
  (/^(5110|5302|5320|5330|5360|1203|122\d)-/.test(code) && !/^(5110-0[29]|5110-12|5320-04|5320-1[247]|5320-18\.)/.test(code));

// Lines only people the company pays have: a supplier with one is staff, left out with all its lines unless
// it is a company. Twin of staffItem in scripts/express/prices.mjs (the accounts are listed there).
export const staffItem = (code: string) => /^(5301|5310|5110-09|5110-12|1150|1161-05|1111-1|2131-(03|06|10|12)|2132-01|2110-03)/.test(code);

const TITLE = /^(นาย|นาง|น\.ส\.|คุณ|(mr|mrs|ms|miss)[.\s])/i;
// A private person: a 13-digit ID that is neither a company's nor the zeros keyed for "unknown", or a personal
// title. Name only, no service wages (5110-05). Twin of person in scripts/express/prices.mjs.
export const person = (taxId: string, name: string) => (/^\d{13}$/.test(taxId) && !/^(0[1-9]|0+$)/.test(taxId)) || TITLE.test(name);
// A company: a juristic tax ID (0 and a province / type digit) and no personal title. Twin of company in
// scripts/express/prices.mjs.
export const company = (taxId: string, name: string) => /^0[1-9]\d{11}$/.test(taxId) && !TITLE.test(name);

// What is kept of what the office PC sent (the agent applies the same rules at the source): items purchasing
// buys, service wages (5110-05) only of a supplier known not to be a private person (none of a value whose
// suppliers are missing), a private person by name only, with the suppliers and item names of those lines.
// Staff are told by their staff-type lines, which only an agent from before purchaseItem sends: later agents
// send none, so leaving staff out is the agent's job (an agent without staffItem still sends an employee's
// reimbursed purchases).
export function keepPrices(p: z.infer<typeof pricesSchema>) {
  const sups = new Map(p.suppliers.map((s) => [s.code, s]));
  const is = (f: typeof person, code: string) => {
    const s = sups.get(code);
    return !!s && f(s.taxId, s.name);
  };
  const staff = new Set(p.lines.filter((l) => staffItem(l.item) && !is(company, l.sup)).map((l) => l.sup));
  const lines = p.lines.filter((l) => purchaseItem(l.item) && !staff.has(l.sup) && !(l.item.startsWith("5110-05") && (!sups.has(l.sup) || is(person, l.sup))));
  const used = new Set(lines.map((l) => l.sup));
  const codes = new Set(lines.map((l) => l.item));
  return {
    since: p.since,
    lines,
    items: Object.fromEntries(Object.entries(p.items).filter(([code]) => codes.has(code))),
    suppliers: p.suppliers
      .filter((s) => used.has(s.code))
      .map((s) => (person(s.taxId, s.name) ? { ...s, address: "", zip: "", phone: "", taxId: "", remark: "" } : s)),
  };
}

// null = not the shape the office PC sends.
export async function savePrices(raw: unknown): Promise<number | null> {
  const p = pricesSchema.safeParse(raw);
  if (!p.success) return null;
  const value = { ...keepPrices(p.data), at: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: PRICES_KEY }, update: { value }, create: { key: PRICES_KEY, value } });
  return value.lines.length;
}

// ponytail: one JSON value read whole per search; a table with indexes if it ever grows past a few MB
// The rules run on reading too: a value saved before them keeps nothing they drop, whenever the next push comes.
export async function getPrices(): Promise<Prices | null> {
  const row = await prisma.appSetting.findUnique({ where: { key: PRICES_KEY } });
  const v = row?.value as Prices | undefined; // checked when saved
  return v ? { ...keepPrices(v), at: v.at } : null;
}

// Price per unit before VAT: what the item really cost the company (it claims the VAT back).
export const unitPrice = (l: PriceLine) => Math.round((l.net / l.qty) * 100) / 100;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");

// Lines whose item code, item name or line description hold every word of q (case and spacing ignored),
// newest first.
export function findLines(p: Pick<Prices, "lines" | "items">, q: string): PriceLine[] {
  const words = norm(q).split(" ").filter(Boolean);
  if (!words.length) return [];
  return p.lines
    .filter((l) => {
      const hay = norm(`${l.item} ${p.items[l.item] ?? ""} ${l.desc}`);
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.doc.localeCompare(a.doc));
}

// What was bought, as written on the bill line ("ยางใหม่ 215/70/15"), or the item name when the line has
// none: most lines use a service item that stands for an account ("5360-08"), so the line text is the product.
export const productOf = (l: PriceLine, items: Record<string, string>) => l.desc || items[l.item] || l.item;
// The same product written with other spacing or case is one product.
export const productKey = (label: string) => label.toLowerCase().replace(/\s+/g, "");

export type SupplierPrice = {
  product: string; // as on the latest bill line
  key: string; // productKey
  sup: string;
  unit: string;
  count: number; // bills
  qty: number;
  min: number;
  max: number;
  last: number;
  lastDate: string;
  lastDoc: string;
  cheapest: boolean; // the lowest latest price of its product and unit, among two or more suppliers
};

// One row per product, unit and supplier (a price per box does not compare with one per piece): how often it
// was bought and its lowest / highest / latest price per unit before VAT. The products bought most often come
// first; within a product and unit, the lowest latest price.
export function compareSuppliers(lines: PriceLine[], items: Record<string, string>): SupplierPrice[] {
  const rows = new Map<string, SupplierPrice>();
  const products = new Map<string, number>();
  const groups = new Map<string, number>(); // product + unit: lines
  const sellers = new Map<string, number>(); // product + unit: suppliers
  for (const l of [...lines].sort((a, b) => b.date.localeCompare(a.date))) {
    const product = productOf(l, items);
    const key = productKey(product);
    const group = `${key}\t${l.unit}`;
    products.set(key, (products.get(key) ?? 0) + 1);
    groups.set(group, (groups.get(group) ?? 0) + 1);
    const u = unitPrice(l);
    const r = rows.get(`${group}\t${l.sup}`);
    if (!r) {
      rows.set(`${group}\t${l.sup}`, { product, key, sup: l.sup, unit: l.unit, count: 1, qty: l.qty, min: u, max: u, last: u, lastDate: l.date, lastDoc: l.doc, cheapest: false });
      sellers.set(group, (sellers.get(group) ?? 0) + 1);
    } else {
      r.count++;
      r.qty += l.qty;
      r.min = Math.min(r.min, u);
      r.max = Math.max(r.max, u);
    }
  }
  const group = (r: SupplierPrice) => `${r.key}\t${r.unit}`;
  const out = [...rows.values()].sort(
    (a, b) =>
      products.get(b.key)! - products.get(a.key)! ||
      a.key.localeCompare(b.key) ||
      groups.get(group(b))! - groups.get(group(a))! ||
      a.unit.localeCompare(b.unit) ||
      a.last - b.last ||
      b.lastDate.localeCompare(a.lastDate)
  );
  // one pass (a search can match thousands of lines): the first row of a product and unit has its lowest latest price
  const seen = new Set<string>();
  for (const r of out) {
    const g = group(r);
    if (!seen.has(g)) r.cheapest = sellers.get(g)! > 1;
    seen.add(g);
  }
  return out;
}
