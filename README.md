# ระบบจัดการรถ: เข้างาน / เติมน้ำมัน / แจ้งซ่อม

ตาม flowchart เวอร์ชัน 6: LINE OA -> เว็บแอปตามบทบาท (LIFF) -> Database -> ตรวจความผิดปกติ -> อนุมัติ -> Express / รายงาน

| บทบาท | หน้า |
|---|---|
| คนขับ | เข้างาน / ออกงาน, ขอเติมน้ำมัน (ชั่วโมงเครื่อง + รูปหน้าปัด, เลขไมค์ + รูปถ้ารถมี), แจ้งซ่อม, รายการของฉัน / ตรวจรับรถ |
| คนเติม | รายการรอเติมน้ำมัน (อ่านชั่วโมงเครื่อง / เลขไมค์ใหม่ + ถ่ายหน้าปัดเอง ระบบคิดส่วนต่างจากคนขับ, ลิตร / ราคา / ยอดเงิน / ปั๊มหรือถังกลาง / สลิป) |
| Office | ตรวจรายการน้ำมัน (ผิดปกติขึ้นก่อน) อนุมัติ / ส่งกลับ, ผู้ใช้ / อนุมัติบทบาท, ข้อมูลรถ, รีพอร์ตเข้างาน, Dashboard ต้นทุน, Express |
| ผู้บริหาร | อนุมัติงานซ่อม (เห็นตัวเลขใบเสนอราคา), Dashboard ต้นทุน |
| จัดซื้อ | ใบเสนอราคา, รายละเอียดค่าซ่อม + บิล, ซ่อมเสร็จ, เทียบราคา (ราคาที่ซื้อจริงใน Express แยกตามผู้ขาย + ข้อมูลผู้ขาย) |
| บัญชี | Dashboard ต้นทุน, Express |

Database เป็นข้อมูลหลัก Google Sheets ดูอย่างเดียวผ่าน `=IMPORTDATA("https://nukyok.phuketnukyok.com/api/export/<kind>?token=<token ของ kind นั้น>")`
(kind: `fuel`, `repairs`, `attendance`, `vehicles`). แต่ละ kind มี token ของตัวเอง = 32 ตัวอักษรแรกของ
HMAC-SHA256(`EXPORT_SECRET`, kind) (`exportToken` ใน `src/lib/csv.ts`) สูตรในชีตหนึ่งจึงเปิดได้เฉพาะข้อมูลชุดนั้น
(คนที่เปิดชีตได้เห็นสูตรด้วย) สูตรพร้อม token ทั้ง 4 ชุดอยู่ที่หน้าแรกของ Office หัวข้อ "สูตร Google Sheets"
ไฟล์ attendance ไม่มีพิกัด GPS ไม่ตั้ง `EXPORT_SECRET` = ปิดการ export (404) ค่าที่ระบบไม่รับในโปรดักชัน (สั้นกว่า 16 ตัว
ค่าตัวอย่าง หรือขึ้นต้นด้วย `dev-`) ก็ปิดเช่นกัน และหน้าแรกของ Office แจ้งไว้แทนสูตร `EXPORT_SECRET` ต้องเป็นค่าสุ่มใหม่
(`openssl rand -hex 32`) ห้ามใช้ค่า `EXPORT_TOKEN` เดิม ซึ่งอยู่ในสูตรของชีตเก่าทุกอัน (แอปไม่อ่าน `EXPORT_TOKEN` แล้ว
ลบออกจาก `.env` ได้) เปลี่ยน `EXPORT_SECRET` แล้วสูตรเดิมทุกอันใช้ไม่ได้ ต้องคัดลอกสูตรใหม่จากหน้าแรกไปใส่แทน

## Local dev

```bash
cp .env.example .env      # DEV_LOGIN=1 to log in without LINE
npm install
npm run db:dev            # local Postgres :5434
npm run db:migrate
npm run db:seed           # one user per role + 3 vehicles
npm run dev               # http://localhost:3000/login
npm test
```

## LINE setup

Both channels must be under the **same provider**: LINE user ids are per provider, so a LIFF login id from another
provider is a different id and push messages to it fail.

