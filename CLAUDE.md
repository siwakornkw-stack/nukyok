@AGENTS.md

# CLAUDE.md

ระบบจัดการรถ: เข้างาน / เติมน้ำมัน / แจ้งซ่อม, built from the flowchart "fuel-flowchart.html" (v6).
LINE OA -> role-based web app (LIFF) -> PostgreSQL -> auto checks -> approvals -> Express Accounting / reports.
Thai-first UI. Express integration started from the office-PC scripts of github.com/siwakornkw-stack/nukyoksoftware;
since 2026-11-24 this repo's writers differ from them (see Express).

## Stack

Next.js 16.4 App Router (route params / searchParams / cookies() / headers() are Promises) · React 19 · Tailwind v4 ·
Prisma 5 + PostgreSQL · zod · sharp · @line/liff · vitest. No UI library, no auth library, no LINE SDK (plain fetch).

```bash
npm run db:dev       # local Postgres on :5434 (embedded-postgres binaries, data in var/pg)
npm run db:migrate   # prisma migrate dev
npm run db:seed      # dev users (one per role) + vehicles; refuses unless DEV_LOGIN=1, not production, DB on localhost
npm run dev          # http://localhost:3000, bound to 127.0.0.1 (DEV_LOGIN must not reach the LAN)
npm test             # vitest, pure logic only (tests/*.test.ts)
npx tsc --noEmit && npm run lint && npm run build   # the authoritative checks
```

## Foundation contract (reuse, do not reinvent)

```ts
import { prisma } from "@/lib/db";
import { requirePage, apiUser, currentUser, safePath, liffTarget } from "@/lib/session"; // signed cookie, user re-read per request
import { ROLES, type Role, hasRole } from "@/lib/roles";                   // driver filler office exec purchasing accounting
import { ok, bad, jsonBody, str, numOrNull, readForm, formStr, formNum, formFiles, bearerOk, crossSite, foreignOrigin, weakSecret } from "@/lib/http";
import { saveUpload, removeUpload, UploadError } from "@/lib/storage"; // photos -> JPEG 1600px; PDFs only with { pdf: true }
import { fileUrl } from "@/lib/storage-url";               // client-safe
import { notifyRoles, notifyUsers, notifyOfficeGroup, pushText, appLink, linkRichMenu } from "@/lib/line";
import { bkkDateKey, bkkHour, dateOnly, bkkStart, isDateKey, thDate, thDateTime, thTime, hoursBetween } from "@/lib/time"; // isDateKey: real dates of 2000-2099
import { dec, baht, num } from "@/lib/format";             // Decimal -> number at every JSON/UI boundary
import { queueFuelExpress, queueRepairExpress, getMasters, knownDepartments, vatMonthClosed, EXPRESS_STATUS, R3_STATUS, expressDocs } from "@/lib/express";
import { companyRefused } from "@/lib/express-queue";      // office-PC routes, right after bearerOk
import { MENU } from "@/lib/menu";                          // page paths + which roles see them
import { reviewFuel, decideRepair, openRepair, requestFuel } from "@/lib/actions"; // shared by app routes + เลขา AI
import { fuelFlags, slipFlags, invoiceDateError, flagCodes } from "@/lib/fuel-checks"; // slip buyer vs COMPANY_TAX_ID, seller vs the pump's masters taxId
import { readSlip } from "@/lib/slip";                     // Gemini reads a fuel slip photo (GEMINI_API_KEY); never throws, null = type by hand
import { aiUser, aiActor, filterError, UNTRUSTED } from "@/lib/ai"; // /api/ai/*: per-user Bearer key (made at /ai), acts as that user
import { plateKey, samePlate } from "@/lib/summary";        // plates equal ignoring case, spaces, dots and dashes
// UI (server-safe):  PageHeader Card Empty Info Pill StatusPill FUEL_STATUS REPAIR_STATUS URGENCY Files Table Field inputCls btnCls btn2Cls  from "@/components/ui"
// UI (client):       ApiForm ActionButton PhotoInput GpsInput VehiclePicker SlipInput                                                                        from "@/components/forms"
```

## Conventions

