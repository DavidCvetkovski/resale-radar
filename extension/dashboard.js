// Dashboard and control panel for Resale Radar. The Overview reads the check history and
// events that worker.js logs to chrome.storage.local (health, diagnosis, charts, every check);
// Controls changes settings and runs commands through messages to worker.js.

import { DEFAULTS } from './config.js';
import { DEFAULT_OPTIONS, eventStopAt } from './defaults.js';
const RANGES = [
  ['1h', 'Last hour', 36e5],
  ['6h', '6 hours', 6 * 36e5],
  ['24h', '24 hours', 864e5],
  ['7d', '7 days', 7 * 864e5],
  ['all', 'All', Infinity],
];
const STATUS = {
  ok: { label: 'Worked', glyph: '✓', level: 'good' },
  blocked: { label: 'Verification check', glyph: '!', level: 'serious' },
  error: { label: 'Failed', glyph: '✕', level: 'critical' },
  limited: { label: 'Rate-limited', glyph: '⏸', level: 'serious' },
};
const EVENT_LOOK = {
  start: ['▶', 'info'],
  update: ['↻', 'info'],
  settings: ['⚙', 'info'],
  helper: ['⚙', 'info'],
  problem: ['✕', 'critical'],
  blocked: ['!', 'serious'],
  limited: ['⏸', 'serious'],
  paused: ['⏸', 'serious'],
  recovered: ['✓', 'good'],
  resumed: ['▶', 'good'],
  ended: ['■', 'info'],
  skipped: ['»', 'warning'],
  watchdog: ['⏱', 'warning'],
  alert: ['🎟', 'good'],
  test: ['🧪', 'info'],
};
const LEVEL_ORDER = { critical: 0, serious: 1, warning: 2, good: 3, info: 4 };
const PAGE_SIZE = 100;
const NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
let rangeKey = readPref('range', '24h');
let eventFilter = 'all';
let problemsOnly = false;
let page = 0;
let data = null;

function readPref(key, fallback) {
  try {
    return localStorage.getItem(`dash.${key}`) || fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(`dash.${key}`, value);
  } catch {
    // Storage blocked; the choice just isn't remembered.
  }
}

// ---------- formatting ----------

// Each number keeps its unit on the same line (non-breaking spaces).
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const s = Math.abs(ms) / 1000;
  if (s < 10) return `${s.toFixed(1)}\u00a0s`;
  if (s < 60) return `${Math.round(s)}\u00a0s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}\u00a0m ${Math.round(s % 60)}\u00a0s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}\u00a0h ${m % 60}\u00a0m`;
  return `${Math.floor(h / 24)}\u00a0d ${h % 24}\u00a0h`;
}

const fmtAgo = (t) => (t ? `${fmtDur(Date.now() - t)} ago` : 'never');

function fmtClock(t, seconds = true) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

const pct = (a, b) => (b ? `${Math.round((a / b) * 1000) / 10}%` : '–');
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function quantile(xs, q) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// Round axis: a 1/2/2.5/5 × 10^n step and a max that is a whole number of steps.
function niceScale(v, count = 4) {
  const raw = Math.max(v, 1) / count;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= raw);
  return { step, max: Math.ceil(v / step) * step || step };
}

// ---------- loading ----------

function bucketEnd(key) {
  const s = key.slice(5);
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10) + 1).getTime();
}

async function load() {
  $('loading').textContent = 'Loading…';
  const base = await chrome.storage.local.get(['histIndex', 'events', 'settings', 'state', 'helper', 'nextCheck', 'lastAlert', 'pausedUntil', 'pauseReason']);
  const span = RANGES.find((r) => r[0] === rangeKey)[2];
  const since = Number.isFinite(span) ? Date.now() - span : 0;
  const keys = (base.histIndex || []).filter((k) => bucketEnd(k) > since);
  const buckets = keys.length ? await chrome.storage.local.get(keys) : {};
  const checks = keys
    .flatMap((k) => buckets[k] || [])
    .filter((c) => c.t >= since && (eventFilter === 'all' || c.url === eventFilter))
    .sort((a, b) => a.t - b.t);
  const settings = { ...DEFAULT_OPTIONS, ...DEFAULTS, ...(base.settings || {}) };
  data = {
    settings,
    state: base.state || {},
    helper: base.helper,
    nextCheck: base.nextCheck,
    lastAlert: base.lastAlert,
    pausedUntil: base.pausedUntil > Date.now() ? base.pausedUntil : null,
    pauseReason: base.pauseReason,
    histIndex: base.histIndex || [],
    eventsStored: (base.events || []).length,
    checks,
    events: (base.events || []).filter((e) => e.t >= since),
    t0: Number.isFinite(span) ? since : checks[0]?.t ?? Date.now() - 36e5,
    t1: Date.now(),
  };
  data.stats = computeStats();
  $('loading').textContent = '';
  render();
}

function computeStats() {
  const { checks, settings, events } = data;
  const grace = (settings.maxSeconds + 60) * 1000;
  const by = (s) => checks.filter((c) => c.status === s);
  const gaps = checks.filter((c) => c.gap != null).map((c) => c.gap);
  const missed = [];
  // A long gap right after a failed check is a deliberate pause (back-off), not a missed period.
  for (let i = 1; i < checks.length; i++) {
    if (checks[i].t - checks[i - 1].t > grace && checks[i - 1].status === 'ok') missed.push({ from: checks[i - 1].t, to: checks[i].t });
  }
  const last = checks[checks.length - 1];
  if (last && settings.enabled && !data.pausedUntil && last.status === 'ok' && Date.now() - last.t > grace) missed.push({ from: last.t, to: Date.now(), ongoing: true });
  const errors = {};
  for (const c of checks.filter((x) => x.status !== 'ok')) {
    const e = (errors[c.error] ||= { n: 0, last: 0 });
    e.n += 1;
    e.last = c.t;
  }
  // Tickets sold between two successful checks that never showed up as available: listed and
  // bought before the next check (or sold through a private link).
  const missedTickets = [];
  let prevOk = null;
  for (const c of checks.filter((x) => x.status === 'ok')) {
    if (prevOk) {
      const n = c.sold - prevOk.sold - Math.max(0, prevOk.available - c.available);
      if (n > 0) missedTickets.push({ from: prevOk.t, to: c.t, n });
    }
    prevOk = c;
  }
  const durations = checks.map((c) => c.ms).filter(Number.isFinite);
  const late = checks.map((c) => c.late).filter((x) => x != null);
  return {
    n: checks.length,
    ok: by('ok').length,
    blocked: by('blocked').length,
    limited: by('limited').length,
    failed: by('error').length,
    gaps,
    medianGap: quantile(gaps, 0.5),
    longestGap: gaps.length ? Math.max(...gaps) : null,
    missed,
    errors: Object.entries(errors).sort((a, b) => b[1].n - a[1].n),
    avgMs: mean(durations),
    p90Ms: quantile(durations, 0.9),
    avgLate: mean(late),
    p90Late: quantile(late, 0.9),
    sawVerify: checks.filter((c) => c.sawVerify && c.status === 'ok').length,
    reopened: checks.filter((c, i) => i > 0 && /opened/.test(c.tab || '')).length,
    loadTimeouts: checks.filter((c) => c.loadTimedOut).length,
    alerts: events.filter((e) => e.type === 'alert').length,
    pauses: events.filter((e) => e.type === 'paused').length,
    missedTickets,
    missedTotal: missedTickets.reduce((sum, m) => sum + m.n, 0),
    missedAt: new Map(missedTickets.map((m) => [m.to, m.n])),
    skipped: events.filter((e) => e.type === 'skipped').length,
  };
}

