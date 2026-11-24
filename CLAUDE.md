@AGENTS.md

# CLAUDE.md

ระบบจัดการรถ: เข้างาน / เติมน้ำมัน / แจ้งซ่อม, built from the flowchart "fuel-flowchart.html" (v6).
LINE OA -> role-based web app (LIFF) -> PostgreSQL -> auto checks -> approvals -> Express Accounting / reports.
Thai-first UI. Express integration reuses the proven office-PC scripts of github.com/siwakornkw-stack/nukyoksoftware.

## Stack

Next.js 16.3 App Router (route params / searchParams / cookies() / headers() are Promises) · React 19 · Tailwind v4 ·
Prisma 5 + PostgreSQL · zod · sharp · @line/liff · vitest. No UI library, no auth library, no LINE SDK (plain fetch).

```bash
npm run db:dev       # local Postgres on :5434 (embedded-postgres binaries, data in var/pg)
npm run db:migrate   # prisma migrate dev
npm run db:seed      # dev users (one per role) + vehicles; log in with DEV_LOGIN=1
npm run dev          # http://localhost:3000
npm test             # vitest, pure logic only (tests/*.test.ts)
npx tsc --noEmit && npm run lint && npm run build   # the authoritative checks
```

## Foundation contract (reuse, do not reinvent)

```ts
import { prisma } from "@/lib/db";
import { requirePage, apiUser, currentUser, safePath } from "@/lib/session"; // signed cookie, user re-read per request
import { ROLES, type Role, hasRole } from "@/lib/roles";                   // driver filler office exec purchasing accounting
import { ok, bad, jsonBody, str, numOrNull, readForm, formStr, formNum, formFiles, bearerOk } from "@/lib/http";
import { saveUpload, UploadError } from "@/lib/storage";   // photos -> JPEG 1600px; PDFs only with { pdf: true }
import { fileUrl } from "@/lib/storage-url";               // client-safe
import { notifyRoles, notifyUsers, notifyOfficeGroup, pushText, appLink, linkRichMenu } from "@/lib/line";
import { bkkDateKey, bkkHour, dateOnly, bkkStart, isDateKey, thDate, thDateTime, thTime, hoursBetween } from "@/lib/time";
import { dec, baht, num } from "@/lib/format";             // Decimal -> number at every JSON/UI boundary
import { queueFuelExpress, queueRepairExpress, getMasters, EXPRESS_STATUS, R3_STATUS, expressDocs } from "@/lib/express";
import { MENU } from "@/lib/menu";                          // page paths + which roles see them
import { reviewFuel, decideRepair, openRepair, requestFuel } from "@/lib/actions"; // shared by app routes + เลขา AI
import { readSlip } from "@/lib/slip";                     // Gemini reads a fuel slip photo (GEMINI_API_KEY); never throws, null = type by hand
import { aiUser, aiActor } from "@/lib/ai";                // /api/ai/*: per-user Bearer key (made at /ai), acts as that user
// UI (server-safe):  PageHeader Card Empty Info Pill StatusPill FUEL_STATUS REPAIR_STATUS URGENCY Files Table Field inputCls btnCls btn2Cls  from "@/components/ui"
// UI (client):       ApiForm ActionButton PhotoInput GpsInput VehiclePicker SlipInput                                                                        from "@/components/forms"
```

## Conventions

- Pages live in `src/app/(app)/...` (the layout requires a signed-in active user and draws the header). Every page starts
  with `const u = await requirePage([...roles])` using the same roles as its `MENU` entry. `/login`, `/register` and
  `/liff` are outside the group. Login: `/login` -> `https://liff.line.me/<LIFF_ID><path>` -> LINE -> `/liff/<path>` (the LIFF
  endpoint; it runs the LIFF SDK and must never redirect before it, or the `?code` of a login outside LINE is lost) ->
  `/api/auth/line` (ID token) -> `<path>`. LINE tokens: stateless 15-minute tokens from LINE_CHANNEL_ID + SECRET.
- Route handlers start with `const a = await apiUser([...roles]); if ("res" in a) return a.res; const u = a.user;`
  and answer `ok({...})` / `bad("<Thai message>")`. Never trust the browser for who acts: use `u.id`, never a posted user id.
  `ok({ notice: "..." })` makes ApiForm / ActionButton show that text to the person who acted (e.g. why a bill was
  not sent to Express). `readForm` accepts multipart only (<= 100 MB, nginx allows 100m); `jsonBody` ignores bodies > 1 MB.
- Forms: server page renders `<ApiForm action="/api/..." redirect="/...">` with plain named inputs (files included,
  FormData). One-click decisions: `<ActionButton action=... body={...} note={{prompt, required}} />` posts JSON `{...body, note}`.
- Untrusted input: `str()` / `numOrNull()` before anything reaches Prisma (an object in a `where` acts as a filter). NaN from
  `numOrNull` = invalid, reject it. Check numbers are in range (> 0 where it matters).
- State changes are guarded on the current status in the `where` (`updateMany({ where: { id, status: "waiting" } ... })`
  and check `count`), so two people acting at once cannot both win.
- Money / litres / hours are Prisma `Decimal`: write numbers, read with `dec()`.
- Dates: Bangkok calendar via `bkkDateKey()`; `@db.Date` columns get `dateOnly(key)`. Display with `thDate*`.
- Uploads: `await saveUpload(file, "<folder>")` inside try/catch; `UploadError` -> `bad(e.message)`. Folders:
  attendance, fuel-dash, fuel-slip, repair, repair-quote, repair-bill.
