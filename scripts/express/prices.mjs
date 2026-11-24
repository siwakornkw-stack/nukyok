// Purchase prices for the web's เทียบราคา page (จัดซื้อ), read-only: every item line received from a
// supplier since `since` (STCRD: POSOPR "0", PEOPLE = the supplier) on a purchase bill of that supplier
// that is not cancelled (APTRN: RR ซื้อเชื่อ, PE, H3 ซื้อด้วยบัตร ...), of an item purchasing buys (below).
// Left out too: fuel (items of the PP / PK fuel books, bought by the fillers) and the R3 card settlements
// (their lines name the card holder as supplier). Each supplier in them comes with its APMAS details.
// Pure: takes parsed rows.
const round = (n, d = 2) => Math.round((Number(n) || 0) * 10 ** d) / 10 ** d;

// Items purchasing buys: real stock items, and of the service items that stand for an account of DHEWA66's
// chart ("5360-08") only job costs 5110, office supplies 5302, services and rent 5320, utilities 5330,
// repairs / parts 5360 and tools / equipment 1203, 122x, without their lease down payments, wages,
// contractor pay, refunds, legal fees, foreign-worker costs, damages and commissions. Never payroll, staff
// costs, loans, advances, cash, deposits or taxes: the bills (RR, PE, SA) hold those with staff names.
// Twin: purchaseItem in src/lib/prices.ts.
export const purchaseItem = (code) =>
  !/^\d{4}-\d{2}/.test(code) ||
  (/^(5110|5302|5320|5330|5360|1203|122\d)-/.test(code) && !/^(5110-0[29]|5110-12|5320-04|5320-1[247]|5320-18\.)/.test(code));

export function buildPrices({ stcrd, aptrn, apmas, stmas, poprit, istab }, { since }) {
  const bills = new Map(aptrn.filter((a) => a.DOCSTAT !== "C").map((a) => [a.DOCNUM, a]));
  const fuel = new Set(poprit.filter((l) => /^(PP|PK)/.test(l.PONUM)).map((l) => l.STKCOD));
  const units = new Map(istab.filter((t) => t.TABTYP === "20").map((t) => [t.TYPCOD, t.SHORTNAM || t.TYPDES]));
  const names = new Map(stmas.map((s) => [s.STKCOD, s.STKDES]));
  const lines = [];
  for (const l of stcrd) {
    const b = bills.get(l.DOCNUM);
    if (!b || l.POSOPR !== "0" || !l.PEOPLE || b.SUPCOD !== l.PEOPLE || l.DOCNUM.startsWith("R3")) continue;
    if (!l.DOCDAT || l.DOCDAT < since || fuel.has(l.STKCOD) || !purchaseItem(l.STKCOD) || !(l.TRNQTY > 0) || !(l.NETVAL > 0)) continue;
    lines.push({
      date: l.DOCDAT,
      doc: l.DOCNUM,
      sup: l.PEOPLE,
      item: l.STKCOD,
      desc: l.STKDES,
      qty: l.TRNQTY,
      unit: units.get(l.TQUCOD) || l.TQUCOD,
      price: round(l.UNITPR, 4), // as keyed: VAT included when the bill's FLGVAT is 1
      net: round(l.NETVAL), // the line before VAT
      vat: b.FLGVAT,
    });
  }
  const items = Object.fromEntries([...new Set(lines.map((l) => l.item))].map((c) => [c, names.get(c) || ""]));
  const used = new Set(lines.map((l) => l.sup));
  const suppliers = apmas
    .filter((s) => used.has(s.SUPCOD))
    .map((s) => ({
      code: s.SUPCOD,
      name: `${s.PRENAM} ${s.SUPNAM}`.trim(),
      address: [s.ADDR01, s.ADDR02, s.ADDR03].filter(Boolean).join(" "),
      zip: s.ZIPCOD || "",
      phone: s.TELNUM || "",
      taxId: s.TAXID || "",
      branch: s.ORGNUM ? String(s.ORGNUM) : "",
      remark: s.REMARK || "",
      vat: s.FLGVAT || "",
    }));
  return { since, lines, items, suppliers };
}