// ---------- rendering ----------

function render() {
  renderMeta();
  renderHealth();
  renderTiles();
  renderFindings();
  renderCharts();
  renderSetup();
  renderEvents();
  renderTable();
  renderQuick();
  renderControls();
}

function renderMeta() {
  const names = data.settings.events.map((ev) => ev.name || data.state[ev.url]?.title || 'event');
  $('meta').textContent = `Watching ${names.join(', ') || 'nothing'} · version ${chrome.runtime.getManifest().version}`;
  const select = $('eventFilter');
  select.hidden = data.settings.events.length < 2;
  if (!select.hidden && select.options.length !== data.settings.events.length + 1) {
    select.replaceChildren(new Option('All events', 'all'), ...data.settings.events.map((ev, i) => new Option(names[i], ev.url)));
    select.value = eventFilter;
  }
}

function chip(level, glyph) {
  const span = document.createElement('span');
  span.className = `chip ${level}`;
  span.textContent = glyph;
  span.setAttribute('aria-hidden', 'true');
  return span;
}

const LEVEL_GLYPH = { good: '✓', warning: '!', serious: '!', critical: '✕', info: 'i' };

function health() {
  const { settings, state, helper } = data;
  const list = settings.events.map((ev) => state[ev.url] || {});
  const last = Math.max(0, ...list.map((s) => s.lastCheck || 0));
  const grace = (settings.maxSeconds + 60) * 1000;
  if (!settings.enabled) return { level: 'warning', title: 'Checking is turned off', detail: 'Turn it back on with the checkbox in the add-on popup.' };
  if (!settings.events.length) return { level: 'warning', title: 'No events to watch', detail: 'Paste a TicketSwap event link into the add-on popup.' };
  if (list.length && list.every((s) => s.ended)) {
    return {
      level: 'info',
      title: 'Finished: the event is over',
      detail: 'Not checking anymore. To keep going, set a later stop time under Controls → Events.',
    };
  }
  if (data.pausedUntil) {
    return {
      level: 'serious',
      title: `Paused until ${fmtClock(data.pausedUntil, false)}`,
      detail: `${data.pauseReason || 'Checks kept failing'}. It starts checking again by itself; don't refresh TicketSwap yourself meanwhile.`,
    };
  }
  if (!last) return { level: 'warning', title: 'No checks yet', detail: 'The first check runs a few seconds after the add-on starts.' };
  if (Date.now() - last > grace) {
    return {
      level: 'critical',
      title: `No check for ${fmtDur(Date.now() - last)}`,
      detail: "Chrome may be closed or the Mac asleep. Checks restart by themselves once Chrome is open and the Mac is awake; if they don't, reload the add-on in chrome://extensions.",
    };
  }
  if (list.some((s) => s.status === 'blocked')) {
    return { level: 'serious', title: 'Paused by a TicketSwap verification check', detail: 'Open the pinned TicketSwap tab and complete the check yourself. Checking carries on after that.' };
  }
  const failed = list.find((s) => s.status === 'error');
  if (failed) {
    return { level: 'critical', title: `Last check failed${failed.fails > 1 ? ` (${failed.fails} in a row)` : ''}`, detail: failed.error || '' };
  }
  if (helper && !helper.ok) {
    return { level: 'warning', title: "Checking works, but the Mac alarm can't be reached", detail: `${helper.error}. Alerts would use Chrome's quieter siren instead.` };
  }
  const s = list[0];
  if (s.available > 0) return { level: 'good', title: `${plural(s.available, 'ticket')} available right now!`, detail: 'Go to the pinned TicketSwap tab.' };
  return { level: 'good', title: 'Working', detail: `Last check read ${s.available} available · ${s.sold} sold · ${s.wanted} wanted` };
}

function renderHealth() {
  const h = health();
  const list = data.settings.events.map((ev) => data.state[ev.url] || {});
  const last = Math.max(0, ...list.map((s) => s.lastCheck || 0));
  const next = data.nextCheck;
  const main = document.createElement('div');
  main.className = 'main';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = h.title;
  const detail = document.createElement('div');
  detail.className = 'sub';
  detail.textContent = h.detail;
  main.append(title, detail);

  const clock = document.createElement('div');
  clock.className = 'clock';
  const nextText = !data.settings.enabled || !next
    ? '–'
    : data.pausedUntil && next >= data.pausedUntil
      ? `${fmtClock(next, false)} (paused)`
      : next > Date.now()
        ? `in ${fmtDur(next - Date.now())}`
        : `due ${fmtDur(Date.now() - next)} ago`;
  for (const [k, v] of [
    ['Last check', last ? fmtAgo(last) : 'never'],
    ['Next check', nextText],
  ]) {
    const box = document.createElement('div');
    const kEl = document.createElement('span');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('span');
    vEl.className = 'v';
    vEl.textContent = v;
    box.append(kEl, vEl);
    clock.append(box);
  }
  $('health').replaceChildren(chip(h.level, LEVEL_GLYPH[h.level]), main, clock);
}

