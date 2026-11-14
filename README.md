# TicketSwap Alarm

A Chrome extension plus a small macOS helper that watches TicketSwap event pages and alerts you the moment a ticket is listed: a loud Mac alarm, a Chrome notification, an email from your Gmail, and a push to your phone.

It reads the event page the way you would, in a pinned tab in your own Chrome, at a random interval you choose. It respects TicketSwap's limits: if TicketSwap shows a verification check or says "too many refreshes", it pauses, backs off, and tells you instead of trying to get around it.

## What's in here

| Path | What it is |
|---|---|
| `extension/` | The Chrome extension (Manifest V3) |
| `extension/worker.js` | Background worker: schedules checks, reads the page, logs history, sends alerts, backs off on rate limits |
| `extension/dashboard.html` / `.js` / `.css` | Dashboard and control panel: health, diagnosis, every check, charts, events, and all settings |
| `extension/popup.html` / `.js` | Toolbar popup with the basics and a link to the dashboard |
| `extension/defaults.js` | Default settings, value limits and the per-event stop time |
| `extension/config.example.js` | Template for your personal `config.js` (email, ntfy topic, events) |
| `host/alarm_host.py` | Native-messaging helper that Chrome calls to ring the Mac and send email |
| `host/ring.py` | The alarm: sets the volume, plays `siren.wav` and a voice, shows a Stop dialog, restores the volume |
| `install.sh` | Installs everything into `~/Library/Application Support/TicketSwapAlarm` and registers the helper with Chrome |
| `set-gmail-password.sh` | Stores a Gmail app password in the macOS Keychain for alert emails |
| `test-alarm.sh` | Makes the running extension fire a test alarm |

## Install (macOS, Google Chrome)

Needs Homebrew Python at `/opt/homebrew/bin/python3`.

1. Run the installer with the email address that should get alerts:

   ```bash
   ./install.sh you@gmail.com
   ```

   This creates `config.js` with your email and a private random ntfy topic, and keeps both on reinstall.
2. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   `~/Library/Application Support/TicketSwapAlarm/extension`.
3. Optional, for email alerts: create a Gmail app password at https://myaccount.google.com/apppasswords, then run

   ```bash
   ~/Library/Application\ Support/TicketSwapAlarm/set-gmail-password.sh you@gmail.com
   ```

4. Optional, for phone pushes: install the free ntfy app and subscribe to the topic shown in the dashboard.

After the first load, re-running `./install.sh` updates the extension by itself within one check: it notices the new version in `control.json` and reloads.

## Using it

Click the extension icon, then **Open dashboard**.

- **Overview:** health banner with quick controls, tiles (typical gap, alerts sent, failed checks, missed tickets, …), a table of every check, a diagnosis of anything going wrong, charts, setup and an event log. History is kept for 14 days and can be exported as CSV.
- **Controls:** turn checking on/off, set the random wait between checks (presets included), pause and resume, manage events and their stop time, choose which alerts fire and from how many tickets, set alarm volume, length and voice, and run single-channel tests (only the Mac alarm test makes noise).

Each event stops being checked at its stop time: by default 08:00 the morning after the date in its TicketSwap link, adjustable per event.

## Staying under TicketSwap's limits

In practice, a random wait of **49–131 s** (about 40 checks an hour) ran for days without trouble, while **49–100 s** (about 50 an hour) was rate-limited after roughly an hour. When TicketSwap says "too many refreshes", the extension pauses for 15 minutes (configurable), doubling up to 4× if it happens again, then resumes by itself. Refreshing TicketSwap yourself on the same network counts toward the same limit.

## Privacy

Your personal settings (`extension/config.js`, `extension/control.json`) are git-ignored. The Gmail app password lives only in the macOS Keychain, and check history stays in Chrome's local extension storage.
