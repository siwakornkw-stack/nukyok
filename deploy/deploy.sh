#!/usr/bin/env bash
# Deploys a new release of nukyok next to the running one and switches only after it built; rolls back by itself
# when the new release does not answer. Runs on the server:
#   local:  tar czf release.tgz --exclude=./node_modules --exclude=./.next --exclude=./var --exclude=./.env --exclude=./.claude .
#           ssh <server> 'cat > /home/ubuntu/nukyok-data/release.tgz' < release.tgz
#           ssh <server> 'bash -s -- /home/ubuntu/nukyok-data/release.tgz' < deploy/deploy.sh
# Layout: ~/nukyok -> ~/nukyok-releases/<time> (a symlink: PM2, cron and nginx keep using ~/nukyok). .env and uploads
# live in ~/nukyok-data; .env is linked into every release. The live release, the one it replaced and one more are
# kept, so a manual rollback is:  ln -sfn ~/nukyok-releases/<older> ~/nukyok.next && mv -Tf ~/nukyok.next ~/nukyok && pm2 restart nukyok-web
# Migrations run against the live database before the switch: keep them additive (old code must still run on them).
# Every failure, also one outside the checked steps (e.g. a truncated upload), is pushed to the Office: before the
# switch the new release is removed and the live site is untouched, after it ~/nukyok goes back to the previous release.
# No pm2 save: the PM2 dump holds every app of this shared box, and the saved nukyok-web already runs ~/nukyok.
set -euo pipefail
TGZ="$1"
BASE=/home/ubuntu
LIVE=$BASE/nukyok
DATA=$BASE/nukyok-data
REL=$BASE/nukyok-releases/$(date -u +%Y%m%d-%H%M%S)
log() { echo "$(date -u '+%F %T') $*"; }
# The retries cover the seconds the app needs to answer again after the restart of a rollback.
alert() {
  local s
  s=$(grep '^CRON_SECRET=' "$DATA/.env" | head -1 | cut -d= -f2- | tr -d '"')
  printf 'Authorization: Bearer %s\n' "$s" | curl -s -m 20 --retry 5 --retry-delay 2 --retry-connrefused -o /dev/null \
    -H @- -H 'Content-Type: application/json' -X POST http://127.0.0.1:3004/api/cron/alert \
    -d "{\"text\":\"deploy nukyok: $1\"}" || true
}
# Before the switch. A failed release is removed (its log kept), so it never counts among the kept ones.
abort() {
  log "FAILED: $1"
  tail -30 "$REL/deploy.log" 2>/dev/null || true
  cp "$REL/deploy.log" "$DATA/deploy-failed.log" 2>/dev/null || true
  rm -rf "$REL"
  alert "$1"
  exit 1
}
# After the switch: back to PREV, carrying on whatever fails. REL is removed only once ~/nukyok has left it.
rollback() {
  set +e
  ln -sfn "$PREV" "$BASE/nukyok.next" && mv -Tf "$BASE/nukyok.next" "$LIVE"
  pm2 restart nukyok-web --update-env > /dev/null
  restarted=$?
  cp "$REL/deploy.log" "$DATA/deploy-failed.log" 2>/dev/null
  if [ "$restarted" -eq 0 ] && [ "$(readlink -f "$LIVE")" = "$PREV" ]; then
    rm -rf "$REL"
    alert "$1, rolled back to $(basename "$PREV")"
    log "rolled back to $PREV"
  else
    # REL is kept: the process may still run its code
    alert "$1, going back to $(basename "$PREV") FAILED (link $(basename "$(readlink -f "$LIVE")"), pm2 restart exit $restarted), check by hand"
    log "ROLLBACK FAILED: $LIVE -> $(readlink -f "$LIVE"), pm2 restart exit $restarted"
  fi
  exit 1
}

[ -L "$LIVE" ] || { log "$LIVE is not a symlink: do the one-time layout change in DEPLOY.md first"; exit 1; }
trap 'trap - ERR; abort "stopped at line $LINENO, live site unchanged"' ERR
mkdir -p "$REL"
tar xzf "$TGZ" -C "$REL"
ln -s "$DATA/.env" "$REL/.env"
find "$REL" -name '*.sh' -not -path '*/node_modules/*' -exec sed -i 's/\r$//' {} +
chmod +x "$REL"/deploy/*.sh
cd "$REL"
log "npm ci"
nice -n 10 npm ci --no-audit --no-fund > deploy.log 2>&1 || abort "npm ci failed, live site unchanged"
log "build"
nice -n 10 npm run build >> deploy.log 2>&1 || abort "build failed, live site unchanged"
log "database dump + migrations"
NAME=predeploy OFFSITE= APP_DIR="$REL" ./deploy/backup-db.sh >> deploy.log 2>&1 || abort "pre-deploy dump failed, live site unchanged"
npx prisma migrate deploy >> deploy.log 2>&1 || abort "prisma migrate deploy failed (database was dumped first), live site unchanged"

PREV=$(readlink -f "$LIVE")
trap 'trap - ERR; rollback "stopped at line $LINENO"' ERR
ln -sfn "$REL" "$BASE/nukyok.next"
mv -Tf "$BASE/nukyok.next" "$LIVE"
pm2 restart nukyok-web --update-env > /dev/null
ok=""
for i in 1 2 3 4 5 6; do
  sleep 5
  code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3004/login || true)
  case "$code" in 200 | 307) ok=1; break ;; esac
done
if [ -z "$ok" ]; then
  rollback "new release did not answer (last HTTP $code)"
fi
trap - ERR
log "live: $REL"
# Newest first, without REL and PREV (the last known-good one, maybe older after a manual rollback): one more is kept.
ls -1dt "$BASE"/nukyok-releases/*/ | { grep -vxF -e "$REL/" -e "$PREV/" || true; } | tail -n +2 | xargs -r rm -rf
rm -f "$TGZ"
