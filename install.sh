#!/bin/bash
# Installs TicketSwap Alarm into ~/Library/Application Support/TicketSwapAlarm and registers
# the Mac helper with Chrome. Safe to re-run: your email and ntfy topic are kept.
#
#   ./install.sh you@example.com
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/Library/Application Support/TicketSwapAlarm"
HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
HOST_NAME="local.ticketswap_alarm"

mkdir -p "$DEST" "$HOSTS"
rsync -a --delete --exclude config.js --exclude control.json "$SRC/extension/" "$DEST/extension/"
rsync -a --delete "$SRC/host/" "$DEST/host/"
cp "$SRC/set-gmail-password.sh" "$SRC/test-alarm.sh" "$DEST/"
chmod +x "$DEST/host/"*.py "$DEST/"*.sh

# A new version here makes the running add-on reload itself within a minute.
VERSION=$(/opt/homebrew/bin/python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$DEST/extension/manifest.json")
echo "{\"version\": \"$VERSION\", \"test\": \"\"}" > "$DEST/extension/control.json"

if [ ! -f "$DEST/extension/config.js" ]; then
  EMAIL="${1:-}"
  TOPIC="ts-alarm-$(openssl rand -hex 8)"
  sed -e "s/__EMAIL__/$EMAIL/" -e "s/__TOPIC__/$TOPIC/" "$SRC/extension/config.example.js" > "$DEST/extension/config.js"
fi

# The manifest's "key" pins the add-on's ID, which Chrome needs to let it talk to the helper.
ID=$(/opt/homebrew/bin/python3 - "$DEST/extension/manifest.json" <<'PY'
import base64, hashlib, json, sys
key = base64.b64decode(json.load(open(sys.argv[1]))["key"])
print("".join(chr(ord("a") + int(c, 16)) for c in hashlib.sha256(key).hexdigest()[:32]))
PY
)

cat > "$HOSTS/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "TicketSwap Alarm Mac helper",
  "path": "$DEST/host/alarm_host.py",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$ID/"]
}
JSON

echo "Installed to: $DEST/extension"
echo "Add-on ID:    $ID"
grep -E "email|ntfyTopic" "$DEST/extension/config.js"
