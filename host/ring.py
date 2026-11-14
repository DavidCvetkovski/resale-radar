#!/opt/homebrew/bin/python3
"""Rings the Mac until you dismiss it: volume up, an alarm sound followed by a voice on repeat,
and a dialog with a Stop button. Your volume goes back to what it was afterwards.

Usage: ring.py TITLE MESSAGE [SECONDS] [VOLUME 10-100] [VOICE 1|0]
"""
import os
import subprocess
import sys
import threading
import time

SIREN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "siren.wav")
VOICE = "Tickets available on TicketSwap"


def osa(script):
    return subprocess.run(["osascript", "-e", script], capture_output=True, text=True).stdout.strip()


def q(text):
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def main():
    title, message = sys.argv[1], sys.argv[2]
    seconds = int(sys.argv[3]) if len(sys.argv) > 3 else 300
    volume = max(10, min(100, int(sys.argv[4]))) if len(sys.argv) > 4 else 80
    voice = sys.argv[5] != "0" if len(sys.argv) > 5 else True

    old_volume = osa("output volume of (get volume settings)")
    was_muted = osa("output muted of (get volume settings)") == "true"
    osa("set volume without output muted")
    osa(f"set volume output volume {volume}")

    stop = threading.Event()
    lock = threading.Lock()
    current = {}

    def play(cmd):
        # Starting a sound and Stop share the lock, so nothing new starts once Stop is pressed.
        with lock:
            if stop.is_set():
                return
            current["p"] = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        current["p"].wait()

    def loop():
        end = time.time() + seconds
        while not stop.is_set() and time.time() < end:
            play(["afplay", SIREN])
            if voice:
                play(["say", VOICE])
            else:
                time.sleep(0.5)
        stop.set()

    ringer = threading.Thread(target=loop, daemon=True)
    ringer.start()
    osa(f"display notification {q(message)} with title {q(title)}")
    choice = osa(
        f'display alert {q(title)} message {q(message)} as critical '
        f'buttons {{"Stop alarm", "Show Chrome"}} default button "Show Chrome" giving up after {seconds}'
    )

    with lock:
        stop.set()
        if current.get("p") and current["p"].poll() is None:
            current["p"].terminate()
    ringer.join(timeout=5)
    if old_volume.isdigit():
        osa(f"set volume output volume {old_volume}")
    if was_muted:
        osa("set volume with output muted")
    if "Show Chrome" in choice:
        subprocess.run(["open", "-a", "Google Chrome"])


if __name__ == "__main__":
    main()
