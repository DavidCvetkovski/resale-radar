#!/bin/bash
# Makes the add-on ring a test alarm (Mac alarm, email and phone push) within a minute.
set -euo pipefail
CONTROL="$HOME/Library/Application Support/TicketSwapAlarm/extension/control.json"
/opt/homebrew/bin/python3 - "$CONTROL" <<'PY'
import json, sys, time
path = sys.argv[1]
control = json.load(open(path))
control["test"] = str(int(time.time()))
json.dump(control, open(path, "w"))
PY
echo "Test alarm queued: it rings within a minute (Chrome needs to be open)."
