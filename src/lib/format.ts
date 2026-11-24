// Prisma Decimal (or null) -> number (or null). Use at every JSON / UI boundary.
export const dec = (v: { toString(): string } | number | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

export const baht = (v: { toString(): string } | number | null | undefined) => {
  const n = dec(v);
  return n === null ? "-" : n.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Who drove: the name typed on the form, plus the account that sent it when that is someone else.
export const driverOf = (r: { driverName: string; driver: { name: string } }) => (r.driverName ? `${r.driverName} (ส่งโดย ${r.driver.name})` : r.driver.name);

export const num = (v:{ toString(): string } | number | null | undefined, digits = 1) => {
  const n = dec(v);
  return n === null ? "-" : n.toLocaleString("th-TH", { maximumFractionDigits: digits });
};
