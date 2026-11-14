#!/opt/homebrew/bin/python3
"""Chrome native-messaging host for the TicketSwap Alarm add-on.

Chrome starts this for each message. On {"cmd": "ring"} it launches ring.py in its own
session (so the alarm keeps going after Chrome closes this process) and answers {"ok": true}.
On {"cmd": "email"} it sends the email from Gmail, using the app password that
set-gmail-password.sh stored in the macOS Keychain.
"""
import json
import os
import smtplib
import struct
import subprocess
import sys
import time
from email.message import EmailMessage

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.expanduser("~/Library/Logs/TicketSwapAlarm.log")
KEYCHAIN_SERVICE = "TicketSwapAlarm-gmail"


def log(line):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {line}\n")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    return json.loads(sys.stdin.buffer.read(length))


def send(obj):
    data = json.dumps(obj).encode()
    sys.stdout.buffer.write(struct.pack("=I", len(data)) + data)
    sys.stdout.buffer.flush()


def send_email(to, subject, body):
    found = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", to, "-w"],
        capture_output=True,
        text=True,
    )
    if found.returncode != 0:
        return {"ok": False, "error": "no Gmail app password yet, run set-gmail-password.sh"}
    mail = EmailMessage()
    mail["From"] = f"TicketSwap Alarm <{to}>"
    mail["To"] = to
    mail["Subject"] = subject
    mail.set_content(body)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=20) as smtp:
            smtp.login(to, found.stdout.strip().replace(" ", ""))
            smtp.send_message(mail)
    except Exception as e:  # noqa: BLE001 - reported back to the add-on
        log(f"email failed: {e}")
        return {"ok": False, "error": str(e)[:120]}
    return {"ok": True}


def main():
    msg = read_message() or {}
    cmd = msg.get("cmd")
    log(f"got {cmd}: {msg.get('title', '')}")
    if cmd == "ring":
        with open(LOG, "a") as err:
            subprocess.Popen(
                [
                    sys.executable,
                    os.path.join(HERE, "ring.py"),
                    msg.get("title", ""),
                    msg.get("message", ""),
                    str(msg.get("seconds", 300)),
                    str(msg.get("volume", 80)),
                    "1" if msg.get("voice", True) else "0",
                ],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=err,
                start_new_session=True,
            )
        send({"ok": True})
    elif cmd == "email":
        send(send_email(msg.get("to", ""), msg.get("subject", ""), msg.get("body", "")))
    elif cmd == "ping":
        send({"ok": True})
    else:
        send({"ok": False, "error": f"unknown command {cmd}"})


if __name__ == "__main__":
    main()
