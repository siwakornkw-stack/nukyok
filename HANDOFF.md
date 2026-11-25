# ย้ายเครื่องพัฒนา (HANDOFF)

เขียน 24 พ.ย. 2569 ตอนย้ายงาน nukyok จากเครื่องพัฒนาเดิมไปเครื่อง Office (D:\nukyok พาธเดิม)
อ่านคู่กับ `CLAUDE.md` (กติกาโค้ดและ Express), `DEPLOY.md` (เซิร์ฟเวอร์) และ `deploy/office/README-TH.txt` (ตัวเชื่อม)

## โค้ดเก็บอย่างไร

- repo: https://github.com/siwakornkw-stack/nukyok (**public**, push ครั้งแรก 24 พ.ย. 2569) ที่เครื่องใหม่:
  `git clone https://github.com/siwakornkw-stack/nukyok.git D:\nukyok` (หรือถ้า clone จากไฟล์ bundle ไว้แล้ว
  `git remote set-url origin https://github.com/siwakornkw-stack/nukyok.git`). ก่อนวันนั้นไม่เคยใช้ git ประวัติจึงเริ่มที่ commit แรก
- repo เป็น public: ห้าม commit ค่าลับ (.env, key, token, รหัส LINE / Gemini) หรือข้อมูลส่วนตัวของพนักงาน ค่าลับอยู่ใน `.env` บนเซิร์ฟเวอร์เท่านั้น
  ข้อมูลในเทสต์ต้องเป็นข้อมูลสมมติ (`tests/express-repair.test.ts` ล้มเมื่อ `tests/*.ts` มีเลข 13 หลักในเครื่องหมายคำพูด
  ที่ผ่าน checksum เลขประจำตัวไทย) ประวัติ git ยังมีข้อมูลจริงที่ลบออกจากไฟล์แล้ว (ดูหัวข้อเรื่องที่เจ้าของต้องตัดสินใจ)
- ที่ไม่อยู่ใน git (ดู `.gitignore`): `node_modules`, `.next`, `.env`, และ `var/` ยกเว้น `var/e2e` (สคริปต์ e2e + รูป/PDF ทดสอบใน
  `var/e2e/fixtures`). `var/pg` (ฐานข้อมูลทดสอบ) และ `var/uploads` ไม่ต้องย้าย สร้างใหม่ได้
- โค้ดที่รันจริงอยู่บนเซิร์ฟเวอร์ (`/home/ubuntu/nukyok-releases/<เวลา>`) และตัวเชื่อมที่ `C:\nukyok-agent` บนเครื่อง Office
  ทั้งสองที่สร้างจากโฟลเดอร์นี้

## ลงเครื่อง

| อะไร | ต้องลงไหม |
|---|---|
| Node.js 24, Git (มี Git Bash) | มีแล้ว. สคริปต์ `deploy/*.sh` รันใน Git Bash |
| PostgreSQL / Docker | ไม่ต้อง: `npm run db:dev` ใช้ PostgreSQL ที่มากับ npm (`@embedded-postgres/windows-x64`) พอร์ต 5434 ข้อมูลใน `var/pg` |
| เบราว์เซอร์สำหรับ e2e | ไม่ต้อง: e2e เป็นสคริปต์ Node (fetch). ดูหน้าเว็บใช้เบราว์เซอร์ไหนก็ได้ ล็อกอินทดสอบด้วย `DEV_LOGIN=1` |
| SSH key `~/.ssh/id_88arena_vps` | ใช้ deploy และ `pack-office.sh` (เครื่อง Office มีแล้ว) |

```bash
npm ci
npm run db:dev          # ครั้งแรกสร้าง var/pg; พิมพ์ DATABASE_URL สำหรับ .env
npx prisma migrate dev  # สร้างตาราง
npm run db:seed         # ผู้ใช้ทดสอบทุกบทบาท + รถ 3 คัน (ต้องมี DEV_LOGIN=1 และฐานข้อมูลบนเครื่องนี้)
npm run dev             # http://localhost:3000/login (เลือกผู้ใช้ทดสอบ) ฟังเฉพาะ 127.0.0.1: มือถือในวงแลนเข้าไม่ได้
```

