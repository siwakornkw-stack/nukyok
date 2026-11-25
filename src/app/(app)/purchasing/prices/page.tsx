import Link from "next/link";
import { requirePage } from "@/lib/session";
import { compareSuppliers, findLines, getPrices, productKey, productOf, unitPrice } from "@/lib/prices";
import { baht, num } from "@/lib/format";
import { bkkStart, thDate, thDateTime } from "@/lib/time";
import { Card, Empty, Info, Notice, PageHeader, Pill, Table, btnCls, chipCls, inputCls } from "@/components/ui";

const HISTORY = 100; // purchase lines listed under the comparison
const ROWS = 100; // comparison rows
const PRODUCTS = 30; // products offered to narrow a search
const SUPPLIER_VAT: Record<string, string> = { "0": "ไม่มี VAT", "1": "มี VAT", "2": "มี VAT" };

// เทียบราคา: what the company paid for an item, supplier by supplier, from the purchase bills in Express
// (the last two years, prices per unit before VAT), with each supplier's details from Express.
export default async function PricesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePage(["purchasing", "office", "accounting"]);
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const q = one("q").trim().slice(0, 60);
  const p = await getPrices();
  const found = p && q.length >= 2 ? findLines(p, q) : [];
  // the products found (as written on the bill lines), most bought first: picking one compares it alone
  const products = new Map<string, { label: string; count: number }>();
  for (const l of found) {
    const label = productOf(l, p!.items);
    const x = products.get(productKey(label));
    if (x) x.count++;
    else products.set(productKey(label), { label, count: 1 });
  }
  const list = [...products].sort((a, b) => b[1].count - a[1].count);
  const product = products.has(one("p")) ? one("p") : "";
  const lines = product ? found.filter((l) => productKey(productOf(l, p!.items)) === product) : found;
  const rows = p ? compareSuppliers(lines, p.items) : [];
  const sups = new Map((p?.suppliers ?? []).map((s) => [s.code, s]));
  const name = (code: string) => sups.get(code)?.name || code;
  const day = (key: string) => thDate(bkkStart(key));
  const link = (v: Record<string, string>) => `/purchasing/prices?${new URLSearchParams(Object.entries(v).filter(([, x]) => x))}`;

  return (
    <>
      <PageHeader title="เทียบราคา" back="/" />
      <Card>
        <form className="flex gap-2">
          <input name="q" defaultValue={q} required minLength={2} maxLength={60} placeholder="ชื่อสินค้า / รหัส / รายละเอียด เช่น ยาง 11R22.5" className={inputCls} />
          <button className={`${btnCls} shrink-0`}>ค้นหา</button>
        </form>
        {p && (
          <p className="mt-2 text-xs text-muted">
            ราคาที่ซื้อจริงใน Express ตั้งแต่ {day(p.since)} · ราคาต่อหน่วยไม่รวม VAT · อัปเดต {thDateTime(new Date(p.at))}
          </p>
        )}
      </Card>

      {!p && <Notice>ยังไม่มีข้อมูลราคาจาก Express: เครื่อง Office ยังไม่ได้ส่ง</Notice>}

      {p && q.length >= 2 && !found.length && (
        <Card>
          <Empty>ไม่พบการซื้อที่ตรงกับ &quot;{q}&quot; ลองคำที่สั้นลง หรือค้นด้วยรหัสสินค้า</Empty>
        </Card>
      )}

      {p && list.length > 1 && (
        <Card title={`สินค้าที่พบ ${list.length} รายการ`}>
          <div className="flex flex-wrap gap-2">
            <Link href={link({ q })} className={`${chipCls(!product)} max-w-full truncate`}>
              ทั้งหมด ({found.length})
            </Link>
            {list.slice(0, PRODUCTS).map(([key, x]) => (
              <Link key={key} href={link({ q, p: key })} className={`${chipCls(product === key)} max-w-full truncate`}>
                {x.label} ({x.count})
              </Link>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">
            ชื่อสินค้าตามที่เขียนในบิล{list.length > PRODUCTS ? ` แสดง ${PRODUCTS} รายการที่ซื้อบ่อย ค้นให้ละเอียดขึ้นเพื่อดูที่เหลือ` : ""}
          </p>
        </Card>
      )}

      {p && !!rows.length && (
        <>
          <Card title="ตารางเทียบราคา">
            <Table head={["สินค้า", "ผู้ขาย", "หน่วย", "ราคาล่าสุด", "ต่ำสุด", "สูงสุด", "ซื้อ (ครั้ง)", "ซื้อล่าสุด", "โทร"]}>
              {rows.slice(0, ROWS).map((r) => (
                <tr key={`${r.key}\t${r.unit}\t${r.sup}`}>
                  <td className="min-w-44 font-medium">{r.product}</td>
                  <td className="min-w-36">
                    <div className="font-semibold">{name(r.sup)}</div>
                    <div className="text-xs text-muted">{r.sup}</div>
                  </td>
                  <td className="whitespace-nowrap">{r.unit || "-"}</td>
                  <td className="whitespace-nowrap">
                    <span className="font-semibold">{baht(r.last)}</span> {r.cheapest && <Pill tone="green">ถูกสุด</Pill>}
                  </td>
                  <td className="whitespace-nowrap">{baht(r.min)}</td>
                  <td className="whitespace-nowrap">{baht(r.max)}</td>
                  <td>{r.count}</td>
                  <td className="whitespace-nowrap">
                    {day(r.lastDate)}
                    <div className="text-xs text-muted">{r.lastDoc}</div>
                  </td>
                  <td className="whitespace-nowrap">{sups.get(r.sup)?.phone || "-"}</td>
                </tr>
              ))}
            </Table>
            {rows.length > ROWS && <p className="mt-2 text-xs text-muted">แสดง {ROWS} แถวแรกจาก {rows.length} เลือกสินค้าด้านบนเพื่อดูเฉพาะชิ้น</p>}
          </Card>

          <Card title="ข้อมูลผู้ขาย (จาก Express)">
            <div className="grid gap-3 sm:grid-cols-2">
              {[...new Set(rows.slice(0, ROWS).map((r) => r.sup))].map((code) => {
                const s = sups.get(code);
                return (
                  <div key={code} className="rounded-xl border border-line p-3">
                    <div className="mb-2 font-semibold">
                      {s?.name || code} <span className="text-xs font-normal text-muted">{code}</span>
                    </div>
                    <Info
                      rows={[
                        ["โทร", s?.phone || "-"],
                        ["ที่อยู่", [s?.address, s?.zip].filter(Boolean).join(" ") || "-"],
                        ["เลขผู้เสียภาษี", s?.taxId ? `${s.taxId}${s.branch ? ` สาขา ${s.branch}` : ""}` : "-"],
                        ["VAT", (s && SUPPLIER_VAT[s.vat]) || "-"],
                        ["หมายเหตุ", s?.remark || "-"],
                      ]}
                    />
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-muted">ผู้ขายที่เป็นบุคคลธรรมดาแสดงเฉพาะชื่อ ไม่แสดงเลขประจำตัว ที่อยู่ เบอร์โทร และหมายเหตุ</p>
          </Card>

          <Card title={lines.length > HISTORY ? `ประวัติการซื้อ ${HISTORY} รายการล่าสุด จาก ${lines.length}` : `ประวัติการซื้อ ${lines.length} รายการ`}>
            <Table head={["วันที่", "ผู้ขาย", "สินค้า / รายละเอียด", "จำนวน", "ราคา/หน่วย", "เอกสาร"]}>
              {lines.slice(0, HISTORY).map((l, i) => (
                <tr key={`${l.doc}-${i}`}>
                  <td className="whitespace-nowrap">{day(l.date)}</td>
                  <td className="min-w-32">{name(l.sup)}</td>
                  <td className="min-w-48">
                    <div>{l.desc || p.items[l.item] || l.item}</div>
                    <div className="text-xs text-muted">
                      {l.item}
                      {l.desc && p.items[l.item] ? ` ${p.items[l.item]}` : ""}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    {num(l.qty, 2)} {l.unit}
                  </td>
                  <td className="whitespace-nowrap">{baht(unitPrice(l))}</td>
                  <td className="whitespace-nowrap">{l.doc}</td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      )}
    </>
  );
}
