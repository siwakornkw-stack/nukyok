# ย้ายเครื่องพัฒนา (HANDOFF)

เขียน 24 พ.ย. 2569 ตอนย้ายงาน nukyok จากเครื่องพัฒนาเดิมไปเครื่อง Office (D:\nukyok พาธเดิม)
อ่านคู่กับ `CLAUDE.md` (กติกาโค้ดและ Express), `DEPLOY.md` (เซิร์ฟเวอร์) และ `deploy/office/README-TH.txt` (ตัวเชื่อม)

## โค้ดเก็บอย่างไร

- repo: https://github.com/siwakornkw-stack/nukyok (**public**, push ครั้งแรก 24 พ.ย. 2569) ที่เครื่องใหม่:
  `git clone https://github.com/siwakornkw-stack/nukyok.git D:\nukyok` (หรือถ้า clone จากไฟล์ bundle ไว้แล้ว
  `git remote set-url origin https://github.com/siwakornkw-stack/nukyok.git`). ก่อนวันนั้นไม่เคยใช้ git ประวัติจึงเริ่มที่ commit แรก
- repo เป็น public: ห้าม commit ค่าลับ (.env, key, token, รหัส LINE / Gemini) หรือข้อมูลส่วนตัวของพนักงาน ค่าลับอยู่ใน `.env` บนเซิร์ฟเวอร์เท่านั้น
- ที่ไม่อยู่ใน git (ดู `.gitignore`): `node_modules`, `.next`, `.env`, และ `var/` ยกเว้น `var/e2e` (สคริปต์ e2e + รูป/PDF ทดสอบใน
  `var/e2e/fixtures`). `var/pg` (ฐานข้อมูลทดสอบ), `var/uploads`, zip ตัวเชื่อม (มีรหัสลับ) ไม่ต้องย้าย สร้างใหม่ได้
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
npm run db:seed         # ผู้ใช้ทดสอบทุกบทบาท + รถ 3 คัน
npm run dev             # http://localhost:3000/login (เลือกผู้ใช้ทดสอบ)
```

ถ้า `db:dev` บอก "already running?" แต่ต่อไม่ได้ (เคยเจอ error 487 shared memory): `node scripts/dev-db.mjs stop` แล้ว `npm run db:dev` ใหม่

## .env (เครื่องพัฒนา)

สร้างจาก `.env.example` ไม่ต้องคัดลอกจากเครื่องเก่า: เครื่องพัฒนาใช้แต่ค่าทดสอบ ค่าจริงอยู่บนเซิร์ฟเวอร์เท่านั้น
(`/home/ubuntu/nukyok-data/.env` ห้ามคัดลอกลงเครื่อง)

ที่ต้องมีสำหรับพัฒนาและ e2e: `DATABASE_URL` (ตามที่ `db:dev` พิมพ์), `SESSION_SECRET` (สุ่ม 16+ ตัว), `APP_URL`
(`http://localhost:3000`), `DEV_LOGIN=1`, `UPLOAD_DIR` (เช่น `var/uploads`), `CRON_SECRET`, `EXPRESS_SYNC_SECRET`,
`EXPORT_TOKEN` (3 ตัวหลังให้ตรงค่าเริ่มต้น CRON / EXPRESS / EXPORT ที่หัว `var/e2e/e2e.mjs`)

ที่เว้นว่างได้บนเครื่องพัฒนา (ว่าง = LINE แค่พิมพ์ลง console, ไม่อ่านสลิป): `LIFF_ID`, `LINE_LOGIN_CHANNEL_ID`,
`LINE_CHANNEL_ID`, `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_OFFICE_GROUP_ID`, `ADMIN_LINE_USER_IDS`,
`LINE_RICHMENU_<บทบาท>` (6 ตัว), `FUEL_REMIND_MINUTES`, `ATTENDANCE_END_HOUR`, `PM_WARN_HOURS`, `GEMINI_API_KEY`, `GEMINI_MODEL`

## ตรวจก่อนส่งงาน

```bash
npx tsc --noEmit && npm run lint && npm test && npm run build
```

e2e ทุก flow (ทุกครั้งที่แก้ flow):
1. `npx prisma migrate reset --force --skip-generate` แล้ว `npm run db:seed` (ฐานข้อมูลสะอาด)
2. เปิด `node var/e2e/dev-tee.mjs` (next dev พอร์ต 3001 เขียน log ลง `var/e2e/dev.log` ให้ e2e ตรวจข้อความ LINE ทุกข้อความ;
   ใน Claude desktop คือ preview "dev-e2e" ใน `.claude/launch.json`)
3. `cd var/e2e && BASE=http://localhost:3001 node e2e.mjs` ต้องจบด้วย `ALL OK`

## Deploy (เซิร์ฟเวอร์ที่ใช้ร่วมกับ 88arena / dhevakij / league)

