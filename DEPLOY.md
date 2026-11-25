# Deploy (VPS 15.235.208.118, shared with 88arena / dhevakij / league)

Rules on this box: touch nothing of the other apps. Own PM2 app, own port, own database + role, own nginx
site file, certificate only for this name, crontab lines only appended.

| what | value |
|---|---|
| ssh | `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118` |
| app dir | `/home/ubuntu/nukyok` -> symlink to the live release in `/home/ubuntu/nukyok-releases/<time>` (the live one + 2 earlier kept) |
| data | `/home/ubuntu/nukyok-data` (mode 700, set by every deploy): `.env` (mode 600, linked into every release: edit this file, not the `~/nukyok/.env` link), `uploads/` (`UPLOAD_DIR`, absolute: the app refuses a relative one; it makes folders 0700, files 0600), `cron.log`, `backup.log`, `deploy-failed.log` |
| backups | nightly 02:15 Bangkok `deploy/backup-db.sh`: `~/backups/nukyok-nightly-*` (mode 600, 14 days) + off the box to `dhkcrypt:nukyok` (rclone crypt over the Google Drive this box already uses for dhevakij; dumps 90 days, `uploads/` copied, never deleted). Failures (also an `UPLOAD_DIR` that is not an absolute folder) end with exit 1 and are pushed to the Office over LINE (`/api/cron/alert`); an alert LINE did not deliver is logged as "the Office was NOT told". `cron.sh` logs a refused call (HTTP 4xx / 5xx) as FAILED, and with the daily job alerts when the newest nightly dump is over 26 hours old (a backup that stopped running sends nothing itself). Restore: `~/bin/rclone copy dhkcrypt:nukyok/<dump> /tmp/`, `gunzip -c ... \| psql` into an empty DB; files: `rclone copy dhkcrypt:nukyok/uploads <UPLOAD_DIR>` |
| PM2 | `nukyok-web` -> `127.0.0.1:3004` (`deploy/ecosystem.config.cjs`) |
| nginx | `/etc/nginx/sites-available/nukyok` (`deploy/nginx-nukyok.conf`) + certbot for `nukyok.phuketnukyok.com`. `/api/cron/` and `/_next/image` answer 404 (the scripts call `127.0.0.1:3004`; no image optimizer). The live file holds certbot's lines: copy changes into it by hand, `sudo nginx -t`, then reload nginx |
| DB | PostgreSQL 127.0.0.1:5432, database `nukyok`, role `nukyok`. Table `AppSetting` holds rows the app makes itself (since 2026-11-24 also `vat_filed_through`, set by Office on `/office/express`, `express_stuck_alert` and `user_audit`) |
| DNS | A record `nukyok.phuketnukyok.com` -> `15.235.208.118` (Cloudflare, DNS only) |
| LINE | Provider `nukyok` (2005790738): OA "nukyok" `@224qrvme` (Messaging API channel 2012512320, webhook verified, auto-reply off, groups allowed), LINE Login channel "ระบบจัดการรถ" 2012512217 (Published, linked to the OA), LIFF `2012512217-G9cOlRdw` (endpoint `https://nukyok.phuketnukyok.com/liff`, Full, openid + profile, add friend normal). First Office user "ปาย" set 2026-11-09. No long-lived token: the app issues 15-minute stateless tokens from `LINE_CHANNEL_ID` + `LINE_CHANNEL_SECRET` (to use a long-lived one anyway: `ssh -t ... nukyok/deploy/set-line-token.sh`). Rich menus made 2026-11-09 (`scripts/richmenu.mjs`, ids in `.env`). |

## Installed 2026-11-09

DB role + database `nukyok`, `.env` (secrets generated on the server, mode 600, LINE values still empty),
`/etc/nginx/sites-available/nukyok` + symlink, PM2 `nukyok-web` saved in the dump, crontab lines appended (backup of
the previous crontab in `~/nukyok-data/crontab.bak-*`), first nightly dump ok. DNS A record in Cloudflare (DNS only,
like `office`) and `certbot --nginx -d nukyok.phuketnukyok.com --redirect` (TLS for this site only, auto-renewed;
nginx file before certbot in `~/nukyok-data/nginx-nukyok.pre-certbot`).
LINE values in `.env` and rich menus done 2026-11-09.

## First install

