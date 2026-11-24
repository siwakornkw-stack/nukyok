#!/bin/bash
# Builds var/nukyok-office-agent.zip for the office PC that holds the Express data: the agent scripts,
# deploy/office (install.cmd, install.ps1, README-TH.txt) and a .env with the server's address and
# EXPRESS_SYNC_SECRET (read over ssh, never printed). The zip holds that secret: hand it over privately.
#   bash deploy/pack-office.sh      (Git Bash on the dev PC; run again after changing scripts/express*)
set -euo pipefail
cd "$(dirname "$0")/.."
out=var/office-agent
rm -rf "$out" var/nukyok-office-agent.zip
mkdir -p "$out/scripts/express"
cp scripts/express-*.mjs "$out/scripts/"
cp scripts/express/* "$out/scripts/express/"
cp deploy/office/* "$out/"
secret=$(ssh -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 'sed -n "s/^EXPRESS_SYNC_SECRET=//p" /home/ubuntu/nukyok-data/.env | head -1' | tr -d "\"'\r")
[ -n "$secret" ] || { echo "EXPRESS_SYNC_SECRET is not set on the server" >&2; exit 1; }
printf "EXPRESS_SYNC_URL='https://nukyok.phuketnukyok.com'\r\nEXPRESS_SYNC_SECRET='%s'\r\n" "$secret" > "$out/.env"
powershell -NoProfile -Command "Compress-Archive -Path 'var/office-agent/*' -DestinationPath 'var/nukyok-office-agent.zip' -Force"
rm -rf "$out"
echo "var/nukyok-office-agent.zip"
