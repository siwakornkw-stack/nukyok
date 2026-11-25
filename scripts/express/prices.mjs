// Purchase prices for the web's เทียบราคา page (จัดซื้อ), read-only: every item line received from a
// supplier since `since` (STCRD: POSOPR "0", PEOPLE = the supplier) on a purchase bill of that supplier
// that is not cancelled (APTRN: RR ซื้อเชื่อ, PE, H3 ซื้อด้วยบัตร ...), of an item purchasing buys (below).
// Left out too: fuel (items of the PP / PK fuel books, bought by the fillers), the R3 card settlements
// (their lines name the card holder as supplier), staff and the service wages of private persons (below).
// Each supplier in them comes with its APMAS details, a private person with the name only.
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

// Lines only people the company pays have (DHEWA66's chart): salaries, wages, overtime, bonuses and welfare
// 5301, 5310, 5110-09 / -12, loans to directors and staff 1150, salary paid in advance 1161-05, petty cash
// 1111-1x, payroll liabilities 2131-03 / -06 / -10 / -12, 2132-01 (PND 1 tax), 2110-03 (student loans).
// A supplier with one on any bill, of any date, is staff: left out with all its lines, unless it is a company
// (its staff-type lines are not purchases anyway). Twin: staffItem in src/lib/prices.ts.
export const staffItem = (code) => /^(5301|5310|5110-09|5110-12|1150|1161-05|1111-1|2131-(03|06|10|12)|2132-01|2110-03)/.test(code);

// Personal titles as keyed in APMAS (PRENAM, or the start of SUPNAM).
const TITLE = /^(นาย|นาง|น\.ส\.|คุณ|(mr|mrs|ms|miss)[.\s])/i;
// A private person: a 13-digit ID that is neither a company's (below) nor the zeros keyed for "unknown" (so a
// non-Thai person's "00..." too), or a personal title. Their tax ID, address, phone and remark never leave
// Express, nor their service wages (5110-05 ค่าจ้างบริการ: wages, overtime, advances). Twin: person in src/lib/prices.ts.
export const person = (taxId, name) => (/^\d{13}$/.test(taxId) && !/^(0[1-9]|0+$)/.test(taxId)) || TITLE.test(name);
// A company (juristic person, partnership, state body): a tax ID of 0 and a province / type digit
// ("0000000000000" is keyed for "unknown", "00..." are non-Thai persons) and no personal title.
// Twin: company in src/lib/prices.ts.
export const company = (taxId, name) => /^0[1-9]\d{11}$/.test(taxId) && !TITLE.test(name);

export function buildPrices({ stcrd, aptrn, apmas, stmas, poprit, istab }, { since }) {
  const bills = new Map(aptrn.filter((a) => a.DOCSTAT !== "C").map((a) => [a.DOCNUM, a]));
  const fuel = new Set(poprit.filter((l) => /^(PP|PK)/.test(l.PONUM)).map((l) => l.STKCOD));
  const units = new Map(istab.filter((t) => t.TABTYP === "20").map((t) => [t.TYPCOD, t.SHORTNAM || t.TYPDES]));
  const names = new Map(stmas.map((s) => [s.STKCOD, s.STKDES]));
  const sups = new Map(apmas.map((s) => [s.SUPCOD, s]));
  const nameOf = (s) => `${s.PRENAM} ${s.SUPNAM}`.trim();
  const is = (f, code) => {
    const s = sups.get(code);
    return !!s && f(s.TAXID || "", nameOf(s));
  };
  const staff = new Set();
  const lines = [];
  for (const l of stcrd) {
    const b = bills.get(l.DOCNUM);
    if (!b || l.POSOPR !== "0" || !l.PEOPLE || b.SUPCOD !== l.PEOPLE || l.DOCNUM.startsWith("R3")) continue;
    if (staffItem(l.STKCOD) && !is(company, l.PEOPLE)) staff.add(l.PEOPLE);
    if (!l.DOCDAT || l.DOCDAT < since || fuel.has(l.STKCOD) || !purchaseItem(l.STKCOD) || !(l.TRNQTY > 0) || !(l.NETVAL > 0)) continue;
    if (l.STKCOD.startsWith("5110-05") && (!sups.has(l.PEOPLE) || is(person, l.PEOPLE))) continue; // nobody can tell an unknown supplier is not a person
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
  const kept = lines.filter((l) => !staff.has(l.sup));
  const items = Object.fromEntries([...new Set(kept.map((l) => l.item))].map((c) => [c, names.get(c) || ""]));
  const used = new Set(kept.map((l) => l.sup));
  const suppliers = apmas
    .filter((s) => used.has(s.SUPCOD))
    .map((s) => {
      const open = !person(s.TAXID || "", nameOf(s));
      return {
        code: s.SUPCOD,
        name: nameOf(s),
        address: open ? [s.ADDR01, s.ADDR02, s.ADDR03].filter(Boolean).join(" ") : "",
        zip: open ? s.ZIPCOD || "" : "",
        phone: open ? s.TELNUM || "" : "",
        taxId: open ? s.TAXID || "" : "",
        branch: s.ORGNUM ? String(s.ORGNUM) : "",
        remark: open ? s.REMARK || "" : "",
        vat: s.FLGVAT || "",
      };
    });
  return { since, lines: kept, items, suppliers };
}