function renderTiles() {
  const st = data.stats;
  const { minSeconds, maxSeconds } = data.settings;
  const tiles = [
    ['Typical gap', fmtDur(st.medianGap), `you set ${minSeconds}–${maxSeconds} s`],
    ['Alerts sent', st.alerts.toLocaleString(), st.alerts ? 'see Events' : 'no tickets seen yet'],
    ['Failed', st.failed.toLocaleString(), st.failed ? `last ${fmtAgo(data.checks.filter((c) => c.status === 'error').at(-1)?.t)}` : 'none'],
    [
      'Missed tickets',
      st.missedTotal.toLocaleString(),
      st.missedTotal ? `last ${fmtClock(st.missedTickets.at(-1).to, false)}, sold within ${fmtDur(st.missedTickets.at(-1).to - st.missedTickets.at(-1).from)}` : 'none sold between checks',
    ],
    ['Checks', st.n.toLocaleString(), RANGES.find((r) => r[0] === rangeKey)[1].toLowerCase()],
    ['Blocked by TicketSwap', (st.blocked + st.limited).toLocaleString(), `${plural(st.limited, 'rate limit')} · ${st.blocked} verification`],
    ['Longest gap', fmtDur(st.longestGap), st.missed.length ? plural(st.missed.length, 'period') + ' without checks' : 'no missed periods'],
    ['Check takes', fmtDur(st.avgMs), `90% under ${fmtDur(st.p90Ms)}`],
  ];
  $('tiles').replaceChildren(
    ...tiles.map(([k, v, s]) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      for (const [cls, text] of [['k', k], ['v', v], ['s', s]]) {
        const el = document.createElement('span');
        el.className = cls;
        el.textContent = text;
        tile.append(el);
      }
      return tile;
    })
  );
}

function findings() {
  const st = data.stats;
  const { settings, helper, lastAlert } = data;
  const out = [];
  if (!st.n) {
    out.push({ level: 'warning', title: 'No checks in this period', detail: 'Pick a longer range above, or wait for the next check.' });
  } else if (!st.failed && !st.blocked && !st.limited) {
    out.push({ level: 'good', title: `All ${st.n.toLocaleString()} checks worked`, detail: 'Every check found the ticket count on the event page.' });
  } else {
    const bad = st.failed + st.blocked + st.limited;
    const top = st.errors
      .slice(0, 3)
      .map(([e, v]) => `“${e}” ×${v.n} (last ${fmtClock(v.last)})`)
      .join(' · ');
    out.push({ level: bad / st.n > 0.1 ? 'critical' : 'warning', title: `${bad} of ${st.n} checks didn't work (${pct(bad, st.n)})`, detail: top });
  }
  if (st.blocked) {
    out.push({
      level: 'serious',
      title: `TicketSwap showed a verification check ${plural(st.blocked, 'time')}`,
      detail: 'The add-on pauses and waits for you each time. If it keeps happening, check less often: Controls → Checking → Gentle.',
    });
  }
  if (st.missedTotal) {
    const last = st.missedTickets.at(-1);
    out.push({
      level: 'warning',
      title: `${plural(st.missedTotal, 'ticket')} sold between checks without being seen`,
      detail: `Last one between ${fmtClock(last.from, false)} and ${fmtClock(last.to, false)} (${fmtDur(last.to - last.from)} apart). It was listed and bought before the next check, or sold through a private link. A shorter wait between checks catches more of these, but under about 45 s risks TicketSwap's "too many refreshes" block.`,
    });
  }
  if (st.limited) {
    out.push({
      level: 'serious',
      title: `TicketSwap said "too many refreshes" on ${plural(st.limited, 'check')}`,
      detail: `The add-on paused ${plural(st.pauses, 'time')} (15, 30, then 60 min) and carried on by itself. To avoid it, check less often: Controls → Checking → Gentle (120–240 s).`,
    });
  }
  if (st.sawVerify) {
    out.push({ level: 'good', title: `A short "Verifying" screen appeared on ${plural(st.sawVerify, 'check')} and cleared by itself`, detail: 'Nothing to do. These checks still worked.' });
  }
  if (st.missed.length) {
    const longest = st.missed.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
    out.push({
      level: st.missed.some((m) => m.ongoing) ? 'critical' : 'serious',
      title: `${plural(st.missed.length, 'period')} with no checks`,
      detail: `Longest: ${fmtDur(longest.to - longest.from)}, from ${fmtClock(longest.from, false)} to ${longest.ongoing ? 'now' : fmtClock(longest.to, false)}. Usually the Mac was asleep or Chrome was closed.`,
    });
  } else if (st.n > 1) {
    out.push({ level: 'good', title: 'No missed periods', detail: `Checks ran every ${settings.minSeconds}–${settings.maxSeconds} s as set. Typical gap ${fmtDur(st.medianGap)}.` });
  }
  if (st.p90Late != null) {
    if (st.p90Late > 15000) {
      out.push({ level: 'warning', title: 'Chrome started some checks late', detail: `On average ${fmtDur(st.avgLate)} after the planned time (90% within ${fmtDur(st.p90Late)}). macOS slows Chrome's timers when the Mac is idle or saving energy.` });
    } else {
      out.push({ level: 'good', title: 'Timer on schedule', detail: `Checks start within ${fmtDur(Math.max(0, st.p90Late))} of their planned time (90% of them).` });
    }
  }
  if (st.p90Ms != null) {
    out.push(
      st.p90Ms > 20000 || st.loadTimeouts
        ? { level: 'warning', title: 'TicketSwap is slow to load', detail: `90% of checks took under ${fmtDur(st.p90Ms)}; ${plural(st.loadTimeouts, 'page')} hit the 25 s load limit.` }
        : { level: 'good', title: 'Pages load quickly', detail: `A check takes ${fmtDur(st.avgMs)} on average; 90% under ${fmtDur(st.p90Ms)}.` }
    );
  }
  if (st.reopened) {
    out.push({ level: 'warning', title: `The pinned TicketSwap tab was reopened ${plural(st.reopened, 'time')}`, detail: 'That happens when the tab gets closed. It is reopened automatically, but leaving it open is smoother.' });
  }
  if (st.skipped) {
    out.push({ level: 'warning', title: `${plural(st.skipped, 'check')} skipped`, detail: 'A check was still running when the next one was due, usually because the page was slow.' });
  }
  if (helper) {
    out.push(
      helper.ok
        ? { level: 'good', title: 'Mac alarm connected', detail: `The Mac helper last answered ${fmtAgo(helper.at)}.` }
        : { level: 'critical', title: "Mac alarm can't be reached", detail: `${helper.error} (checked ${fmtAgo(helper.at)}). Alerts would use Chrome's quieter siren.` }
    );
  }
  if (lastAlert) {
    const parts = [`alarm: ${lastAlert.mac}`, `email: ${lastAlert.email}`, `phone: ${lastAlert.phone}`];
    const failed = parts.some((p) => /failed|siren/.test(p));
    out.push({ level: failed ? 'warning' : 'good', title: `Last ${lastAlert.test ? 'test alarm' : 'alert'} ${fmtAgo(lastAlert.at)}`, detail: parts.join(' · ') });
  }
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

function renderFindings() {
  $('findings').replaceChildren(
    ...findings().map((f) => {
      const li = document.createElement('li');
      const text = document.createElement('div');
      const t = document.createElement('div');
      t.className = 't';
      t.textContent = f.title;
      const d = document.createElement('div');
      d.className = 'd';
      d.textContent = f.detail;
      text.append(t, d);
      li.append(chip(f.level, LEVEL_GLYPH[f.level]), text);
      return li;
    })
  );
}

// ---------- charts ----------

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (parent) parent.append(el);
  return el;
}