- LINE: notifications never throw (they log); call them after the DB write succeeded. Links in messages use
  `appLink("/path")` so they open inside LINE. Without LINE credentials they only go to the console. The notify helpers
  return `false` when LINE refused (cron gives its claim back so the next tick retries); the last failure is kept in
  AppSetting `line_last_error` and shown on the Office home page.
- Thai UI text; code, comments and identifiers in English. No emojis.
- Simplest working code: no new dependencies, no abstractions with one user, no speculative options.

## เลขา AI API

- `/api/ai/*` (JSON, OpenAPI at `/api/ai/openapi.json`, public): `aiUser(req, roles)` checks `Authorization: Bearer nk_...`
  (sha256 in `User.aiKeyHash`, one key per user, made / revoked at `/ai`). The secretary acts as that user with their
  roles; records name `"<name> (เลขา AI)"`. Changes go through `@/lib/actions` like the app's own routes. Requests by
  `no` (the #) and vehicle code; repair approval must send the current `quoteAmount`. No photos via the API.

## Server (see DEPLOY.md)

- Shared VPS: never restart / reload anything but PM2 `nukyok-web` and nukyok's own nginx site. Deploy with
  `deploy/deploy.sh` (release dir + symlink swap, rolls back when `/login` does not answer). Nightly
  `deploy/backup-db.sh` (local 14 days + offsite `dhkcrypt:nukyok`), `deploy/cron.sh` drives `/api/cron/*`; scripts
  report failures to the Office group with `POST /api/cron/alert {text}`.

## Express Accounting (office PC writes; the web only queues)

- `scripts/express-agent.mjs` runs every minute on the office PC that holds the Express data (Task Scheduler). It
  posts master data to `/api/express/masters`, then writes what `/api/express/{fuel,repair,r3}` hand out and reports back
  (Bearer `EXPRESS_SYNC_SECRET`). Each kind runs only while its mode is `live` on that PC: `EXPRESS_FUEL_MODE`,
  `EXPRESS_REPAIR_MODE`, `EXPRESS_R3_MODE`. Installed with `bash deploy/pack-office.sh` -> zip -> `install.cmd` on that PC
  (`deploy/office/`, Thai guide README-TH.txt; `C:\nukyok-agent`, task `nukyok-express-agent` as SYSTEM). The tick cron
  alerts the Office when the PC is silent > 1 h while bills wait.
- Fuel (Office approves a pump fill): PK + H3 in one run (`scripts/express/fuel.mjs` + `fuel-write.ps1`, copied
  unchanged from nukyoksoftware, verified there on the TESTR3 company), then its H3 goes into the R3 of the bill date
  (`r3.mjs` + `r3-write.ps1`, unchanged). Central-tank fills are not booked.
- Repair (จัดซื้อ saves the cost): PO + RR, bought on credit from the garage as staff key it in DHEWA66, no R3
  (`scripts/express/repair.mjs` + `repair-write.ps1`, built from the fuel PO and the R3 RR writers, run on TESTR3
  2026-11-18: fields match RRs keyed by staff). Expense account from the item (STMAS.ACCCOD -> ISACC.ACCNUM01,
  case-sensitive), VAT mode of the bill as on the tax invoice (`vat` 0/1/2, picked by จัดซื้อ in the cost form; staff
  key 83 of 576 repair RRs differently from APMAS.FLGVAT), YOUREF "<work> <plate>", Cr ISRUN RR ACCNUM03 (2110-01). The
  RR number is kept in `ExpressOrder.h3No`. Accounting checked the TESTR3 test documents (PO0002892-94 /
  RR691118-01..03); `EXPRESS_REPAIR_MODE=live` on DHEWA66 since 2026-11-18.
- Prices (read-only, for จัดซื้อ's เทียบราคา `/purchasing/prices`): with the masters the agent sends two years of
  purchase lines (STCRD POSOPR "0" on a live APTRN bill of the same supplier, no fuel items, no R3) and the APMAS
  details of their suppliers, only when they changed (`scripts/express/prices.mjs` -> `/api/express/prices` ->
  AppSetting `express_prices`; search / compare in `src/lib/prices.ts`). Prices compare per unit before VAT (NETVAL / TRNQTY).
  Only items purchasing buys (`purchaseItem`, same rule in both files): DHEWA66's RR / PE / SA bills also carry payroll,
  staff loans, advances, cash, taxes and legal fees with staff names, which must never reach the web.
- Writer rules from the reference repo (do not break): tables opened `USE x INDEX x SHARED`; one small EXECSCRIPT per
  step; every appended record / changed field logged to a ledger before the next step and rolled back on failure; a
  ledger left "writing" / "ROLLBACK-FAILED" blocks that order until a person checks Express; `.ps1` files must be
  UTF-8 with BOM (PowerShell 5.1 reads BOM-less scripts in the Thai ANSI page); 32-bit PowerShell + VFP OLE DB 9.0.
- `ExpressOrder` keeps a copy of what is booked (`payload`); status queued -> written -> (fuel R3) done, error = retry from
  `/office/express`. A "done" naming a PK/PO/H3/RR another order already holds is turned into an error (same bill twice).
  The agent refuses to report "exists" while that order's ledger is "writing" / "ROLLBACK-FAILED".
- Tests: `tests/express-*.test.ts` (fuel / r3 copied from the reference repo, repair new), `fuel-checks`, `csv`, `safe-path`.
  End-to-end smoke test of every flow: `var/e2e/e2e.mjs` against the `dev-e2e` preview (`var/e2e/dev-tee.mjs`: next dev on
  :3001 logging to `var/e2e/dev.log`, which the test reads to check every LINE message's text and recipients) with a fresh
  seed. `var/e2e` is the only part of `var/` in git (test photo / PDF in `var/e2e/fixtures`). Moving to another PC: `HANDOFF.md`.
