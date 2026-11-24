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

Database เป็นข้อมูลหลัก Google Sheets ดูอย่างเดียวผ่าน `=IMPORTDATA("https://nukyok.phuketnukyok.com/api/export/fuel?token=<EXPORT_TOKEN>")`
(kind: `fuel`, `repairs`, `attendance`, `vehicles`).

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
`var/nukyok-office-agent.zip` -> on that PC extract and double-click `install.cmd`: it checks Node and the provider, asks
for the Express company folder and the modes, writes `C:\nukyok-agent\.env`, does one read-only run and registers the
Task Scheduler task (`nukyok-express-agent`, every minute, SYSTEM). Values with a backslash go in single quotes in that
`.env`: Node turns `\n` inside double quotes into a new line (`"D:\Express\nukyok"`). The tick cron tells the Office
when the PC has been silent for an hour while bills wait (`/office/express` shows it too).

- Fuel: Office approves a pump fill -> PK + H3 -> its line in the R3 (ตั้งหนี้บัตรเครดิต) of the bill date. The writers are
  the ones of nukyoksoftware, unchanged (verified there on the test company TESTR3).
- Repair: จัดซื้อ saves the cost -> PO + H3 -> R3. **`repair-write.ps1` is new and not yet verified**: keep
  `EXPRESS_REPAIR_MODE=off` until a run on TESTR3 matches a PO / H3 keyed by staff, and set `EXPRESS_REPAIR_EXPENSE_ACC`.
- Every write first copies the tables to `var/express-backups/`, logs each change to a ledger and rolls back on failure.
  Failures show on `/office/express` with a retry button.

## VPS

PM2 app `nukyok-web` on 127.0.0.1:3004 behind nginx (`deploy/`), database `nukyok` (own role), files in
`/home/ubuntu/nukyok-data/uploads`, cron via `deploy/cron.sh`, nightly dump via `deploy/backup-db.sh`. See `DEPLOY.md`.