function frame(id, height, margin) {
  const svg = $(id);
  svg.replaceChildren();
  const W = Math.max(280, svg.parentElement.clientWidth);
  svg.setAttribute('viewBox', `0 0 ${W} ${height}`);
  svg.setAttribute('height', height);
  const m = { l: 44, r: 16, t: 14, b: 26, ...margin };
  return { svg, W, H: height, m, w: W - m.l - m.r, h: height - m.t - m.b };
}

function emptyNote(f, text) {
  svgEl('text', { x: f.W / 2, y: f.H / 2, 'text-anchor': 'middle', class: 'label' }, f.svg).textContent = text;
}

function timeTicks(t0, t1, width) {
  const steps = [6e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 108e5, 216e5, 432e5, 864e5, 1728e5];
  const step = steps.find((s) => (t1 - t0) / s <= Math.max(2, width / 110)) || 864e5 * 7;
  const off = new Date(t0).getTimezoneOffset() * 6e4;
  const ticks = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) ticks.push(t);
  const multiDay = t1 - t0 > 864e5;
  const fmt = (t) => {
    const d = new Date(t);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return multiDay && step >= 216e5 ? `${d.toLocaleDateString([], { weekday: 'short' })} ${hm}` : hm;
  };
  return ticks.map((t) => [t, fmt(t)]);
}

function drawTimeAxis(f, x, t0, t1) {
  svgEl('line', { x1: f.m.l, x2: f.m.l + f.w, y1: f.m.t + f.h, y2: f.m.t + f.h, class: 'axis' }, f.svg);
  for (const [t, label] of timeTicks(t0, t1, f.w)) {
    svgEl('text', { x: x(t), y: f.m.t + f.h + 17, 'text-anchor': 'middle' }, f.svg).textContent = label;
  }
}

function drawYGrid(f, y, scale, fmt) {
  for (let v = 0; v <= scale.max + 1e-9; v += scale.step) {
    const yy = y(v);
    if (v > 0) svgEl('line', { x1: f.m.l, x2: f.m.l + f.w, y1: yy, y2: yy, class: 'grid' }, f.svg);
    svgEl('text', { x: f.m.l - 8, y: yy + 4, 'text-anchor': 'end' }, f.svg).textContent = fmt(v);
  }
}

function nearestByTime(list, t) {
  let lo = 0;
  let hi = list.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (list[mid].t < t) lo = mid;
    else hi = mid;
  }
  return Math.abs(list[lo].t - t) <= Math.abs(list[hi].t - t) ? list[lo] : list[hi];
}

function legendItem(parent, mark, text) {
  const span = document.createElement('span');
  span.append(mark, document.createTextNode(text));
  parent.append(span);
}