```bash
# DB (once)
sudo -u postgres psql -v ON_ERROR_STOP=1 -c "CREATE ROLE nukyok LOGIN PASSWORD '<random>'" -c "CREATE DATABASE nukyok OWNER nukyok"
mkdir -p -m 700 ~/nukyok-data ~/nukyok-data/uploads
# .env: releases leave every .env* out, .env.example too, so it comes from the repo on the dev PC:
#   ssh ... 'umask 077; set -C; cat > /home/ubuntu/nukyok-data/.env' < .env.example    (set -C: never over an existing one)
# then fill it in on the server (its secrets are blank: an empty one refuses everything, and so does one under 16
# characters, holding change-me or starting with dev-): DATABASE_URL, SESSION_SECRET,
# APP_URL=https://nukyok.phuketnukyok.com, UPLOAD_DIR=/home/ubuntu/nukyok-data/uploads (absolute),
# CRON_SECRET, EXPORT_SECRET, EXPRESS_SYNC_SECRET (openssl rand -hex 32 each), LINE values, DEV_LOGIN=0,
# EXPRESS_COMPANY=DHEWA66 (the Express company the office agent must report; another one is refused),
# COMPANY_TAX_ID=<the company's 13-digit tax ID> (a fuel slip with another buyer gets a flag),
# GEMINI_API_KEY (slip reader, optional: aistudio.google.com)
```

## Every deploy (`deploy/deploy.sh`)

The new release is installed and built in its own folder while the old one keeps serving; the `~/nukyok` symlink is
switched only after a successful build, a pre-deploy database dump and `prisma migrate deploy`; when the new release
does not answer `/api/health` with 200 within 30 s (it reads every table with every column the code expects: a missing
migration or no database fails it, and so does a `SESSION_SECRET` the session code refuses or, in production, an unset /
weak `CRON_SECRET` or `EXPRESS_SYNC_SECRET`: `pm2 logs nukyok-web` names the variable) the symlink goes back and PM2
restarts the old one. A weak `CRON_SECRET` can also stop the failure alert itself: the deploy output then says the
Office was NOT told. A release that holds an env file of its own (`.env.local`, `.env.production` ...: Next reads
them before `.env`) is refused. Failures are pushed to the Office.

1. Locally: `npx tsc --noEmit && npm run lint && npm test && npm run build`.
2. `tar czf release.tgz --exclude=./node_modules --exclude=./.next --exclude=./var --exclude='./.env*' --exclude=./.claude .`
3. `ssh ... 'cat > /home/ubuntu/nukyok-data/release.tgz' < release.tgz`
4. `ssh ... 'bash -s -- /home/ubuntu/nukyok-data/release.tgz' < deploy/deploy.sh`
5. Check: `curl -s https://nukyok.phuketnukyok.com/api/health` = `{"ok":true}`, `/login` = 307 (to LINE),
   `pm2 logs nukyok-web --err --nostream`.

Migrations run before the switch while the old release still serves: keep them additive. Manual rollback:
`ln -sfn ~/nukyok-releases/<older> ~/nukyok.next && mv -Tf ~/nukyok.next ~/nukyok && pm2 restart nukyok-web`.

One-time layout change (done 2026-11-09, from the old single folder): `mkdir ~/nukyok-releases && mv ~/nukyok
~/nukyok-releases/<time> && mv ~/nukyok-releases/<time>/.env ~/nukyok-data/.env && ln -s ~/nukyok-data/.env
~/nukyok-releases/<time>/.env && ln -s ~/nukyok-releases/<time> ~/nukyok` (the running process keeps working).

## Office PC (Express)

See CLAUDE.md "Express Accounting". `bash deploy/pack-office.sh` builds `~/nukyok-office-agent.zip` in the user's profile,
not in the repo (agent + installer + a `.env` with this server's address and `EXPRESS_SYNC_SECRET`, so hand it over
privately and delete it after the install); on the office PC: extract, double-click `install.cmd` (guide in Thai:
`deploy/office/README-TH.txt`).
The zip talks to this live server: install it only against the live company. The agent names its company (the
`EXPRESS_DIR` folder) on every call and, with `EXPRESS_COMPANY` set here, another one (a TESTR3 test install) is refused
with 409, so it can neither take real bills nor report them written. An agent from before 2026-11-24 names none and is
refused too, so the order is: deploy the server, install the new zip, then set `EXPRESS_COMPANY` and
`pm2 restart nukyok-web --update-env`. A zip whose writers (`scripts/express/*-write.ps1`) changed is installed only after
they passed on TESTR3. Writer tests on TESTR3 run only from the dev PC against the dev server (`npm run dev`, bound to
127.0.0.1, and `npm run express:agent` with a dev `.env`). The installer refuses a TESTR3 folder, pauses the task
while it replaces files (after the running agent's lock is free), runs the connection test with
`EXPRESS_MASTERS_ONLY=1` (masters with the real writer flags, nothing written, the lock left alone) and limits
`C:\nukyok-agent` to SYSTEM and Administrators (the agent's `TEMP` is `var\tmp` inside it).
