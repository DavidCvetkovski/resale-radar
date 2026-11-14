#!/bin/bash
# Saves a Gmail app password in the macOS Keychain so Resale Radar can email you.
# Make one at https://myaccount.google.com/apppasswords (needs 2-Step Verification on).
#
#   ./set-gmail-password.sh you@gmail.com
set -euo pipefail
EMAIL="${1:?usage: $0 you@gmail.com}"
echo "Paste the 16-letter app password for $EMAIL and press Return, then paste it again when asked to retype it (nothing shows while you paste, that is normal):"
security add-generic-password -U -s TicketSwapAlarm-gmail -a "$EMAIL" -l "Resale Radar (Gmail app password)" -w
echo "Saved. Alert emails will now come from your Gmail."