function lineKey(color) {
  const svg = svgEl('svg', { width: 14, height: 4, viewBox: '0 0 14 4', 'aria-hidden': 'true' });
  svgEl('line', { x1: 1, x2: 13, y1: 2, y2: 2, stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
  return svg;
}

function renderCharts() {
  renderCounts();
  renderGaps();
}

function renderCounts() {
  const { t0, t1 } = data;
  const ok = data.checks.filter((c) => c.status === 'ok');
  const series = [
    ['wanted', 'Wanted', 'var(--series-1)'],
    ['available', 'Available', 'var(--series-2)'],
    ['sold', 'Sold', 'var(--series-3)'],
  ];
  const legend = $('legend2');
  legend.replaceChildren();
  for (const [, label, color] of series) legendItem(legend, lineKey(color), label);
  const f = frame('chart2', 220, { r: 84 });
  if (!ok.length) return emptyNote(f, 'No successful checks in this period yet');
  const x = (t) => f.m.l + ((t - t0) / (t1 - t0 || 1)) * f.w;
  const scale = niceScale(Math.max(5, ...ok.map((c) => Math.max(c.wanted, c.available, c.sold))));
  const y = (v) => f.m.t + f.h - (v / scale.max) * f.h;
  drawYGrid(f, y, scale, (v) => String(Math.round(v)));
  drawTimeAxis(f, x, t0, t1);
  const ends = [];
  for (const [key, label, color] of series) {
    let d = '';
    ok.forEach((c, i) => {
      d += i === 0 ? `M${x(c.t)},${y(c[key])}` : `H${x(c.t)}V${y(c[key])}`;
    });
    const lastC = ok[ok.length - 1];
    d += `H${x(t1)}`;
    svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, f.svg);
    ends.push({ y: y(lastC[key]), text: `${lastC[key]} ${label.toLowerCase()}` });
  }
  // Direct end labels, dropping any that would collide with one already placed.
  const placed = [];
  for (const e of ends.sort((a, b) => a.y - b.y)) {
    if (placed.some((p) => Math.abs(p - e.y) < 13)) continue;
    placed.push(e.y);
    svgEl('text', { x: f.m.l + f.w + 6, y: e.y + 4, class: 'label' }, f.svg).textContent = e.text;
  }
  hover(f, ok, x, (c) => [x(c.t), null], (c) => {
    const box = tooltipBox(fmtClock(c.t));
    for (const [key, label, color] of series) tooltipRow(box, color, c[key], label);
    return box;
  });
}

function renderGaps() {
  const { settings, stats } = data;
  const gaps = stats.gaps.map((g) => g / 1000);
  $('gapSub').textContent = `How long after the previous check each check ran. Shaded: your range (${settings.minSeconds}–${settings.maxSeconds} s).`;
  const f = frame('chart3', 220);
  if (!gaps.length) return emptyNote(f, 'Needs at least two checks');
  const binW = 10;
  const top = Math.ceil(Math.min(600, Math.max(settings.maxSeconds + 40, quantile(gaps, 0.95))) / binW) * binW;
  const bins = Array.from({ length: top / binW + 1 }, (_, i) => ({ from: i * binW, to: i === top / binW ? Infinity : (i + 1) * binW, n: 0 }));
  for (const g of gaps) bins[Math.min(bins.length - 1, Math.floor(g / binW))].n += 1;
  const xMax = top + binW;
  const x = (s) => f.m.l + (s / xMax) * f.w;
  const scale = niceScale(Math.max(...bins.map((b) => b.n)));
  const y = (v) => f.m.t + f.h - (v / scale.max) * f.h;
  svgEl('rect', { x: x(settings.minSeconds), y: f.m.t, width: x(settings.maxSeconds) - x(settings.minSeconds), height: f.h, fill: 'var(--series-1)', 'fill-opacity': 0.08 }, f.svg);
  svgEl('text', { x: (x(settings.minSeconds) + x(settings.maxSeconds)) / 2, y: f.m.t + 12, 'text-anchor': 'middle', class: 'label' }, f.svg).textContent = 'your range';
  drawYGrid(f, y, scale, (v) => String(Math.round(v)));
  svgEl('line', { x1: f.m.l, x2: f.m.l + f.w, y1: f.m.t + f.h, y2: f.m.t + f.h, class: 'axis' }, f.svg);
  const slot = x(binW) - x(0);
  const tickStep = xMax > 300 ? 60 : 30;
  for (let s = 0; s < top - tickStep / 2; s += tickStep) {
    svgEl('text', { x: x(s), y: f.m.t + f.h + 17, 'text-anchor': 'middle' }, f.svg).textContent = `${s} s`;
  }
  // The last bar collects every longer gap.
  svgEl('text', { x: x(top) + slot / 2, y: f.m.t + f.h + 17, 'text-anchor': 'middle' }, f.svg).textContent = `${top}+ s`;
  const bw = Math.max(2, Math.min(24, slot - 2));
  for (const b of bins) {
    const cx = x(b.from) + slot / 2;
    if (b.n) {
      const yy = y(b.n);
      const hgt = f.m.t + f.h - yy;
      const r = Math.min(4, hgt, bw / 2);
      const x0 = cx - bw / 2;
      svgEl('path', { d: `M${x0},${f.m.t + f.h}V${yy + r}Q${x0},${yy} ${x0 + r},${yy}H${x0 + bw - r}Q${x0 + bw},${yy} ${x0 + bw},${yy + r}V${f.m.t + f.h}Z`, fill: 'var(--series-1)' }, f.svg);
    }
    const hit = svgEl('rect', { x: x(b.from), y: f.m.t, width: slot, height: f.h, fill: 'transparent', tabindex: 0 }, f.svg);
    const show = (ev) => {
      const range = b.to === Infinity ? `${b.from} s or more` : `${b.from}–${b.to} s`;
      const box = tooltipBox(range);
      tooltipRow(box, 'var(--series-1)', b.n, `${plural(b.n, 'check').replace(/^\d+ /, '')} (${pct(b.n, gaps.length)})`);
      showTooltip(box, ev);
    };
    hit.addEventListener('pointermove', show);
    hit.addEventListener('focus', (ev) => show({ clientX: hit.getBoundingClientRect().right, clientY: hit.getBoundingClientRect().top }));
    hit.addEventListener('pointerleave', hideTooltip);
    hit.addEventListener('blur', hideTooltip);
  }
}

// Crosshair hover: snaps to the nearest item by time and shows its tooltip.
function hover(f, list, x, pos, content) {
  const cross = svgEl('line', { y1: f.m.t, y2: f.m.t + f.h, class: 'cross', visibility: 'hidden' }, f.svg);
  const ring = svgEl('circle', { r: 7, fill: 'none', stroke: 'var(--ink)', 'stroke-width': 1.5, visibility: 'hidden' }, f.svg);
  const area = svgEl('rect', { x: f.m.l, y: f.m.t, width: f.w, height: f.h, fill: 'transparent' }, f.svg);
  area.addEventListener('pointermove', (ev) => {
    const box = f.svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * f.W;
    const t = data.t0 + ((px - f.m.l) / f.w) * (data.t1 - data.t0);
    const item = nearestByTime(list, t);
    const [cx, cy] = pos(item);
    if (Math.abs(cx - px) > 40) return hideHover();
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    if (cy != null) {
      ring.setAttribute('cx', cx);
      ring.setAttribute('cy', cy);
      ring.setAttribute('visibility', 'visible');
    }
    showTooltip(content(item), ev);
  });
  const hideHover = () => {
    cross.setAttribute('visibility', 'hidden');
    ring.setAttribute('visibility', 'hidden');
    hideTooltip();
  };
  area.addEventListener('pointerleave', hideHover);
}

function tooltipBox(title) {
  const box = document.createElement('div');
  const t = document.createElement('div');
  t.className = 'tt-title';
  t.textContent = title;
  box.append(t);
  return box;
}

function tooltipRow(box, color, value, label) {
  const row = document.createElement('div');
  row.className = 'row';
  if (color) {
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = color;
    row.append(key);
  }
  const b = document.createElement('b');
  b.textContent = value;
  const l = document.createElement('span');
  l.textContent = label;
  row.append(b, l);
  box.append(row);
}

function tooltipNote(box, text) {
  const n = document.createElement('div');
  n.className = 'note';
  n.textContent = text;
  box.append(n);
}

function showTooltip(content, ev) {
  const tip = $('tooltip');
  tip.replaceChildren(content);
  tip.hidden = false;
  const pad = 14;
  const { innerWidth: vw, innerHeight: vh } = window;
  const r = tip.getBoundingClientRect();
  let left = ev.clientX + pad;
  let top = ev.clientY + pad;
  if (left + r.width > vw - 8) left = ev.clientX - r.width - pad;
  if (top + r.height > vh - 8) top = ev.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

function hideTooltip() {
  $('tooltip').hidden = true;
}

// ---------- setup, events, table ----------

function renderSetup() {
  const { settings, state, helper, lastAlert } = data;
  const dl = $('setup');
  dl.replaceChildren();
  const add = (k, v, href) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.textContent = v;
      dd.append(a);
    } else dd.textContent = v;
    dl.append(dt, dd);
  };
  for (const ev of settings.events) {
    add('Watching', ev.name || state[ev.url]?.title || ev.url, ev.url);
    const stop = eventStopAt(ev);
    add('Stops checking', stop ? `${fmtClock(stop, false)}${ev.stopAt ? '' : ' (morning after the event date)'}${state[ev.url]?.ended ? ' · stopped' : ''}` : 'never');
  }
  add('Checking', settings.enabled ? `on, every ${settings.minSeconds}–${settings.maxSeconds} s at random` : 'off');
  add('Email alerts to', settings.email || 'off');
  add('Phone push topic', settings.ntfyTopic || 'off');
  add('Mac alarm', helper ? (helper.ok ? `connected (answered ${fmtAgo(helper.at)})` : `not reachable: ${helper.error}`) : 'not checked yet');
  add('Last alert or test', lastAlert ? `${fmtClock(lastAlert.at)}: alarm ${lastAlert.mac}, email ${lastAlert.email}, phone ${lastAlert.phone}` : 'none yet');
  add('History kept', '14 days');
  add('Add-on version', chrome.runtime.getManifest().version);
}

