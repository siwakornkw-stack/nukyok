# Deploy (VPS 15.235.208.118, shared with 88arena / dhevakij / league)

Rules on this box: touch nothing of the other apps. Own PM2 app, own port, own database + role, own nginx
site file, certificate only for this name, crontab lines only appended.

| what | value |
|---|---|
| ssh | `ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118` |
| app dir | `/home/ubuntu/nukyok` -> symlink to the live release in `/home/ubuntu/nukyok-releases/<time>` (the live one + 2 earlier kept) |
| data | `/home/ubuntu/nukyok-data`: `.env` (mode 600, linked into every release: edit this file, not the `~/nukyok/.env` link), `uploads/`, `cron.log`, `backup.log`, `deploy-failed.log` |
| backups | nightly 02:15 Bangkok `deploy/backup-db.sh`: `~/backups/nukyok-nightly-*` (14 days) + off the box to `dhkcrypt:nukyok` (rclone crypt over the Google Drive this box already uses for dhevakij; dumps 90 days, `uploads/` copied, never deleted). Failures are pushed to the Office over LINE (`/api/cron/alert`). Restore: `~/bin/rclone copy dhkcrypt:nukyok/<dump> /tmp/`, `gunzip -c ... \| psql` into an empty DB; files: `rclone copy dhkcrypt:nukyok/uploads <UPLOAD_DIR>` |
| PM2 | `nukyok-web` -> `127.0.0.1:3004` (`deploy/ecosystem.config.cjs`) |
| nginx | `/etc/nginx/sites-available/nukyok` (`deploy/nginx-nukyok.conf`) + certbot for `nukyok.phuketnukyok.com` |
| DB | PostgreSQL 127.0.0.1:5432, database `nukyok`, role `nukyok` |
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
# .env from .env.example: DATABASE_URL, SESSION_SECRET, APP_URL=https://nukyok.phuketnukyok.com, UPLOAD_DIR,
# CRON_SECRET, EXPORT_TOKEN, EXPRESS_SYNC_SECRET (openssl rand -hex 24 each), LINE values, DEV_LOGIN=0,
# GEMINI_API_KEY (slip reader, optional: aistudio.google.com)
```

## Every deploy (`deploy/deploy.sh`)

The new release is installed and built in its own folder while the old one keeps serving; the `~/nukyok` symlink is
switched only after a successful build, a pre-deploy database dump and `prisma migrate deploy`; when the new release
does not answer within 30 s the symlink goes back and PM2 restarts the old one. Failures are pushed to the Office.

1. Locally: `npx tsc --noEmit && npm run lint && npm test && npm run build`.
2. `tar czf release.tgz --exclude=./node_modules --exclude=./.next --exclude=./var --exclude=./.env --exclude=./.claude .`
3. `ssh ... 'cat > /home/ubuntu/nukyok-data/release.tgz' < release.tgz`
4. `ssh ... 'bash -s -- /home/ubuntu/nukyok-data/release.tgz' < deploy/deploy.sh`
5. Check: `curl -s -o /dev/null -w "%{http_code}" https://nukyok.phuketnukyok.com/login` = 307 (to LINE),
   `pm2 logs nukyok-web --err --nostream`.

Migrations run before the switch while the old release still serves: keep them additive. Manual rollback:
`ln -sfn ~/nukyok-releases/<older> ~/nukyok.next && mv -Tf ~/nukyok.next ~/nukyok && pm2 restart nukyok-web`.

One-time layout change (done 2026-11-09, from the old single folder): `mkdir ~/nukyok-releases && mv ~/nukyok
~/nukyok-releases/<time> && mv ~/nukyok-releases/<time>/.env ~/nukyok-data/.env && ln -s ~/nukyok-data/.env
~/nukyok-releases/<time>/.env && ln -s ~/nukyok-releases/<time> ~/nukyok` (the running process keeps working).

## Office PC (Express)

See README "Express Accounting". `bash deploy/pack-office.sh` builds `var/nukyok-office-agent.zip` (agent + installer +
a `.env` with this server's address and `EXPRESS_SYNC_SECRET`, so hand it over privately); on the office PC: extract,
double-click `install.cmd` (guide in Thai: `deploy/office/README-TH.txt`).