1. LINE Official Account (manager.line.biz) -> Settings -> Messaging API -> enable, choosing the provider. This makes the
   Messaging API channel: `LINE_CHANNEL_ID` + `LINE_CHANNEL_SECRET` (the app issues itself 15-minute stateless tokens
   from them; a long-lived `LINE_CHANNEL_ACCESS_TOKEN` is optional), webhook URL
   `https://nukyok.phuketnukyok.com/api/line/webhook` with "Use webhook" on. In OA Manager response settings:
   webhook on, auto-response off; allow the account to join groups.
2. Same provider -> new LINE Login channel (web app). Basic settings: "Linked LINE Official Account" = this OA, then
   **Publish** the channel (while "Developing" only its admins/testers can log in). LIFF tab: size Full, endpoint
   `https://nukyok.phuketnukyok.com/liff` (`src/app/liff`: the login callback must not hit an auth redirect), scopes
   `openid` + `profile` (check both are saved: without openid there is no ID token), add friend option "On (normal)":
   people must be friends of the OA to receive push messages. `LIFF_ID` = LIFF id, `LINE_LOGIN_CHANNEL_ID` = this
   channel's id. `/login` sends everyone to `https://liff.line.me/<LIFF_ID><path>`, which lands on `/liff/<path>`.
3. Type `id` to the OA (or in the Office group with the OA in it) to get a user id / group id for
   `ADMIN_LINE_USER_IDS` / `LINE_OFFICE_GROUP_ID`. Values in `.env` are read at start: `pm2 restart nukyok-web`. On the
   server edit `~/nukyok-data/.env` (every release links to it; `sed -i` on the `~/nukyok/.env` link would replace the
   link with a copy that the next deploy drops).
4. Rich menus per role: `node --env-file=.env scripts/richmenu.mjs` (on the server, after the channel values and `LIFF_ID`)
   creates one menu per role from `deploy/richmenu/<role>.png`, makes "guest" (เข้าระบบ / ลงทะเบียน) the default for
   people without a role, links everyone already approved, and prints the `LINE_RICHMENU_<ROLE>=...` lines for `.env`
   (then `pm2 restart nukyok-web`; each later approval links the person's menu). Re-running replaces the menus. To change
   the buttons edit `MENUS` in the script and redraw on Windows (Thai font): `node scripts/richmenu.mjs --images`.

## Express Accounting (office PC)

`scripts/express-agent.mjs` runs every minute on the PC that holds the Express data (Task Scheduler, Node 22,
32-bit VFP OLE DB provider 9.0 SP2 for writing). Install it with `bash deploy/pack-office.sh` ->
`~/nukyok-office-agent.zip` (outside the repo: it holds `EXPRESS_SYNC_SECRET`; delete it after the install) -> on that PC
extract and double-click `install.cmd`: it checks Node and the provider, asks for the Express company folder (the live
company only, never TESTR3) and the modes, writes `C:\nukyok-agent\.env`, does one read-only run and registers the Task
Scheduler task (`nukyok-express-agent`, every minute, SYSTEM). The tick cron tells the Office when the PC has been
silent for an hour while bills wait (`/office/express` shows it too).

- Fuel: Office approves a pump fill -> PK + H3 -> its line in the R3 (ตั้งหนี้บัตรเครดิต) of the bill date.
- Repair: จัดซื้อ saves the cost -> PO + RR (bought on credit from the garage, no R3).
- **The writers changed on 2026-11-24** (fuel / R3 came from nukyoksoftware, repair was verified on TESTR3 on
  2026-11-18): they count as verified again only after the owner's TESTR3 run in `HANDOFF.md`, before the new agent zip
  is installed.
- Every write first copies the tables to `var/express-backups/`, logs each change to a ledger and rolls back on failure.
  Failures show on `/office/express` (ลองใหม่, คีย์เองแล้ว, ยกเลิก).

Details (modes, masters, VAT months, duplicates, stuck writes): `CLAUDE.md`, section "Express Accounting".

## VPS

PM2 app `nukyok-web` on 127.0.0.1:3004 behind nginx (`deploy/`), database `nukyok` (own role), files in
`/home/ubuntu/nukyok-data/uploads` (`UPLOAD_DIR` must be an absolute path in production: the app refuses to save or
read files with a relative or unset one; new folders are 0700 and files 0600), cron via `deploy/cron.sh`, nightly
dump via `deploy/backup-db.sh`. See `DEPLOY.md`.
