#!/bin/sh
# Puts the LINE channel access token into ~/nukyok-data/.env (the real file every release links to) without it passing
# through a chat or a command line, and only after LINE accepted it:
#   ssh -t -i ~/.ssh/id_88arena_vps ubuntu@15.235.208.118 nukyok/deploy/set-line-token.sh
set -eu
ENV=/home/ubuntu/nukyok-data/.env
printf 'วาง Channel access token (long-lived) แล้วกด Enter: '
stty -echo
read -r T
stty echo
echo
case "$T" in "" | *[!A-Za-z0-9+/=]*) echo "token ไม่ถูกต้อง ไม่ได้บันทึก"; exit 1 ;; esac
# printf is a builtin: the token reaches curl on stdin, not in its arguments
printf 'Authorization: Bearer %s\n' "$T" | curl -sf -m 20 -H @- https://api.line.me/v2/bot/info >/dev/null ||
  { echo "LINE ไม่รับ token นี้ ไม่ได้บันทึก"; exit 1; }
umask 077
cp "$ENV" "/home/ubuntu/nukyok-data/env.bak-$(date -u +%Y%m%dT%H%M%SZ)"
# Not sed -i (it would swap the file for a new one): rewrite it in place so it keeps its inode and mode 600.
# The token goes to awk in its environment, not in its arguments.
tmp=$(mktemp "$ENV.XXXXXX")
T="$T" awk 'BEGIN { v = "LINE_CHANNEL_ACCESS_TOKEN=\"" ENVIRON["T"] "\"" }
  /^LINE_CHANNEL_ACCESS_TOKEN=/ { print v; found = 1; next }
  { print }
  END { if (!found) print v }' "$ENV" > "$tmp"
cat "$tmp" > "$ENV"
rm -f "$tmp"
pm2 restart nukyok-web --update-env >/dev/null
echo "LINE รับ token นี้ บันทึกแล้ว และ restart แอปแล้ว"
