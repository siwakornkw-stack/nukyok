#!/bin/bash
# Builds ~/nukyok-office-agent.zip for the office PC that holds the Express data: the agent scripts,
# deploy/office (install.cmd, install.ps1, README-TH.txt) and a .env with the server's address and
# EXPRESS_SYNC_SECRET (read over ssh, never printed). The zip holds that secret, so it is built in this user's own temp
# folder and profile, never in the repo (other Windows accounts may read the checkout): hand it over privately and
# delete it after the install. It talks to the live server: install it only against the live company (EXPRESS_COMPANY
# there refuses any other, e.g. TESTR3); writer tests on TESTR3 run from the dev PC against the dev server.
#   bash deploy/pack-office.sh      (Git Bash on the dev PC; run again after changing scripts/express*)
set -euo pipefail
cd "$(dirname "$0")/.."
zip="$HOME/nukyok-office-agent.zip"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
mkdir -p "$out/scripts/express"
cp scripts/express-*.mjs "$out/scripts/"
cp scripts/express/* "$out/scripts/express/"
cp deploy/office/* "$out/"
secret=$(ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'sed -n "s/^EXPRESS_SYNC_SECRET=//p" /home/ubuntu/nukyok-data/.env | head -1' | tr -d "\"'\r")
[ -n "$secret" ] || { echo "EXPRESS_SYNC_SECRET is not set on the server" >&2; exit 1; }
printf "EXPRESS_SYNC_URL='https://nukyok.phuketnukyok.com'\r\nEXPRESS_SYNC_SECRET='%s'\r\n" "$secret" > "$out/.env"
rm -f "$zip"
powershell -NoProfile -Command "Compress-Archive -Path '$(cygpath -w "$out")\\*' -DestinationPath '$(cygpath -w "$zip")' -Force"
cygpath -w "$zip"
