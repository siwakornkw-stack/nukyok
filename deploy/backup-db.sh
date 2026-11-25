#!/usr/bin/env bash
# Nightly backup of nukyok: the database AND the uploaded files, kept on this box and copied off it.
#   crontab:  15 19 * * *  /home/ubuntu/nukyok/deploy/backup-db.sh >> /home/ubuntu/nukyok-data/backup.log 2>&1
# Local: ~/backups/nukyok-<NAME>-<time>.sql.gz (mode 600). nukyok-nightly-* and nukyok-predeploy-* (deploy.sh) files
# older than KEEP_DAYS days are removed; nothing else in the folder is touched.
# Off the box: OFFSITE (rclone remote path, default dhkcrypt:nukyok, the encrypted Google Drive remote this box already
# uses for dhevakij, in its own folder): the dump, pruned after OFFSITE_KEEP_DAYS, and UPLOAD_DIR copied to
# <OFFSITE>/uploads (copy, never sync: a file deleted here stays offsite). An empty OFFSITE skips every offsite step:
# deploy.sh passes OFFSITE= so its pre-deploy dumps stay on this box only. dhevakij's prune only matches its own
# dhevakij-nightly-* names, so the two never touch each other's files.
# UPLOAD_DIR must be an absolute folder, also for the pre-deploy dump: a relative one (the app's fallback) lives inside
# a release, which deploys remove, so the run fails (once the dump is kept) instead of skipping the photos and bills.
# Any failure is pushed to the Office through the app (/api/cron/alert), ends the run with exit 1 and leaves no
# half-written dump behind; an alert that did not reach the Office (LINE refused, wrong secret) is written to the log.
set -euo pipefail
umask 077 # dumps readable by this user only
APP_DIR="${APP_DIR:-/home/ubuntu/nukyok}"
BACKUP_DIR="${BACKUP_DIR:-/home/ubuntu/backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
OFFSITE="${OFFSITE-dhkcrypt:nukyok}" # no colon: only an unset OFFSITE gets the default, OFFSITE= stays empty
OFFSITE_KEEP_DAYS="${OFFSITE_KEEP_DAYS:-90}"
NAME="${NAME:-nightly}" # deploy.sh takes a local-only "predeploy" dump with NAME=predeploy OFFSITE=
RCLONE="${RCLONE:-$(command -v rclone || echo "$HOME/bin/rclone")}"
log() { echo "$(date -u '+%F %T') $*"; }
envval() { grep -E "^$1=" "$APP_DIR/.env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

# Tell the Office over LINE (through the app). The secret goes in on stdin, not on the command line. The app answers
# {"ok":true,"sent":false} when LINE refused the message: anything but "sent":true is logged as not told.
alert() {
  local secret res
  secret=$(envval CRON_SECRET || true)
  [ -n "$secret" ] || { log "WARN: no CRON_SECRET in $APP_DIR/.env, the Office was NOT told"; return 0; }
  res=$(printf 'Authorization: Bearer %s\n' "$secret" | curl -fsS -m 20 -H @- -H "Content-Type: application/json" \
    -X POST "http://127.0.0.1:3004/api/cron/alert" -d "{\"text\":\"backup nukyok: $1\"}" 2>&1) || true
  case "$res" in *'"sent":true'*) ;; *) log "WARN: the Office was NOT told (${res:-no answer})" ;; esac
}
fail() { log "ERROR: $*"; alert "$*"; exit 1; }
trap 'fail "unexpected error at line $LINENO"' ERR

# Connection from DATABASE_URL into libpq variables (not pg_dump arguments: those show in ps).
url=$(envval DATABASE_URL)
[ -n "$url" ] || fail "DATABASE_URL not found in $APP_DIR/.env"
url="${url%%\?*}"
rest="${url#*://}"
creds="${rest%%@*}"
hostpart="${rest#*@}"
hp="${hostpart%%/*}"
export PGUSER="${creds%%:*}" PGPASSWORD="${creds#*:}"
export PGHOST="${hp%%:*}" PGDATABASE="${hostpart##*/}"
case "$hp" in *:*) export PGPORT="${hp##*:}" ;; esac

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/nukyok-$NAME-$(date -u +%Y%m%d-%H%M%S).sql.gz"
tmp="$out.part"
if ! pg_dump --no-owner --no-privileges | gzip > "$tmp"; then
  rm -f "$tmp"
  fail "pg_dump failed"
fi
gzip -t "$tmp" || { rm -f "$tmp"; fail "dump is not a valid gzip"; }
size=$(stat -c %s "$tmp")
if [ "$size" -lt 1024 ]; then
  rm -f "$tmp"
  fail "dump is only $size bytes, not keeping it"
fi
mv "$tmp" "$out"
log "OK $out ($size bytes)"
find "$BACKUP_DIR" -maxdepth 1 \( -name 'nukyok-nightly-*.sql.gz' -o -name 'nukyok-predeploy-*.sql.gz' \) \
  -mtime +"$KEEP_DAYS" -print -delete | sed "s/^/$(date -u '+%F %T') removed /"

if [ -n "$OFFSITE" ]; then
  "$RCLONE" copy "$out" "$OFFSITE" || fail "local dump OK but copying it to $OFFSITE failed"
  log "copied dump to $OFFSITE"
  # predeploy: the ones earlier deploys uploaded while OFFSITE= still meant the default
  "$RCLONE" delete "$OFFSITE" --min-age "${OFFSITE_KEEP_DAYS}d" --include 'nukyok-nightly-*.sql.gz' \
    --include 'nukyok-predeploy-*.sql.gz' || log "WARN: offsite prune failed"
fi

uploads=$(envval UPLOAD_DIR || true)
case "$uploads" in
  /*) [ -d "$uploads" ] || fail "dump OK but UPLOAD_DIR $uploads is not a folder: photos and bills are not backed up" ;;
  *) fail "dump OK but UPLOAD_DIR in .env is '$uploads', not an absolute folder: photos and bills are not backed up" \
    "(a relative one is inside the release, which deploys remove)" ;;
esac
if [ -n "$OFFSITE" ]; then
  "$RCLONE" copy "$uploads" "${OFFSITE%/}/uploads" || fail "dump OK but copying uploads to $OFFSITE/uploads failed"
  log "copied $uploads to ${OFFSITE%/}/uploads"
fi
