// Settings every install starts with; config.js (email, ntfy topic, events) and whatever you
// change in the popup or dashboard are layered on top. Shared by worker.js and dashboard.js.
export const DEFAULT_OPTIONS = {
  enabled: true,
  minSeconds: 120, // random wait between checks; gentle on purpose
  maxSeconds: 240,
  pauseMinutes: 15, // pause after "too many refreshes"; doubles on repeats, up to 4×
  minAvailable: 1, // alert once at least this many tickets are listed
  alertMac: true,
  alertNotify: true,
  alertTab: true,
  alertEmail: true,
  alertPhone: true,
  alarmVolume: 80, // Mac volume while the alarm rings, 10-100
  alarmSeconds: 300, // how long the alarm rings unless you press Stop
  alarmVoice: true, // say "Tickets available" between sirens
};

// Keeps saved values inside sensible bounds whatever the popup or dashboard sends.
export function sanitize(s) {
  const int = (v, lo, hi, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  const out = { ...s };
  out.minSeconds = int(s.minSeconds, 30, 3600, DEFAULT_OPTIONS.minSeconds);
  out.maxSeconds = int(s.maxSeconds, out.minSeconds, 7200, out.minSeconds);
  out.pauseMinutes = int(s.pauseMinutes, 5, 120, DEFAULT_OPTIONS.pauseMinutes);
  out.minAvailable = int(s.minAvailable, 1, 20, 1);
  out.alarmVolume = int(s.alarmVolume, 10, 100, DEFAULT_OPTIONS.alarmVolume);
  out.alarmSeconds = int(s.alarmSeconds, 10, 1800, DEFAULT_OPTIONS.alarmSeconds);
  out.email = String(s.email || '').trim();
  out.events = (s.events || []).filter((ev) => ev && /^https:\/\/www\.ticketswap\.(com|nl)\//.test(ev.url));
  return out;
}

// When to stop checking an event: the time you set in the dashboard, otherwise 08:00 the morning
// after the date in its TicketSwap link (…-2026-10-31-<id>). null means no stop time.
export function eventStopAt(ev) {
  if (ev.stopAt) return ev.stopAt;
  const m = (ev.url || '').match(/-(\d{4})-(\d{2})-(\d{2})-[A-Za-z0-9]+$/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3] + 1, 8, 0).getTime() : null;
}
