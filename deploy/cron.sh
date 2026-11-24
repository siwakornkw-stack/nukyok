#!/bin/sh
# Calls one cron job of the app: deploy/cron.sh tick|daily|weekly
# crontab (server TZ is UTC):
#   */10 * * * *  /home/ubuntu/nukyok/deploy/cron.sh tick   >> /home/ubuntu/nukyok-data/cron.log 2>&1
#   5 11 * * *    /home/ubuntu/nukyok/deploy/cron.sh daily  >> ...   (18:05 Bangkok)
#   0 1 * * 1     /home/ubuntu/nukyok/deploy/cron.sh weekly >> ...   (Monday 08:00 Bangkok)
# The secret goes to curl on stdin (-H @-), never on the command line where ps shows it.
set -eu
SECRET=$(grep '^CRON_SECRET=' /home/ubuntu/nukyok/.env | head -1 | cut -d= -f2- | tr -d '"')
printf '%s %s ' "$(date -u +%FT%TZ)" "$1"
printf 'Authorization: Bearer %s\n' "$SECRET" | curl -sS -m 120 -H @- "http://127.0.0.1:3004/api/cron/$1"
echo
