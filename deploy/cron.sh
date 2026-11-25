#!/bin/sh
# Calls one cron job of the app: deploy/cron.sh tick|daily|weekly
# crontab (server TZ is UTC):
#   */10 * * * *  /home/ubuntu/nukyok/deploy/cron.sh tick   >> /home/ubuntu/nukyok-data/cron.log 2>&1
#   5 11 * * *    /home/ubuntu/nukyok/deploy/cron.sh daily  >> ...   (18:05 Bangkok)
#   0 1 * * 1     /home/ubuntu/nukyok/deploy/cron.sh weekly >> ...   (Monday 08:00 Bangkok)
# The secret goes to curl on stdin (-H @-), never on the command line where ps shows it.
# A refused or failed call (curl -f: HTTP 4xx / 5xx, no answer) is logged with curl's reason and ends with exit 1.
set -eu
SECRET=$(grep '^CRON_SECRET=' /home/ubuntu/nukyok/.env | head -1 | cut -d= -f2- | tr -d "\"'")
# Heartbeat of the nightly backup (deploy/backup-db.sh), with the daily job: a backup that stopped running (crontab line
# lost, killed before its own alert) tells no one. The newest local nightly dump must be under 26 hours old.
if [ "$1" = daily ] && [ -z "$(find /home/ubuntu/backups -maxdepth 1 -name 'nukyok-nightly-*.sql.gz' -mmin -1560 | head -1)" ]; then
  r=$(printf 'Authorization: Bearer %s\n' "$SECRET" | curl -fsS -m 20 -H @- -H 'Content-Type: application/json' -X POST \
    -d '{"text":"backup nukyok: no nightly dump in the last 26 hours (crontab line? ~/nukyok-data/backup.log)"}' \
    http://127.0.0.1:3004/api/cron/alert 2>&1) || true
  case "$r" in *'"sent":true'*) told="the Office was told" ;; *) told="the Office was NOT told (${r:-no answer})" ;; esac
  echo "$(date -u +%FT%TZ) backup FAILED: no nightly dump in the last 26 hours, $told"
fi
printf '%s %s ' "$(date -u +%FT%TZ)" "$1"
[ -n "$SECRET" ] || { echo "FAILED: no CRON_SECRET in /home/ubuntu/nukyok/.env"; exit 1; }
printf 'Authorization: Bearer %s\n' "$SECRET" | curl -fsS -m 120 -H @- "http://127.0.0.1:3004/api/cron/$1" ||
  { echo "FAILED (curl exit $?)"; exit 1; }
echo