ถ้า `db:dev` บอก "already running?" แต่ต่อไม่ได้ (เคยเจอ error 487 shared memory): `node scripts/dev-db.mjs stop` แล้ว `npm run db:dev` ใหม่

## .env (เครื่องพัฒนา)

สร้างจาก `.env.example` (ค่าลับในนั้นว่างไว้) ไม่ต้องคัดลอกจากเครื่องเก่า: เครื่องพัฒนาใช้แต่ค่าทดสอบ ค่าจริงอยู่บนเซิร์ฟเวอร์เท่านั้น
(`/home/ubuntu/nukyok-data/.env` ห้ามคัดลอกลงเครื่อง)

ที่ต้องมีสำหรับพัฒนาและ e2e: `DATABASE_URL` (ตามที่ `db:dev` พิมพ์), `SESSION_SECRET` (`openssl rand -hex 32`), `APP_URL`
(`http://localhost:3000`), `DEV_LOGIN=1`, `UPLOAD_DIR` (`var/uploads` ได้บนเครื่องพัฒนา บนเซิร์ฟเวอร์ต้องเป็น absolute),
`CRON_SECRET`, `EXPRESS_SYNC_SECRET`, `EXPORT_SECRET` (3 ตัวหลังให้ตรงค่าเริ่มต้น CRON / EXPRESS / EXPORT ที่หัว
`var/e2e/e2e.mjs`; ค่า dev- ใช้ได้เฉพาะนอก production, ลิงก์ export ใช้ token ของแต่ละชุดที่คิดจาก `EXPORT_SECRET`)

ที่เว้นว่างได้บนเครื่องพัฒนา (ว่าง = LINE แค่พิมพ์ลง console, ไม่อ่านสลิป): `LIFF_ID`, `LINE_LOGIN_CHANNEL_ID`,
`LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_OFFICE_GROUP_ID`, `ADMIN_LINE_USER_IDS`,
`LINE_RICHMENU_<บทบาท>` (6 ตัว), `FUEL_REMIND_MINUTES`, `ATTENDANCE_END_HOUR`, `PM_WARN_HOURS`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
`EXPRESS_COMPANY`, `COMPANY_TAX_ID`

## ตรวจก่อนส่งงาน

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```

e2e ทุก flow (ทุกครั้งที่แก้ flow):
1. `npx prisma migrate reset --force --skip-generate` แล้ว `npm run db:seed` (ฐานข้อมูลสะอาด)
2. เปิด `node var/e2e/dev-tee.mjs` (next dev 127.0.0.1 พอร์ต 3001 เขียน log ลง `var/e2e/dev.log` ให้ e2e ตรวจข้อความ LINE ทุกข้อความ;
   ใน Claude desktop คือ preview "dev-e2e" ใน `.claude/launch.json`)
3. `cd var/e2e && BASE=http://localhost:3001 node e2e.mjs` ต้องจบด้วย `ALL OK`

## Deploy (เซิร์ฟเวอร์ที่ใช้ร่วมกับ 88arena / dhevakij / league)

- `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118` รายละเอียดทั้งหมดใน `DEPLOY.md`
- ห้ามกระทบแอปอื่นบนเครื่องนั้น: restart ได้แค่ PM2 `nukyok-web` และ nginx site ของ nukyok เท่านั้น
- ขั้นตอน (Git Bash ที่ D:\nukyok):
  1. ตรวจครบตามหัวข้อบน
  2. `tar czf <ที่ไหนก็ได้>/release.tgz --force-local --exclude=./node_modules --exclude=./.next --exclude=./var --exclude='./.env*' --exclude=./.claude --exclude=./tsconfig.tsbuildinfo .`
     (`--force-local` จำเป็นบน Windows: tar อ่าน `C:` ในพาธเป็นชื่อเครื่อง) release ที่มีไฟล์ `.env*` ของตัวเอง deploy.sh ไม่รับ
  3. `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'cat > /home/ubuntu/nukyok-data/release.tgz' < release.tgz`
  4. `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'bash -s -- /home/ubuntu/nukyok-data/release.tgz' < deploy/deploy.sh`
     (สำรองฐานข้อมูล, migrate, สลับ release, ถ้า `/api/health` ไม่ตอบ 200 ใน 30 วินาทีจะถอยกลับเอง)
  5. เช็ค: `https://nukyok.phuketnukyok.com/api/health` = `{"ok":true}`, `/login` = 307, office.phuketnukyok.com และ 88arena.com ยังตอบ,
     `pm2 jlist` (แอปอื่น restart count ไม่ขยับ), `~/.pm2/logs/nukyok-web-error.log`, ตัวเชื่อมเรียก `/api/express/*` ได้ 200 ใน nginx access log