function renderEvents() {
  const list = [...data.events].reverse().slice(0, 300);
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No events in this period';
    return $('events').replaceChildren(li);
  }
  $('events').replaceChildren(
    ...list.map((e) => {
      const li = document.createElement('li');
      const [glyph, look] = EVENT_LOOK[e.type] || ['•', 'info'];
      const level = e.type === 'helper' ? (e.ok ? 'good' : 'critical') : look;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = fmtClock(e.t);
      const text = document.createElement('span');
      text.textContent = e.text;
      li.append(chip(level, glyph), when, text);
      return li;
    })
  );
}

function isProblem(c) {
  return c.status !== 'ok' || c.alert || c.sawVerify || c.loadTimedOut || (c.late != null && c.late > 15000) || /opened/.test(c.tab || '');
}

function tableRows() {
  return [...data.checks].reverse().filter((c) => !problemsOnly || isProblem(c));
}

function renderTable() {
  const rows = tableRows();
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  page = Math.min(page, pages - 1);
  const slice = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const tbody = $('table').tBodies[0];
  if (!slice.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 13;
    td.className = 'empty';
    td.textContent = problemsOnly ? 'No problems in this period' : 'No checks in this period';
    tr.append(td);
    tbody.replaceChildren(tr);
  } else {
    tbody.replaceChildren(
      ...slice.map((c) => {
        const tr = document.createElement('tr');
        const missed = data.stats.missedAt.get(c.t);
        if (c.alert) tr.className = 'alert';
        else if (missed) tr.className = 'missed';
        const res = document.createElement('span');
        res.className = 'res';
        res.append(chip(STATUS[c.status].level, STATUS[c.status].glyph), document.createTextNode(STATUS[c.status].label));
        const notes = [
          c.alert && '🎟 alert sent',
          missed && `${plural(missed, 'ticket')} sold since the previous check, never seen listed`,
          c.error,
          c.httpStatus && c.httpStatus !== 200 && `HTTP ${c.httpStatus}`,
          c.readError && c.status !== 'ok' && `read error: ${c.readError}`,
          c.sawVerify && '"Verifying" screen seen',
          c.loadTimedOut && 'page load hit 25 s limit',
          c.snippet && `page said: “${c.snippet}”`,
        ].filter(Boolean);
        const cells = [
          [fmtClock(c.t)],
          [res],
          [c.available ?? '–', 'num'],
          [c.sold ?? '–', 'num'],
          [c.wanted ?? '–', 'num'],
          [fmtDur(c.ms), 'num'],
          [c.gap != null ? fmtDur(c.gap) : '–', 'num'],
          [c.late != null ? fmtDur(c.late) : '–', 'num'],
          [c.reason === 'manual' ? 'Check now' : 'timer'],
          [c.tab || '–'],
          [fmtDur(c.loadMs), 'num'],
          [c.tries ?? '–', 'num'],
          [notes.join(' · '), 'notes'],
        ];
        for (const [v, cls] of cells) {
          const td = document.createElement('td');
          if (cls) td.className = cls;
          if (v instanceof Node) td.append(v);
          else td.textContent = String(v);
          tr.append(td);
        }
        return tr;
      })
    );
  }
  const pager = $('pager');
  pager.replaceChildren();
  const info = document.createElement('span');
  info.textContent = rows.length ? `${page * PAGE_SIZE + 1}–${Math.min(rows.length, (page + 1) * PAGE_SIZE)} of ${rows.length.toLocaleString()}` : '';
  const prev = document.createElement('button');
  prev.textContent = 'Newer';
  prev.disabled = page === 0;
  prev.onclick = () => {
    page -= 1;
    renderTable();
  };
  const next = document.createElement('button');
  next.textContent = 'Older';
  next.disabled = page >= pages - 1;
  next.onclick = () => {
    page += 1;
    renderTable();
  };
  pager.append(info, prev, next);
}

async function exportAll() {
  const { histIndex = [] } = await chrome.storage.local.get('histIndex');
  const buckets = histIndex.length ? await chrome.storage.local.get(histIndex) : {};
  exportCsv(histIndex.flatMap((k) => buckets[k] || []).sort((a, b) => a.t - b.t));
}