- `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118` รายละเอียดทั้งหมดใน `DEPLOY.md`
- ห้ามกระทบแอปอื่นบนเครื่องนั้น: restart ได้แค่ PM2 `nukyok-web` และ nginx site ของ nukyok เท่านั้น
- ขั้นตอน (Git Bash ที่ D:\nukyok):
  1. ตรวจครบตามหัวข้อบน
  2. `tar czf <ที่ไหนก็ได้>/release.tgz --force-local --exclude=./node_modules --exclude=./.next --exclude=./var --exclude=./.env --exclude=./.claude --exclude=./tsconfig.tsbuildinfo .`
     (`--force-local` จำเป็นบน Windows: tar อ่าน `C:` ในพาธเป็นชื่อเครื่อง) แล้วเช็คว่าไม่มี `.env` ในไฟล์
  3. `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'cat > /home/ubuntu/nukyok-data/release.tgz' < release.tgz`
  4. `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'bash -s -- /home/ubuntu/nukyok-data/release.tgz' < deploy/deploy.sh`
     (สำรองฐานข้อมูล, migrate, สลับ release, ถ้า `/login` ไม่ตอบใน 30 วินาทีจะถอยกลับเอง)
  5. เช็ค: `https://nukyok.phuketnukyok.com/login` = 307, office.phuketnukyok.com และ 88arena.com ยังตอบ, `pm2 jlist`
     (แอปอื่น restart count ไม่ขยับ), `~/.pm2/logs/nukyok-web-error.log`, ตัวเชื่อมเรียก `/api/express/*` ได้ 200 ใน nginx access log
- migration ต้องเป็นแบบเพิ่มอย่างเดียว (รันตอน release เก่ายังให้บริการ)

## ตัวเชื่อม Express (เครื่อง Office)

- ตัวที่ทำงานจริง: `C:\nukyok-agent` (Task Scheduler `nukyok-express-agent` เป็น SYSTEM ทุกนาที, `.env` ชี้ `D:\ACExpress\ExpressI\DHEWA66`)
  แยกจากโฟลเดอร์พัฒนา D:\nukyok: ห้ามรัน dev / e2e / สคริปต์ทดสอบกับโฟลเดอร์ Express จริง ทดสอบเขียนกับ TESTR3 เท่านั้น
- แพ็ก: `bash deploy/pack-office.sh` (Git Bash) -> `var/nukyok-office-agent.zip` อ่าน `EXPRESS_SYNC_SECRET` จากเซิร์ฟเวอร์ผ่าน ssh
  (zip มีรหัสลับ ห้ามส่งต่อ ลบหลังติดตั้ง) ติดตั้ง: แตก zip ไปโฟลเดอร์ชั่วคราว -> `install.cmd` (Enter ตามค่าเดิม = DHEWA66 / น้ำมัน y / งานซ่อม y / เล่ม PO)
- ไม่ต้องแตะ Task "Dhevakij Express PO sync" และ registry ของ VFP (ของโปรเจคอื่น)

## สถานะงาน ณ วันที่ย้าย (จาก memory ของ Claude เครื่องเดิม)

- กติกา: ตอบผู้ใช้เป็นภาษาไทย, ห้ามแสดงค่าลับ (.env, secret, LINE id) ในข้อความ, ถามก่อนลบหรือเขียนทับข้อมูลจริง (สำรองก่อน),
  commit / push เมื่อผู้ใช้สั่งเท่านั้น, ไม่ใส่บรรทัด attribution ใน commit
- Express: น้ำมัน PK + H3 + R3 ใช้จริงกับ DHEWA66. งานซ่อม PO + RR (ซื้อเชื่อ) เปิดใช้จริง 18 พ.ย. ทดสอบกับ TESTR3 และบัญชีตรวจแล้ว
  แต่บิลซ่อมจริงใบแรกยังไม่มี: ใบแรกให้บัญชีเปิดดูใน Express. VAT ของบิลซ่อมให้จัดซื้อเลือกตามใบกำกับ (staff คีย์ต่างจาก APMAS 83/576 ใบ)
- เทียบราคา (24 พ.ย.): ตัวเชื่อมส่งราคาซื้อ 2 ปี -> `/purchasing/prices` จับกลุ่มตามข้อความในบรรทัดบิล (ไม่ใช่รหัสบัญชี).
  ข้อมูลจริงของ DHEWA66 มีเงินเดือน / ค่าแรง / เงินยืมพนักงาน (มีชื่อคน) / เงินสดย่อย / ภาษี ปนในบิล RR PE SA HP:
  `purchaseItem` (ทั้งใน `scripts/express/prices.mjs` และ `src/lib/prices.ts`) รับเฉพาะสินค้าที่จัดซื้อซื้อ ห้ามผ่อนกฎนี้.
  ค้าง: ติดตั้ง zip ชุด 24 พ.ย. 14:36 ขึ้นไป (กรองที่ต้นทาง) แล้วเช็คบนเซิร์ฟเวอร์ว่า `express_prices` มีผู้ขายราว 500 ราย
  (ตอนนี้รายชื่อผู้ขายว่างเพราะคำสั่งล้างข้อมูลพลาด จะกลับมาเมื่อตัวเชื่อมส่งรอบใหม่) และไม่มีรายการเงินเดือน
- เติมน้ำมัน (24 พ.ย.): คนขับส่งเลขไมค์ + รูป (ไม่บังคับ), คนเติมอ่านหน้าปัดเองพร้อมรูป ระบบเทียบส่วนต่างและแจ้งผิดปกติ
- ทดลองใช้น้ำมันกลุ่มเล็ก: รถ 41 คันนำเข้าจากแผนก Express (รหัสน้ำมันบางตัวใน Express มีช่องว่างแบบ 0xA0 เก็บตามจริง),
  ค่ามาตรฐานรถ (ลิตร/ชม., ถัง, รอบเช็คระยะ) ยังว่าง. ก่อนเปิดทุกคน: อัปเกรดแพ็กเกจ LINE OA (ฟรี 300 ข้อความ/เดือน)
  และเพิ่มผู้ใช้บทบาทผู้บริหาร / จัดซื้อ / บัญชี
- คำสั่งที่เคยส่งให้ Claude เครื่อง Office อยู่ใน `var/office-*.md` บนเครื่องเดิม (ไม่อยู่ใน git, ไม่จำเป็นต้องย้าย)