- migration ต้องเป็นแบบเพิ่มอย่างเดียว (รันตอน release เก่ายังให้บริการ)
- ค่าลับใน `~/nukyok-data/.env` ต้องยาว 16 ตัวขึ้นไป ไม่มี change-me ไม่ขึ้นต้น dev- (บน production แอปถือว่าไม่ได้ตั้ง)
  `SESSION_SECRET`, `CRON_SECRET`, `EXPRESS_SYNC_SECRET` ที่ไม่มีหรืออ่อน ทำให้ `/api/health` ไม่ผ่านและ release ใหม่ถอยกลับ
  (`pm2 logs nukyok-web` บอกชื่อตัวแปร)

## ตัวเชื่อม Express (เครื่อง Office)

- ตัวที่ทำงานจริง: `C:\nukyok-agent` (Task Scheduler `nukyok-express-agent` เป็น SYSTEM ทุกนาที, `.env` ชี้ `D:\ACExpress\ExpressI\DHEWA66`)
  เปิดได้เฉพาะ SYSTEM และ Administrators: อ่าน log จาก Command Prompt แบบ Administrator
  (`copy C:\nukyok-agent\var\agent.log %USERPROFILE%\Desktop\`). แยกจากโฟลเดอร์พัฒนา D:\nukyok: ห้ามรัน dev / e2e / สคริปต์ทดสอบ
  กับโฟลเดอร์ Express จริง ทดสอบเขียนกับ TESTR3 จากเครื่องพัฒนากับเว็บ dev เท่านั้น (zip ต่อเว็บจริง ติดตั้งกับ TESTR3 ไม่ได้)
- แพ็ก: `bash deploy/pack-office.sh` (Git Bash) -> `~/nukyok-office-agent.zip` (นอก repo) อ่าน `EXPRESS_SYNC_SECRET` จากเซิร์ฟเวอร์ผ่าน ssh
  (zip มีรหัสลับ ห้ามส่งต่อ) ติดตั้ง: แตก zip ไปโฟลเดอร์ชั่วคราว -> `install.cmd` (Enter ตามค่าเดิม = DHEWA66 / น้ำมัน y / งานซ่อม y / เล่ม PO)
  แล้วลบโฟลเดอร์ที่แตกและ zip
- เขียนค้าง: ledger ใน `var\<ชนิด>-ledger` ที่ค้าง "writing" / "ROLLBACK-FAILED" หรืออ่านไม่ได้ หยุดการเขียนทั้งชนิดนั้น (น้ำมัน / ซ่อม / R3)
  จนคนย้อนบิลนั้นออกจาก Express ทั้งบิลตาม ledger แล้วย้ายไฟล์ออก (ขั้นตอนใน README-TH) ดู ledger ค้างแบบอ่านอย่างเดียว (ใช้โค้ดใน D:\nukyok ได้ทั้งก่อนและหลัง
  ติดตั้ง; import ไม่รันตัวเชื่อม) จาก Command Prompt แบบ Administrator:
  `cd /d D:\nukyok && node -e "import('./scripts/express-agent.mjs').then((m) => { for (const k of ['fuel', 'repair', 'r3']) for (const s of m.stuckLedgers('C:/nukyok-agent/var/' + k + '-ledger')) console.log(k, s.led.status, s.file) })"`
- ไม่ต้องแตะ Task "Dhevakij Express PO sync" และ registry ของ VFP (ของโปรเจคอื่น)

## Deploy ชุดแก้ตาม audit 24 พ.ย. 2569 (ยังไม่ได้ทำ)

ทำตามลำดับ:
1. migration `20261124120232_audit_fixes` เพิ่มอย่างเดียว (คอลัมน์ว่างได้ 3 ตัว): deploy ได้ตามปกติ
2. ก่อน deploy เช็ค `~/nukyok-data/.env` โดยไม่พิมพ์ค่า: `UPLOAD_DIR=/home/ubuntu/nukyok-data/uploads` (ถ้าไม่ absolute การสำรองก่อน
   deploy ล้มและ deploy หยุด; ถ้าเคยเป็น relative ย้ายไฟล์จาก release ที่ใช้อยู่ไปที่นั่นก่อน) และค่าลับตามหัวข้อ Deploy
   (`grep -E '^[A-Z_]+_SECRET=' ~/nukyok-data/.env | sed -E "s/[\"']//g" | awk -F= '{print $1, length($2), (length($2) < 16 || $2 ~ /change-me|^dev-/ ? "WEAK" : "ok")}'`:
   `SESSION_SECRET`, `CRON_SECRET`, `EXPRESS_SYNC_SECRET` ต้องขึ้นและเป็น ok) แล้ว deploy ตามหัวข้อ Deploy โดยยังไม่ตั้ง `EXPRESS_COMPANY`
3. ทุกคนต้องเข้าระบบใหม่ 1 ครั้ง (cookie เปลี่ยนชื่อ): ใน LINE เข้าให้เอง เบราว์เซอร์คอมผ่าน `/login`
   (บนเซิร์ฟเวอร์ยังไม่มีรายการ Express เลย: รายการทดสอบ TESTR3 ของ 18 พ.ย. ถูกลบไปแล้ว ไม่ต้องจัดการอะไร)
4. `EXPORT_SECRET` ค่าใหม่ (`openssl rand -hex 32` ห้ามใช้ค่า `EXPORT_TOKEN` เดิม) ใน `~/nukyok-data/.env` ลบ `EXPORT_TOKEN`
   แล้ว `pm2 restart nukyok-web --update-env`; Office คัดลอกสูตรของแต่ละชีตจากหน้าแรก หัวข้อ "สูตร Google Sheets" ไปแทนสูตรเดิม
   (สูตรเดิมใช้ไม่ได้ตั้งแต่ deploy)
5. nginx: แก้ไฟล์จริง `/etc/nginx/sites-available/nukyok` ด้วยมือ (ไฟล์ใน repo เป็นแบบก่อน certbot ห้ามคัดลอกทับ): ใส่
   `location /api/cron/ { return 404; }` และ `location /_next/image { return 404; }` ใน server ที่ listen 443 ก่อน `location /`,
   `sudo nginx -t`, `sudo systemctl reload nginx`; เช็ค `https://nukyok.phuketnukyok.com/api/cron/tick` = 404 และ `/login` = 307
6. ทดสอบตัวเขียนกับ TESTR3 (เครื่องพัฒนา: `npm run dev` + `npm run express:agent`, `.env` ชี้ `EXPRESS_DIR` ไป TESTR3 โหมด live):
   fuel-write.ps1, r3-write.ps1 และ repair-write.ps1 ถูกแก้ 24 พ.ย. และ 25 พ.ย.: รอบ 24 พ.ย. รันกับ TESTR3 แล้ว พบว่า kill แล้ว
   ค่าที่แก้ในแถวเดิม (ISRUN, STMAS) หาย แม้มี FLUSH. แก้ 25 พ.ย.: ทุกขั้นที่ REPLACE แถวเดิม (Change และตอนย้อนกลับ) GO กลับไปที่แถวนั้น
   อีกครั้งก่อน FLUSH. รันชุดนี้ครบทุกข้อกับ TESTR3 แล้ว 25 พ.ย. (02:31-03:23) ผ่านหมด ตรวจซ้ำทั้งบริษัทแล้วไม่มีปัญหา
   (สำรองก่อนรันที่ `var/testr3-backup-full-0231`). แก้ตัวเขียนอีกเมื่อไรต้องรันชุดนี้ใหม่ทั้งหมด
   - ปกติ: น้ำมัน PK + H3 (รวม H3 ลง PK ที่มีอยู่: ledger จบ done และมี pkNo), R3 แบบเปิดใหม่และแบบต่อท้าย,
     ซ่อม VAT 0 / 1 / 2 เทียบกับเอกสารที่พนักงานคีย์
   - `FUEL_TEST_FAIL_AT=before-apbal` แล้ว `=replace`, `R3_TEST_FAIL_AT=replace` (วันที่ยังไม่มี R3), `REPAIR_TEST_FAIL_AT=before-apbal`:
     ledger จบ rolled-back และ Express เหมือนก่อนรัน
   - kill: ledger ค้าง writing และตัวเชื่อมหยุดบิลชนิดนั้นทั้งหมด. ล้างทุกกรณีด้วยวิธีเดียวกับ README-TH (หัวข้อเขียนค้าง) คือย้อนทั้งบิลตาม
     ledger: ทุกแถวใน `added` ทำเครื่องหมายลบตามเลขระเบียนหลังตรวจเลขเอกสาร (ห้าม PACK) และแก้ทุกช่องใน `changed` กลับเป็นค่าเดิม (old)
     ทำจากรายการล่างสุดของ changed ขึ้นไป ช่องเดียวกันที่มีหลายรายการ ค่าที่ถูกคือ old ของรายการแรก (น้ำมันที่หยุดหลังแก้ของ H3 มี `fwsm totreo`
     2 รายการ: +ลิตร แล้ว −ลิตร; ledger ที่ย้อนเองบน TESTR3 มี STMAS 174 old 379.88 แล้ว 450.17). ก่อนแก้ตรวจค่าตาม README-TH
     (old หรือค่าที่บิลใส่ ค่าอื่นถามบัญชี) แล้วย้าย ledger ออกและกด "ลองใหม่" (ไม่ใช่ลบแค่แถว STCRD แล้วเก็บ PK ไว้: ถ้าค่าที่แก้ไม่ได้ลงดิสก์
     จำนวนค้างรับของรถจะขาด)
     - `FUEL_TEST_FAIL_AT=kill` (หลังบรรทัด STCRD ของ H3) เมื่อ PK เปิดใหม่ในรอบนี้ (changed มี fwrn และ fwsm; H3 ลง PK ที่มีอยู่ไม่มีสองช่องนี้
       ให้ตรวจ): ทันทีหลัง kill ก่อนล้าง อ่านจากโปรเซสใหม่และจากไบต์ของ .DBF:
       ISRUN เลขรัน PK = เลข PK ใน ledger + 1 และ STMAS `totreo` ของรถ = ค่าเดิมใน ledger + ลิตร (ไม่ใช่ค่าเดิม). หลังล้างและลองใหม่:
       PK และ H3 ได้เลขถัดไป (เลขที่ค้างถูกข้าม), `totreo` เท่ากับก่อนรันที่ถูก kill (PK รับครบใน H3), ISRUN เลขรัน PK = เลข PK ใหม่ + 1
     - `REPAIR_TEST_FAIL_AT=kill` (หลังบรรทัด STCRD ของ RR): ทันทีหลัง kill ISRUN เลขรัน PO = เลข PO ใน ledger + 1. หลังล้างและลองใหม่:
       PO และ RR ได้เลขถัดไป, ISRUN เลขรัน PO = เลข PO ใหม่ + 1, APMAS `balance` และ APBAL ของร้านขึ้นเท่ายอดบิลครั้งเดียว
     - `R3_TEST_FAIL_AT=kill` (หลังบรรทัดแรกที่เพิ่ม ยังไม่มี `changed`): แบบเปิดใหม่ R3 ถัดไปได้เลขถัดไป. แบบต่อท้าย (ทดสอบตัวกันเท่านั้น
       ห้ามทำกับข้อมูลจริง): ย้ายแค่ ledger ก่อน ยังไม่ลบบรรทัดที่เกิน R3 ของวันนั้นต้องไม่ถูกเขียน (ยอดบรรทัดไม่ตรงหัว) แล้วจึงย้อนทั้งบิล
       ตาม ledger ที่ย้ายออก (ลบบรรทัดที่เกิน) ต่อท้ายได้ และยอดเจ้าหนี้บัตรขึ้นเท่ายอดบิลครั้งเดียว
   - ใบกำกับเดียวแบ่งเติม 2 คัน คันแรกเปิดแค่ PK: คันที่สองต้องจบที่ "อาจซ้ำ" แล้ว Office กด "ยืนยันว่าไม่ซ้ำ" ในหน้า Express (เว็บ dev):
     รอบถัดไปคันที่สองได้ PK + H3 ของตัวเอง (เลข H3 ถัดไป) และ R3 ต่อท้ายได้
   - ปั๊มที่ไม่มีเลขผู้เสียภาษีใน Express: เว็บส่งแค่ PK และ fuel-write.ps1 ไม่รับ H3 ของปั๊มนั้น
7. แล้วจึงแพ็กและติดตั้งตัวเชื่อมชุดใหม่ (หัวข้อบน): ก่อนติดตั้งดู ledger ค้างด้วยคำสั่งข้างบน ถ้ามีให้ล้างตาม README-TH (ย้อนทั้งบิลตาม ledger) แล้วย้ายออกก่อน
   หลังติดตั้งลบ zip, โฟลเดอร์ที่แตก และ `C:\nukyok-agent-new` (มีสำเนา `.env` เก่า). ถ้าจะเปลี่ยน `EXPRESS_SYNC_SECRET` ทำก่อนแพ็ก:
   ค่าใหม่บนเซิร์ฟเวอร์ + restart (ตัวเชื่อมถูกปฏิเสธจนติดตั้ง zip ใหม่เสร็จ)
8. แล้วจึงตั้ง `EXPRESS_COMPANY=DHEWA66` (และ `COMPANY_TAX_ID` = เลขผู้เสียภาษี 13 หลักของบริษัท ถ้าจะให้เทียบผู้ซื้อในสลิป ไม่บังคับ)
   ใน `~/nukyok-data/.env` แล้ว `pm2 restart nukyok-web --update-env` (ตัวเชื่อมรุ่นก่อนไม่ส่งชื่อบริษัท จะได้ 409 ทุกครั้ง):
   เช็คว่า agent.log ไม่มี 409 และภายใน 15 นาที "ส่งข้อมูลล่าสุด" ในหน้า Express ใหม่กว่าเวลาที่ restart
9. Office ในหน้า Express ตั้ง "ยื่น ภ.พ.30 แล้วถึงเดือน". เช็ค `express_prices` บนเซิร์ฟเวอร์: ผู้ขายราว 430 ราย ราว 6,660 บรรทัด
   ไม่มีเลขประจำตัว 13 หลักของบุคคลธรรมดา

## เรื่องที่เจ้าของต้องตัดสินใจ / ทำเอง

- เครื่องที่เก็บ Express: ปิด Guest (`net user Guest /active:no`) เปิด password protected sharing, share ACExpress และสิทธิ์ NTFS ของ
  `D:\ACExpress` ให้เฉพาะบัญชีที่ใช้ Express (เอา Everyone ออก) แล้วทดสอบทุกเครื่องและไดรฟ์ Z: (ตัวเชื่อมเป็น SYSTEM ไม่กระทบ)
- SSH key `~/.ssh/id_88arena_vps` ไม่มี passphrase และอยู่บนเครื่อง Office: ทำ key ใหม่ที่มี passphrase (ใช้ผ่าน ssh-agent) ใส่บน VPS
  แล้วลบ key เดิม (เช็คก่อนว่าแอปอื่นบนเครื่องใช้ key เดียวกันไหม); เปลี่ยนชื่อไฟล์ต้องแก้ `pack-office.sh`, `DEPLOY.md` และไฟล์นี้
- repo: ทำเป็น private หรือ rewrite history (git filter-repo / BFG แล้ว force-push) เพราะประวัติมีข้อมูลจริงและรายละเอียดเซิร์ฟเวอร์
- รูปเซลฟี่และพิกัดเข้างาน: กำหนดระยะเวลาเก็บ (PDPA) และแจ้งพนักงาน ตอนนี้ไม่มีอะไรลบ (สำเนา offsite ก็ไม่ลบ)
- สลิปน้ำมันส่งไป Gemini แบบฟรี (Google ใช้ข้อมูลได้): ย้าย `GEMINI_API_KEY` ไปโปรเจกต์ที่เปิด billing, เปลี่ยนผู้ให้บริการ หรือปิดการอ่านสลิป
- ให้บัญชียืนยัน: เดือนภาษีปิดเองหลังวันที่ 15 ของเดือนถัดไป และงานซ่อมลงอัตโนมัติเฉพาะบัญชี 5360-xx

## สถานะงาน ณ วันที่ย้าย (จาก memory ของ Claude เครื่องเดิม)

- กติกา: ตอบผู้ใช้เป็นภาษาไทย, ห้ามแสดงค่าลับ (.env, secret, LINE id) ในข้อความ, ถามก่อนลบหรือเขียนทับข้อมูลจริง (สำรองก่อน),
  commit / push เมื่อผู้ใช้สั่งเท่านั้น, ไม่ใส่บรรทัด attribution ใน commit
- Express: น้ำมัน PK + H3 + R3 เปิดใช้กับ DHEWA66. งานซ่อม PO + RR (ซื้อเชื่อ) เปิดใช้ 18 พ.ย. ทดสอบกับ TESTR3 และบัญชีตรวจแล้ว
  เช็คฐานข้อมูลจริง 24 พ.ย. เย็น: ยังไม่มีรายการ Express (รายการทดสอบ TESTR3 18 พ.ย. ลบแล้ว) ไม่มีงานซ่อม มีคำขอน้ำมัน 1 รายการที่ยกเลิกแล้ว:
  บิลจริงใบแรกของน้ำมันและงานซ่อมให้บัญชีเปิดดูใน Express. VAT ของบิลซ่อมให้จัดซื้อเลือกตามใบกำกับ (พนักงานคีย์ต่างจาก APMAS หลายใบ).
  ตัวเขียนทั้ง 3 แก้แล้ว 24-25 พ.ย. ต่างจาก nukyoksoftware แล้ว ผ่านชุดทดสอบ TESTR3 ครบแล้ว 25 พ.ย. (หัวข้อชุดแก้ตาม audit)
- เทียบราคา (24 พ.ย.): ตัวเชื่อมส่งราคาซื้อ 2 ปี -> `/purchasing/prices` จับกลุ่มตามข้อความในบรรทัดบิล (ไม่ใช่รหัสบัญชี).
  ข้อมูลจริงของ DHEWA66 มีเงินเดือน / ค่าแรง / เงินยืมพนักงาน (มีชื่อคน) / เงินสดย่อย / ภาษี ปนในบิล RR PE SA HP:
  `purchaseItem`, `staffItem`, `person`, `company` (คู่กันใน `scripts/express/prices.mjs` และ `src/lib/prices.ts`) รับเฉพาะสินค้าที่จัดซื้อซื้อ
  ตัดผู้ขายที่เป็นพนักงาน และส่งบุคคลธรรมดาแค่ชื่อ ห้ามผ่อนกฎนี้. ค้าง: ชุดแก้ตาม audit ข้อ 7 และ 9
- เติมน้ำมัน (24 พ.ย.): คนขับส่งเลขไมค์ + รูป (ไม่บังคับ), คนเติมอ่านหน้าปัดเองพร้อมรูป ระบบเทียบส่วนต่างและแจ้งผิดปกติ
- ทดลองใช้น้ำมันกลุ่มเล็ก: รถ 41 คันนำเข้าจากแผนก Express (รหัสน้ำมันบางตัวใน Express มีช่องว่างแบบ 0xA0 เก็บตามจริง),
  ค่ามาตรฐานรถ (ลิตร/ชม., ถัง, รอบเช็คระยะ) ยังว่าง. ก่อนเปิดทุกคน: อัปเกรดแพ็กเกจ LINE OA (ฟรี 300 ข้อความ/เดือน)
  และเพิ่มผู้ใช้บทบาทผู้บริหาร / จัดซื้อ / บัญชี
- คำสั่งที่เคยส่งให้ Claude เครื่อง Office อยู่ใน `var/office-*.md` บนเครื่องเดิม (ไม่อยู่ใน git, ไม่จำเป็นต้องย้าย)