function exportCsv(checks = tableRows().reverse()) {
  const cols = ['time', 'result', 'available', 'sold', 'wanted', 'took_s', 'gap_s', 'late_s', 'started_by', 'tab', 'load_s', 'tries', 'verifying_seen', 'load_timed_out', 'alert', 'error', 'http_status', 'read_error', 'page_text', 'event_url'];
  const s = (ms) => (ms == null ? '' : (ms / 1000).toFixed(1));
  const esc = (v) => {
    const str = v == null ? '' : String(v);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const lines = [cols.join(',')];
  for (const c of checks) {
    lines.push(
      [new Date(c.t).toISOString(), c.status, c.available, c.sold, c.wanted, s(c.ms), s(c.gap), s(c.late), c.reason, c.tab, s(c.loadMs), c.tries, !!c.sawVerify, !!c.loadTimedOut, !!c.alert, c.error, c.httpStatus, c.readError, c.snippet, c.url]
        .map(esc)
        .join(',')
    );
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `ticketswap-alarm-checks-${new Date().toISOString().slice(0, 16).replace(':', '')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- controls & live updates ----------

function renderRanges() {
  $('ranges').replaceChildren(
    ...RANGES.map(([key, label]) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.setAttribute('aria-pressed', String(key === rangeKey));
      b.onclick = () => {
        rangeKey = key;
        writePref('range', key);
        page = 0;
        renderRanges();
        load();
      };
      return b;
    })
  );
}

$('eventFilter').onchange = (e) => {
  eventFilter = e.target.value;
  page = 0;
  load();
};
$('problemsOnly').onchange = (e) => {
  problemsOnly = e.target.checked;
  page = 0;
  renderTable();
};
$('export').onclick = () => exportCsv();

// ---------- views ----------

let view = readPref('view', 'overview');
function showView(next) {
  view = next;
  writePref('view', next);
  for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-selected', String(b.dataset.view === view));
  for (const b of document.querySelectorAll('#views button')) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  $('view-overview').hidden = view !== 'overview';
  $('view-controls').hidden = view !== 'controls';
  if (view === 'overview' && data) renderCharts();
}
for (const b of document.querySelectorAll('#views button')) b.onclick = () => showView(b.dataset.view);

// ---------- commands (sent to worker.js) ----------

const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e.message || e) }));

let toastTimer;
function toast(text) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($('toast').textContent = ''), 3000);
}

async function save(patch, what = 'Saved') {
  const r = await send({ cmd: 'save', settings: patch });
  toast(r && r.error ? `Couldn't save: ${r.error}` : `${what} ✓`);
  return r;
}

async function busy(button, label, fn) {
  const old = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = old;
  }
}

const checkNow = (button) => busy(button, 'Checking…', async () => {
  await send({ cmd: 'checkNow' });
  toast('Checked ✓');
});
const pauseFor = async (minutes) => {
  await send({ cmd: 'pause', minutes });
  toast(`Paused for ${minutes >= 60 ? `${minutes / 60} h` : `${minutes} min`} ✓`);
};
const resume = async () => {
  await send({ cmd: 'resume' });
  toast('Resumed, checking in a few seconds ✓');
};

// ---------- quick controls (on both views) ----------

$('qEnabled').onchange = (e) => save({ enabled: e.target.checked }, e.target.checked ? 'Checking turned on' : 'Checking turned off');
$('qCheck').onclick = (e) => checkNow(e.currentTarget);
$('qPause15').onclick = () => pauseFor(15);
$('qPause60').onclick = () => pauseFor(60);
$('qResume').onclick = resume;

function renderQuick() {
  $('qEnabled').checked = data.settings.enabled;
  $('qResume').disabled = !data.pausedUntil;
}

// ---------- full controls ----------

const PRESETS = [
  ['Gentle', 120, 240],
  ['Balanced', 60, 150],
  ['Fast', 30, 90],
];
const SWITCHES = {
  cAlertMac: 'alertMac',
  cAlertNotify: 'alertNotify',
  cAlertTab: 'alertTab',
  cAlertEmail: 'alertEmail',
  cAlertPhone: 'alertPhone',
  cVoice: 'alarmVoice',
};
const TESTS = [
  ['email', 'Send a test email', 'silent'],
  ['phone', 'Send a test phone push', 'silent'],
  ['notify', 'Show a test notification', 'silent'],
  ['ping', 'Check the Mac helper answers', 'silent'],
  ['mac', 'Ring the Mac alarm for 8 seconds', '🔊 makes noise'],
];

// Sets an input's value unless you're typing in it.
function setValue(el, value) {
  if (document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

function saveInterval() {
  const min = Math.max(30, Math.round(Number($('cMin').value) || 30));
  const max = Math.max(min, Math.round(Number($('cMax').value) || min));
  save({ minSeconds: min, maxSeconds: max }, `Checking every ${min}–${max} s`);
}

$('cMin').onchange = saveInterval;
$('cMax').onchange = saveInterval;
$('cPresets').replaceChildren(
  ...PRESETS.map(([name, min, max]) => {
    const b = document.createElement('button');
    b.textContent = `${name} ${min}–${max} s`;
    b.dataset.min = min;
    b.dataset.max = max;
    b.onclick = () => save({ minSeconds: min, maxSeconds: max }, `Checking every ${min}–${max} s`);
    return b;
  })
);
$('cPauseMinutes').onchange = (e) => save({ pauseMinutes: Number(e.target.value) });
for (const b of document.querySelectorAll('[data-pause]')) b.onclick = () => pauseFor(Number(b.dataset.pause));
$('cResume').onclick = resume;
$('cMinAvailable').onchange = (e) => save({ minAvailable: Number(e.target.value) });
for (const [id, key] of Object.entries(SWITCHES)) $(id).onchange = (e) => save({ [key]: e.target.checked });
$('cEmail').onchange = (e) => save({ email: e.target.value.trim() });
$('cNewTopic').onclick = async () => {
  await send({ cmd: 'newTopic' });
  toast('New phone topic. Subscribe to it in the ntfy app ✓');
};
$('cVolume').oninput = (e) => ($('cVolumeValue').textContent = `${e.target.value}%`);
$('cVolume').onchange = (e) => save({ alarmVolume: Number(e.target.value) });
$('cAlarmSeconds').onchange = (e) => save({ alarmSeconds: Number(e.target.value) });

$('cAdd').onsubmit = (e) => {
  e.preventDefault();
  const url = $('cNewUrl').value.trim().split('?')[0];
  if (!/^https:\/\/www\.ticketswap\.(com|nl)\//.test(url)) {
    $('cAddHint').textContent = 'That needs to be a ticketswap.com event link.';
    return;
  }
  $('cAddHint').textContent = '';
  $('cNewUrl').value = '';
  if (!data.settings.events.some((ev) => ev.url === url)) save({ events: [...data.settings.events, { url, name: '' }] }, 'Event added');
};

$('cTests').replaceChildren(
  ...TESTS.map(([only, label, note]) => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.textContent = `${label} (${note})`;
    const res = document.createElement('span');
    res.className = 'res';
    b.onclick = () =>
      busy(b, 'Working…', async () => {
        const r = only === 'ping' ? await send({ cmd: 'ping' }) : await send({ cmd: 'test', only });
        let text;
        let ok;
        if (r.error) [text, ok] = [r.error, false];
        else if (only === 'ping') [text, ok] = [r.helper.ok ? 'Mac helper answered' : `Not reachable: ${r.helper.error}`, r.helper.ok];
        else {
          const v = { mac: r.mac, notify: r.notify, email: r.email, phone: r.phone }[only];
          ok = v === 'sent' || v === 'shown' || v === 'mac helper';
          text = { email: `Email ${v}`, phone: `Push ${v}`, notify: `Notification ${v}`, mac: v === 'mac helper' ? 'Rang through the Mac helper' : `Used ${v}` }[only];
        }
        res.textContent = `${ok ? '✓' : '✕'} ${text} · ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
        res.className = `res ${ok ? 'ok' : 'bad'}`;
      });
    li.append(b, res);
    return li;
  })
);

$('cExport').onclick = exportAll;
let clearArmed;
$('cClear').onclick = async (e) => {
  const b = e.currentTarget;
  if (!b.classList.contains('armed')) {
    b.classList.add('armed');
    b.textContent = 'Click again to clear';
    clearArmed = setTimeout(() => {
      b.classList.remove('armed');
      b.textContent = 'Clear history';
    }, 4000);
    return;
  }
  clearTimeout(clearArmed);
  b.classList.remove('armed');
  b.textContent = 'Clear history';
  await send({ cmd: 'clearHistory' });
  toast('History cleared ✓');
};
$('cRestart').onclick = async () => {
  await send({ cmd: 'restart' });
  toast('Restarting the add-on… ✓');
  setTimeout(load, 2500);
};

// ms -> "YYYY-MM-DDTHH:MM" in local time, for <input type="datetime-local">.
function toLocalInput(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function eventStatusText(s) {
  if (s.ended) return 'Event is over, not checking anymore';
  if (!s.lastCheck) return 'Not checked yet';
  const what = s.status === 'ok' ? ` · ${s.available} available · ${s.wanted} wanted` : ` · ${s.error || ''}`;
  return `${STATUS[s.status]?.label || s.status} ${fmtAgo(s.lastCheck)}${what}`;
}

// Rebuilds the rows only when the event list changes (so typing isn't interrupted), but refreshes
// each row's status line on every update.
let renderedEvents = '';
function renderControlEvents() {
  for (const meta of $('cEvents').querySelectorAll('.meta')) meta.textContent = eventStatusText(data.state[meta.dataset.url] || {});
  const key = JSON.stringify(data.settings.events);
  if (key === renderedEvents || $('cEvents').contains(document.activeElement)) return;
  renderedEvents = key;
  $('cEvents').replaceChildren(
    ...data.settings.events.map((ev, i) => {
      const s = data.state[ev.url] || {};
      const li = document.createElement('li');
      const name = document.createElement('input');
      name.type = 'text';
      name.value = ev.name || '';
      name.placeholder = s.title || 'Name this event';
      name.setAttribute('aria-label', 'Event name');
      name.onchange = () => save({ events: data.settings.events.map((e, j) => (j === i ? { ...e, name: name.value.trim() } : e)) }, 'Renamed');
      const open = document.createElement('a');
      open.href = ev.url;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Open';
      const show = document.createElement('button');
      show.textContent = 'Show checker tab';
      show.onclick = async () => {
        const r = await send({ cmd: 'showTab', url: ev.url });
        toast(r.ok ? 'Switched to the checker tab ✓' : 'No checker tab yet; it opens at the next check');
      };
      const remove = document.createElement('button');
      remove.className = 'remove';
      remove.textContent = '✕';
      remove.title = 'Stop watching this event';
      remove.setAttribute('aria-label', 'Stop watching this event');
      remove.onclick = () => save({ events: data.settings.events.filter((e) => e.url !== ev.url) }, 'Event removed');
      const stopRow = document.createElement('label');
      stopRow.className = 'stop';
      const stopInput = document.createElement('input');
      stopInput.type = 'datetime-local';
      const stop = eventStopAt(ev);
      stopInput.value = stop ? toLocalInput(stop) : '';
      stopInput.onchange = () => {
        const t = stopInput.value ? new Date(stopInput.value).getTime() : null;
        save({ events: data.settings.events.map((e, j) => (j === i ? { ...e, stopAt: t } : e)) }, t ? `Stops checking ${fmtClock(t, false)}` : 'Stop time back to the morning after the event');
      };
      const stopHint = document.createElement('span');
      stopHint.className = 'hint';
      stopHint.textContent = ev.stopAt ? 'set by you · clear it to use the default' : 'default: 08:00 the morning after the event date';
      stopRow.append(document.createTextNode('Stop checking after'), stopInput, stopHint);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.dataset.url = ev.url;
      meta.textContent = eventStatusText(s);
      li.append(name, open, show, remove, stopRow, meta);
      return li;
    })
  );
  if (!data.settings.events.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Not watching anything. Paste an event link below.';
    $('cEvents').append(li);
  }
}

function renderControls() {
  const st = data.settings;
  setValue($('cMin'), st.minSeconds);
  setValue($('cMax'), st.maxSeconds);
  for (const b of $('cPresets').children) b.setAttribute('aria-pressed', String(+b.dataset.min === st.minSeconds && +b.dataset.max === st.maxSeconds));
  const perHour = Math.round(3600 / ((st.minSeconds + st.maxSeconds) / 2));
  const hint = $('cIntervalHint');
  hint.textContent = st.minSeconds < 45
    ? `⚠ About ${perHour} checks an hour. Under 45 s risks TicketSwap's "too many refreshes" block.`
    : `About ${perHour} checks an hour per event.`;
  hint.className = `hint${st.minSeconds < 45 ? ' warn' : ''}`;
  setValue($('cPauseMinutes'), String(st.pauseMinutes));
  $('cResume').disabled = !data.pausedUntil;
  $('cPauseState').textContent = data.pausedUntil
    ? `Paused until ${fmtClock(data.pausedUntil, false)}: ${data.pauseReason || ''}`
    : st.enabled ? 'Not paused.' : 'Checking is turned off.';
  setValue($('cMinAvailable'), st.minAvailable);
  for (const [id, key] of Object.entries(SWITCHES)) setValue($(id), st[key]);
  setValue($('cEmail'), st.email || '');
  $('cTopic').textContent = st.ntfyTopic || 'none';
  $('cTopicLink').href = `https://ntfy.sh/${encodeURIComponent(st.ntfyTopic || '')}`;
  setValue($('cVolume'), st.alarmVolume);
  if (document.activeElement !== $('cVolume')) $('cVolumeValue').textContent = `${st.alarmVolume}%`;
  setValue($('cAlarmSeconds'), String(st.alarmSeconds));
  renderControlEvents();

  const dl = $('cData');
  dl.replaceChildren();
  const first = data.histIndex[0];
  for (const [k, v] of [
    ['History stored', data.histIndex.length ? `${data.histIndex.length} hours of checks, since ${first ? fmtClock(new Date(+first.slice(5, 9), +first.slice(9, 11) - 1, +first.slice(11, 13), +first.slice(13, 15)).getTime(), false) : '–'}` : 'none yet'],
    ['Events stored', `${data.eventsStored} (newest 500 kept)`],
    ['Kept for', '14 days, then deleted automatically'],
    ['Mac alarm helper', data.helper ? (data.helper.ok ? `connected, answered ${fmtAgo(data.helper.at)}` : `not reachable: ${data.helper.error}`) : 'not checked yet'],
    ['Add-on version', chrome.runtime.getManifest().version],
  ]) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
}

let reloadTimer;
chrome.storage.onChanged.addListener(() => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(load, 800);
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => data && renderCharts(), 150);
});
setInterval(() => data && renderHealth(), 1000);

renderRanges();
showView(view);
load();