- Pages live in `src/app/(app)/...` (the layout requires a signed-in active user and draws the header). Every page starts
  with `const u = await requirePage([...roles])` using the same roles as its `MENU` entry. `/login`, `/register` and
  `/liff` are outside the group. Login: `/login` -> `https://liff.line.me/<LIFF_ID><path>` -> LINE -> `/liff/<path>` (the LIFF
  endpoint; it runs the LIFF SDK and must never redirect before it, or the `?code` of a login outside LINE is lost; the
  page's own query is kept, `liffTarget`) -> `/api/auth/line` (ID token) -> `<path>`. LINE tokens: stateless 15-minute
  tokens from LINE_CHANNEL_ID + SECRET.
- Session cookie `__Host-nk_session` in production (`nk_session` on plain-http dev; the rename signs everyone out once).
  The cookie carries its issue time in ms (`i`; older cookies count from e - 30 days). Disabling or re-enabling a user
  sets `User.sessionsAfter` (cookies issued before it, to the ms, are refused) and deletes their เลขา AI key.
  `SESSION_SECRET` needs 16+ characters; in production any secret under 16 characters, holding "change-me" or starting
  with "dev-" counts as unset (`weakSecret`): sessions throw, Bearer calls get 401, the export is off.
- Route handlers start with `const a = await apiUser([...roles]); if ("res" in a) return a.res; const u = a.user;`
  and answer `ok({...})` / `bad("<Thai message>")`. Never trust the browser for who acts: use `u.id`, never a posted user id.
  `ok({ notice: "..." })` makes ApiForm / ActionButton show that text to the person who acted (e.g. why a bill was
  not sent to Express). `readForm` accepts multipart only (<= 100 MB, nginx allows 100m); `jsonBody` reads only
  `Content-Type: application/json` (scripts, the office PC and เลขา AI clients send it) and ignores bodies > 1 MB.
- CSRF: `apiUser` refuses (403) a request whose Origin is not this host; browser routes without it (`/api/auth/*`) refuse
  `crossSite(req.headers)` (also Sec-Fetch-Site cross-site). `src/proxy.ts` skips `/api` on purpose (Next buffers every
  proxied body and cuts it at 10 MB) and sends `frame-ancestors 'self'` with pages.
- Forms: server page renders `<ApiForm action="/api/..." redirect="/...">` with plain named inputs (files included,
  FormData). One-click decisions: `<ActionButton action=... body={...} note={{prompt, required}} />` posts JSON `{...body, note}`.
- Untrusted input: `str()` / `numOrNull()` before anything reaches Prisma (an object in a `where` acts as a filter). NaN from
  `numOrNull` = invalid, reject it. Check numbers are in range (> 0 where it matters).
- State changes are guarded on the current status in the `where` (`updateMany({ where: { id, status: "waiting" } ... })`
  and check `count`), so two people acting at once cannot both win. A decision also posts the version its page showed and
  is refused when it changed: fuel approve (`reviewedAt` + `flagCodes`), repair decide (`quotedAt`), the filler's
  `slipKey`, users (`was`, `wasRoles`, `wasName`, `wasPhone`, `wasRequest`), vehicles (`was` JSON: only changed fields are
  written, each guarded on its loaded value), Express close (`seen`, `seenR3`).
- Money / litres / hours are Prisma `Decimal`: write numbers, read with `dec()`; a `where` guard on one gets its exact text
  (a JS float can miss the stored value).
- Dates: Bangkok calendar via `bkkDateKey()`; `@db.Date` columns get `dateOnly(key)`. Display with `thDate*`.
- Uploads: `await saveUpload(file, "<folder>")` inside try/catch; `UploadError` -> `bad(e.message)`. Files <= 15 MB; photos
  only JPEG / PNG / WebP (told by their first bytes), capped by what the decoder holds (`maxPixels`: baseline JPEG 100 MP,
  else 64 MB decoded), one conversion at a time. A write refused or failed after saving calls `removeUpload(key)`: no
  orphan file. A file a successful save replaces stays on disk as the evidence that was reviewed (a returned fill's slip
  and fill-dash photo, a re-quoted quotation; no row points to it). `UPLOAD_DIR` must be absolute in production (storage
  throws otherwise); folders 0700, files 0600. Folders: attendance, fuel-dash, fuel-slip, repair, repair-quote,
  repair-bill.
- LINE: notifications never throw (they log); call them after the DB write succeeded. Links in messages use
  `appLink("/path")` so they open inside LINE. Without LINE credentials they only go to the console. Every LINE fetch
  times out after 10 s. The notify helpers return `false` when LINE refused or did not answer (cron gives its claim back
  so the next tick retries); the last failure is kept in AppSetting `line_last_error` and shown on the Office home page.
- Google Sheets: `/api/export/<kind>?token=` opens with that kind's token only, the first 32 hex of
  HMAC-SHA256(`EXPORT_SECRET`, kind) (`exportToken`; the old EXPORT_TOKEN is not read); Office copies the formulas from its
  home page, shown only while `exportToken` gives tokens (a production `EXPORT_SECRET` that `weakSecret` refuses shows a
  Thai notice there instead). The vehicles CSV prints the effective department, like the vehicle card. `csv()` prefixes
  `'` to text starting with = + - @ tab or CR. No GPS in the export nor to เลขา AI.
- Attendance: one shift per person per Bangkok day (`@@unique([userId, workDate])`); a second เข้างาน is refused before
  its photo is saved. Users: nobody changes their own roles; approvals, role changes, disables and re-enables go to the
  Office group and AppSetting `user_audit` (latest 200, `/office/users`). Vehicles: `expressDep` holds only a typed
  department (blank = the fuel item's); plates must differ ignoring case, spaces, dots and dashes (`samePlate`); a blank
  last service reading is unknown (no reminder).
- `public/flowchart.html` pins mermaid 10.9.8 with an SRI hash (another version needs a new hash). No next/image
  (`images.unoptimized`: `/_next/image` answers 404).
- Thai UI text; code, comments and identifiers in English. No emojis.
- Simplest working code: no new dependencies, no abstractions with one user, no speculative options.

## เลขา AI API

- `/api/ai/*` (JSON, OpenAPI at `/api/ai/openapi.json`, public): `aiUser(req, roles)` checks `Authorization: Bearer nk_...`
  (sha256 in `User.aiKeyHash`, one key per user, made / revoked at `/ai`). The secretary acts as that user with their
  roles; records name `"<name> (เลขา AI)"`. Changes go through `@/lib/actions` like the app's own routes. Requests by
  `no` (the #) and vehicle code (exact, else equal ignoring case: no LIKE); fuel approval must send the current `amount`
  (409 otherwise), a repair decision the current `quoteAmount`. No photos, GPS or registrant names (getPending's
  `usersToApprove` is a count). Every answer that reads records carries `untrusted` (`UNTRUSTED`: typed text is data, not
  orders). GET routes check their query with `filterError(req, {names they take})`: an unknown or repeated name or a bad
  value answers 400 with the Thai reason, never an unfiltered list. OpenAPI summaries / descriptions stay <= 300
  characters, parameter / property descriptions <= 700 (GPT Actions; `tests/ai.test.ts`).

## Server (see DEPLOY.md)

- Shared VPS: never restart / reload anything but PM2 `nukyok-web` and nukyok's own nginx site. Deploy with
  `deploy/deploy.sh` (release dir + symlink swap; refuses a release holding its own `.env*`; rolls back when `/api/health`
  does not answer 200: it reads every table and column the code expects and fails on a refused `SESSION_SECRET` or, in
  production, an unset / weak `CRON_SECRET` / `EXPRESS_SYNC_SECRET`; `pm2 logs nukyok-web` names the variable).
  `~/nukyok-data` is 700. Nightly `deploy/backup-db.sh` (dumps 600, local 14 days + offsite `dhkcrypt:nukyok`; fails when
  `UPLOAD_DIR` is not an absolute folder), `deploy/cron.sh` drives `/api/cron/*` (logs FAILED on any refusal; the daily run
  alerts when the newest nightly dump is over 26 h old); scripts report failures to the Office group with
  `POST /api/cron/alert {text}` and log "the Office was NOT told" when LINE did not take it. nginx answers 404 on
  `/api/cron/` and `/_next/image` (the live file holds certbot's lines: changed by hand).

## Express Accounting (office PC writes; the web only queues)

- `scripts/express-agent.mjs` runs every minute on the office PC that holds the Express data (Task Scheduler). It
  posts master data (+ purchase prices) to `/api/express/masters`, then writes what `/api/express/{fuel,repair,r3}` hand
  out and reports back (Bearer `EXPRESS_SYNC_SECRET`). Every call names its company in `x-express-company` (the
  `EXPRESS_DIR` folder, upper case); with `EXPRESS_COMPANY` set the server refuses another company, or none, with 409
  (`companyRefused`), so it is set only once the office PC runs an agent that sends it. Each kind runs only while its
  mode is `live` on that PC: `EXPRESS_FUEL_MODE`, `EXPRESS_REPAIR_MODE`, `EXPRESS_R3_MODE`. `EXPRESS_MASTERS_ONLY=1` (the
  installer's connection test) sends masters + prices with the real writer flags, takes no lock, writes nothing. One run at
  a time: `var/express-agent.lock` ("<pid> <start>", touched before every step and write) is taken over only when that pid
  is gone or it was not touched for 30 minutes; fetches time out after 2 minutes; order ids must be cuids and R3 PKs plain
  document numbers (they name ledger files).
- Installed with `bash deploy/pack-office.sh` -> `~/nukyok-office-agent.zip` (holds the secret: built outside the repo,
  deleted after the install) -> `install.cmd` on that PC (`deploy/office/`, Thai guide README-TH.txt; `C:\nukyok-agent`,
  SYSTEM and Administrators only, task `nukyok-express-agent` as SYSTEM). The zip talks to the live server: the installer
  refuses a TESTR3 folder; writer tests on TESTR3 run from the dev PC against the dev server. The tick cron alerts the
  Office when the PC is silent > 1 h while bills wait, and once per jam when a bill or R3 has waited > 1 h while the PC
  answers (AppSetting `express_stuck_alert`).
- Masters: suppliers carry `vat` (a usable 13-digit APMAS.TAXID, not a filler such as 0000000000000) and `taxId` only for
  a company (0 then 1-9: a person's ID never leaves the office PC), at most 1000 a book (repair: most recently used
  first); a fuel item's `vatClaim` is true only when its latest live H3 claimed VAT (missing = false: PK only, staff key
  that H3); repair items are 5360-xx accounts only; the repair book also carries every Express department (ISTAB 50) for
  `knownDepartments` (an older agent: the items' depCodes). A vehicle's department (typed, else its fuel item's) must be
  known. A masters push with a writer off turns that kind's queued orders into errors (Office group told). The R3 goes
  with the fuel writer (install.cmd sets `EXPRESS_R3_MODE` from the same answer; the masters carry no R3 flag): with fuel
  off, R3 steps still to do (queued, force, waiting) become R3 errors too, and an R3 ลองใหม่ is refused while it is off.
- Bill date: PK / H3 / PO / RR are dated by the tax invoice (`FuelRequest.invoiceDate` from the filler form, required for
  pump fills, defaulting to the saved date, else the slip reading's, else the Bangkok date of filledAt, else today;
  `RepairRequest.invoiceDate`, required in the cost form); older rows use the
  Bangkok date of filledAt / costedAt. VAT months are closed through the later of AppSetting `vat_filed_through` (Office:
  "ยื่น ภ.พ.30 แล้วถึงเดือน" on `/office/express`, `POST /api/express/vat-month`) and the month before last (last month
  once the 15th is past, Bangkok). In a closed month fuel is queued PK only (withH3 false, the person is told), repair
  VAT 1 / 2 is refused, and the hand-out (`queuedOrders`) turns a queued order that would book VAT into a closed month
  into an error (Office group told).
- Fuel (Office approves a pump fill; held while the vehicle's previous fill is sent back, or while the other request of a
  replacement tax invoice is approved, whatever its Express order: that one is cancelled first): PK + H3 in one run
  (`scripts/express/fuel.mjs` + `fuel-write.ps1`), then its H3 goes into the R3 of the bill date (`r3.mjs` +
  `r3-write.ps1`). The H3 (input VAT) needs the pump's masters `vat`, else only the PK is queued with a note
  (`fuel-write.ps1` refuses such an H3 too). Already in Express = an H3 with this invoice and amount, or a live PK of this
  supplier, date, invoice, amount and vehicle; the invoice in another H3 / PK of the same supplier is an error "อาจซ้ำ"
  (one invoice split over vehicles): Office checks Express and presses ยืนยันว่าไม่ซ้ำ (`/api/express/retry`
  `{ force: true }`, Office only, only on that error: rebuilt with `force: true` in the payload, the office PC writes its
  own PK + H3) or keys it and presses คีย์เองแล้ว. planR3 refuses an H3 or R3 whose STCRD lines do not add up to its
  AMOUNT. Line amounts in satang, rounded half-up as Express does. Central-tank fills are not booked. An approved fill can
  be cancelled (reviewFuel) only while the office PC has nothing of it to write: no order, its order cancelled, or keyed
  by hand (that order is cancelled with it; staff void its PK / H3 in Express); cancelled, it leaves the cost reports.
- Repair (จัดซื้อ saves the cost): PO + RR, bought on credit from the garage as staff key it, no R3
  (`scripts/express/repair.mjs` + `repair-write.ps1`, built from the fuel PO and the R3 RR writers; accounting checked the
  TESTR3 test documents, live since 2026-11-18). Expense account from the item (STMAS.ACCCOD -> ISACC.ACCNUM01,
  case-sensitive), 5360-xx only. VAT mode of the bill as on the tax invoice (`vat` 0/1/2, picked by จัดซื้อ in the cost
  form; staff key many repair RRs differently from APMAS.FLGVAT); 1 / 2 need the supplier's `vat` and the vehicle's fuel
  item with `vatClaim`. YOUREF "<work> <plate>", Cr ISRUN RR ACCNUM03 (2110-01). The RR number is kept in
  `ExpressOrder.h3No`. planRepair reports a bill already in Express before any rule about writing a new one. A costed
  repair without an order, or whose order failed, is sent (again) from `/purchasing/repairs/<id>`
  (`POST /api/repairs/<id>/express`, purchasing / office: the bill's fields and VAT mode are asked again; a failed order
  is replaced in place, guarded on status error) or marked keyed by hand (`POST /api/express/repair-manual` with no
  order; คีย์เองแล้ว on `/office/express` for a failed one).
- Prices (read-only, for จัดซื้อ's เทียบราคา `/purchasing/prices`): with the masters the agent sends two years of
  purchase lines (STCRD POSOPR "0" on a live APTRN bill of the same supplier, no fuel items, no R3) and the APMAS
  details of their suppliers, only when they changed (`scripts/express/prices.mjs` -> `/api/express/prices` ->
  AppSetting `express_prices`; search / compare in `src/lib/prices.ts`). Prices compare per unit before VAT (NETVAL / TRNQTY).
  Only items purchasing buys (`purchaseItem`: no payroll, loans, advances, cash, taxes), no staff and no private person's
  details: the agent also leaves out every supplier with a staff-type line on any bill (`staffItem`: payroll, staff loans,
  advances, petty cash, payroll liabilities) unless it is a `company` (tax ID 0[1-9] + 11 digits, no title), sends a
  `person` (any other 13-digit ID but zeros, or a personal title) by name only, and keeps 5110-05 service wages only of a
  supplier known not to be one. The web's `keepPrices` applies `purchaseItem` and the person rules again on save and on
  read; leaving staff out is the agent's job. Same twins in both files (`tests/express-prices.test.ts`); do not relax them.
- Writer rules (do not break): tables opened `USE x INDEX x SHARED`; one small EXECSCRIPT per step; each APPEND BLANK's
  record number goes to the ledger before its REPLACE, each changed field with its old value before the next step, all
  rolled back on failure; every writing step (the rollback's too) ends with `FLUSH IN <alias> FORCE` of the alias it
  wrote, and one that REPLACEs a field of an existing row (`Change`, the rollback's) then goes back to its record
  (`GO VAL(p1) IN (p2)` again, same step, before the flush): the VFP OLE DB provider keeps a change to a row it holds locked in memory until
  the record pointer is set again (or unlock / close), and FLUSH alone does not write it (a killed write lost its ISRUN /
  STMAS changes on TESTR3, 2026-11-24; the second GO keeps them and the row lock, proven on scratch copies of TESTR3's
  tables, 2026-11-25); the ledger is saved atomically (`<ledger>.tmp` flushed, then `[IO.File]::Replace(tmp, ledger,
  [NullString]::Value)`, or Move on the first save; never `$null`: PS 5.1 makes it "" and Replace throws; the swap is
  retried 40 x 250 ms, and Save-Ledger is identical in the three writers; if the error handler's own save fails, the
  RESULT:ERR line still comes and says so); a new H3 / R3 / RR takes its number past every
  number of that date in the tables appended before its APTRN header (appended last), deleted rows included;
  `fuel-write.ps1` records the PK before any H3 row; `.ps1` files must be UTF-8 with BOM (PowerShell 5.1 reads BOM-less
  scripts in the Thai ANSI page); 32-bit PowerShell + VFP OLE DB 9.0. Test hooks `FUEL_TEST_FAIL_AT` / `R3_TEST_FAIL_AT`
  (before-apbal, replace, kill), `REPAIR_TEST_FAIL_AT` (before-apbal, kill): TESTR3 only.
- The writers came from nukyoksoftware (fuel / R3, verified there on TESTR3) or were verified on TESTR3 (repair,
  2026-11-18), and all three were changed on 2026-11-24 (atomic ledger with a retried swap, two-step append, numbers past
  every table, a flush after every writing step; fuel / R3 also the duplicate checks) and 2026-11-25 (a changed row gone
  back to before its flush, the error handler's failed save reported). This version passed the full TESTR3 run of
  HANDOFF.md on 2026-11-25 (independently re-checked); any later writer change needs that run again before an install.
- A stuck write holds its kind: a ledger in `var/<kind>-ledger` that says "writing" / "ROLLBACK-FAILED", cannot be read or
  has an unknown status (`stuckLedger` in `scripts/express/dbf.mjs`; clean = done, exists, busy, rolled-back,
  failed-unopened: add any new final status there) holds every write of that kind (fuel, repair or R3) until a person has
  cleaned up and moved the ledger out of its folder. Its own order becomes an error at once (LINE to the Office); the
  others are reported busy and stay queued. A writer killed part way is judged from its ledger (`noResult`). Cleanup
  (the one documented procedure: `stuckText`, HANDOFF.md, README-TH): undo the bill FULLY from its ledger, i.e. mark
  deleted every row listed in `added` (by record number, after checking its document number; never PACK: record numbers
  would shift and skipped numbers could be reused) and put every `changed` field back to its logged old value, working
  from the last entry up (a field listed more than once, e.g. fuel's STMAS `totreo` +litres then -litres, ends at the old
  value of its first entry; one already equal needs nothing; the last entry may not have been written), then move the
  ledger out and press ลองใหม่. Right whether or not the changes reached disk, as long as nobody changed those fields
  since: each must hold its old value or what the bill wrote (ISRUN counter: the ledger's PK / PO + 1; `totreo`: old ±
  litres; APMAS `balance` / APBAL column: old + bill total; `lasrcv`: the later of old and the bill date), anything else
  (e.g. staff issued a new PO / PK number meanwhile) is left for accounting; never "keep the PK, delete only the stock
  line". A `<ledger>.tmp` beside a stuck ledger (a power cut between its flush and swap) may list one more entry: an
  append listed only there is in Express, a change listed only there was not written. An unreadable ledger: its .tmp,
  else compare with `var/express-backups`. The web keeps 500 characters of an error, so `stuckText` puts the file, the
  .tmp / unreadable notes and what to do first.
- `ExpressOrder` keeps a copy of what is booked (`payload`); status queued -> written -> (fuel R3) done. error ->
  ลองใหม่ (`/api/express/retry` builds the order again from the current fill or repair, vehicle and masters through the
  same checks; a failed R3 or a fuel "อาจซ้ำ" may be forced), a repair sent again from its repair page, or Office settles
  it with `/api/express/close`: คีย์เองแล้ว -> manual (a failed R3: r3Status manual), ยกเลิก (reason required, not while
  its R3 is queued / force; allowed while it waits for the H3) -> cancelled, its Express documents voided there by staff.
  An R3 the office PC writes for an order cancelled meanwhile is kept on it (r3Status done + r3No) and the Office group
  is told to void that line too. manual and cancelled are never handed out nor counted as problems. A "done" naming a
  PK/PO/H3/RR another live order holds, or every number a cancelled one holds (its documents stay live in Express until
  voided; its own message says so), is turned into an error (same bill twice). `/office/express` also lists approved
  pump fills and costed repairs without an order.
- Tests: `tests/express-*.test.ts` (fuel / r3 started from the reference repo; repair, agent, web, prices), `fuel-checks`,
  `slip`, `prices`, `csv`, `storage`, `uploads`, `session`, `time`, `ai`, `http`, `safe-path`, `vehicles`, `users`,
  `register-name`. Test data is made up: `tests/express-repair.test.ts` fails when a `tests/*.ts` holds a quoted
  13-digit number passing the Thai ID checksum (it also reads the writers' text: RR scan, shared Save-Ledger, hooks).
  End-to-end smoke test of every flow: `var/e2e/e2e.mjs` against the `dev-e2e` preview (`var/e2e/dev-tee.mjs`: next dev
  on 127.0.0.1:3001 logging to `var/e2e/dev.log`, which the test reads to check every LINE message's text and
  recipients) with a fresh seed. `var/e2e` is the only part of `var/` in git (test photo / PDF in `var/e2e/fixtures`).
  Moving to another PC: `HANDOFF.md`.
