// Resale Radar: reloads each watched event page in a pinned tab at a random interval
// between your min and max seconds, reads the "N available • N sold • N wanted" line, and when N available goes up it
// shows a notification, rings the Mac and emails you (both via the native Mac helper),
// and pushes to your phone (via ntfy.sh).
//
// It only reads the page the way you would. If TicketSwap shows a verification check,
// the add-on stops and tells you instead of trying to get past it. If TicketSwap says
// "too many refreshes" (or checks keep failing), it pauses and backs off before trying again.
// Once an event is over (its stop time has passed) it stops checking it and closes its tab.
//
// Every check and every notable event is logged to chrome.storage for dashboard.html.

import { DEFAULTS } from './config.js';
import { DEFAULT_OPTIONS, eventStopAt, sanitize } from './defaults.js';

const HOST = 'local.ticketswap_alarm';
const ALARM = 'check';
const WATCHDOG = 'watchdog';
const MIN_SECONDS = 30; // Chrome won't fire alarms more often than this anyway.
const COUNTS = /(\d+)\s+[^\s•\d]+\s*•\s*(\d+)\s+[^\s•\d]+\s*•\s*(\d+)\s+[^\s•\d]+/;
const VERIFY = /verifying|unable to verify|captcha|are you a robot|access denied/i;
const LIMITED = /too many refreshes|too many requests|lost access to this page|rate.?limit/i;
const HISTORY_DAYS = 14;
const MAX_EVENTS = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_OPTIONS, ...DEFAULTS, ...(settings || {}) };
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return state || {};
}

const setState = (state) => chrome.storage.local.set({ state });

const eventName = (ev, s = {}) => ev.name || s.title || 'TicketSwap event';

// ---------- history (read by dashboard.html) ----------

// Storage writes below read, change and write back a value, so they run one at a time.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn).catch((e) => console.warn('log write failed', e)));

const pad = (n) => String(n).padStart(2, '0');
function bucketKey(t) {
  const d = new Date(t);
  return `hist:${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}`;
}

// Checks are stored in one bucket per hour ("hist:YYYYMMDDHH"), listed in histIndex; buckets
// older than HISTORY_DAYS are dropped.
function logCheck(entry) {
  return serial(async () => {
    const key = bucketKey(entry.t);
    const { [key]: bucket = [], histIndex = [] } = await chrome.storage.local.get([key, 'histIndex']);
    bucket.push(entry);
    const update = { [key]: bucket };
    if (!histIndex.includes(key)) {
      const cutoff = bucketKey(Date.now() - HISTORY_DAYS * 864e5);
      const old = histIndex.filter((k) => k < cutoff);
      if (old.length) await chrome.storage.local.remove(old);
      update.histIndex = [...histIndex.filter((k) => k >= cutoff), key];
    }
    await chrome.storage.local.set(update);
  });
}

// type: start | update | helper | settings | problem | blocked | limited | paused | resumed | recovered | skipped | watchdog | alert | test | ended
function logEvent(type, text, extra = {}) {
  return serial(async () => {
    const { events = [] } = await chrome.storage.local.get('events');
    events.push({ t: Date.now(), type, text, ...extra });
    await chrome.storage.local.set({ events: events.slice(-MAX_EVENTS) });
  });
}

// Each check books the next one at a random moment between minSeconds and maxSeconds.
async function scheduleNext(firstInSeconds) {
  const settings = await getSettings();
  const min = Math.max(MIN_SECONDS, Number(settings.minSeconds) || MIN_SECONDS);
  const max = Math.max(min, Number(settings.maxSeconds) || min);
  const { pausedUntil } = await chrome.storage.local.get('pausedUntil');
  const seconds = firstInSeconds ?? min + Math.random() * (max - min);
  const when = Math.max(Date.now() + seconds * 1000, pausedUntil || 0);
  await chrome.alarms.create(ALARM, { when });
  await chrome.storage.local.set({ nextCheck: when });
  return (when - Date.now()) / 1000;
}

// Stops timer checks until `until`; the next check is booked for then.
async function pause(until, why) {
  await chrome.storage.local.set({ pausedUntil: until, pauseReason: why });
  await scheduleNext();
  const at = new Date(until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  logEvent('paused', `Paused until ${at}: ${why}`);
  return at;
}

// How long to wait after this check: rate limits wait pauseMinutes (15 by default), then double it,
// up to 4×; any 3+ failures in a row wait 5, 10, 20, 40, then 60 min. 0 means carry on as normal.
function backoffMinutes(next, settings) {
  const base = settings.pauseMinutes;
  if (next.status === 'limited') return Math.min(base * 4, base * 2 ** ((next.limitedStreak || 1) - 1));
  if (next.fails >= 3) return Math.min(60, 5 * 2 ** (next.fails - 3));
  return 0;
}

async function start(why) {
  const version = chrome.runtime.getManifest().version;
  logEvent('start', `${why} (version ${version})`);
  chrome.alarms.create(WATCHDOG, { periodInMinutes: 5 });
  // Coming back while checks were failing only moments ago: wait before hitting TicketSwap again.
  const { pausedUntil } = await chrome.storage.local.get('pausedUntil');
  const settings = await getSettings();
  const failing = Object.values(await getState()).filter((s) => s.fails >= 2 && Date.now() - s.lastCheck < settings.pauseMinutes * 6e4);
  if (failing.length && !(pausedUntil > Date.now())) {
    await pause(Date.now() + settings.pauseMinutes * 6e4, `the last ${failing[0].fails} checks failed, so waiting before trying again`);
  }
  // Restarts (updates, Chrome relaunching) shouldn't cost an extra request if a check just ran.
  const last = Math.max(0, ...Object.values(await getState()).map((s) => s.lastCheck || 0));
  scheduleNext(Date.now() - last < settings.minSeconds * 1000 ? undefined : 5);
  selfTest();
}

const INSTALL_REASONS = { install: 'Add-on installed', update: 'Add-on reloaded or updated', chrome_update: 'Chrome updated' };
chrome.runtime.onInstalled.addListener((d) => start(INSTALL_REASONS[d.reason] || 'Add-on started'));
chrome.runtime.onStartup.addListener(() => start('Chrome started'));
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === WATCHDOG) {
    // Picks up updates even while paused, and restarts the chain if Chrome ever dropped the next check.
    checkControl();
    if (!(await chrome.alarms.get(ALARM))) {
      await scheduleNext();
      logEvent('watchdog', 'The check timer had stopped; restarted it');
    }
    return;
  }
  if (a.name !== ALARM) return;
  const { nextCheck } = await chrome.storage.local.get('nextCheck');
  const late = nextCheck ? Date.now() - nextCheck : null;
  const next = await scheduleNext();
  // An update reloads the add-on; skip this check so the reload doesn't cut it off halfway.
  if (await checkControl()) return;
  checkAll('timer', { late, next });
});

// Pings the Mac helper and remembers whether it answered (shown in the popup).
async function selfTest() {
  let helper;
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'ping' });
    helper = res && res.ok ? { ok: true } : { ok: false, error: 'no answer' };
  } catch (e) {
    helper = { ok: false, error: String(e.message || e) };
  }
  await chrome.storage.local.set({ helper: { ...helper, at: Date.now() } });
  logEvent('helper', helper.ok ? 'Mac alarm helper answered' : `Mac alarm helper not reachable: ${helper.error}`, { ok: helper.ok });
  return helper;
}

// control.json lets install.sh and test-alarm.sh reach the add-on without a trip to chrome://extensions:
// a new "version" makes it reload itself with the new files, a new "test" token rings a test alarm.
// Returns true when it is about to reload.
async function checkControl() {
  let control;
  try {
    control = await (await fetch(chrome.runtime.getURL('control.json'), { cache: 'no-store' })).json();
  } catch {
    return false;
  }
  if (control.version && control.version !== chrome.runtime.getManifest().version) {
    await logEvent('update', `Updating from ${chrome.runtime.getManifest().version} to ${control.version}`);
    chrome.runtime.reload();
    return true;
  }
  const { lastTestToken } = await chrome.storage.local.get('lastTestToken');
  if (control.test && control.test !== lastTestToken) {
    await chrome.storage.local.set({ lastTestToken: control.test });
    await runTest();
  }
  return false;
}

// A test alarm through every switched-on channel, or through just one (`only`: mac | notify | email | phone).
async function runTest(only) {
  const settings = await getSettings();
  const ev = settings.events[0] || { url: 'https://www.ticketswap.com' };
  return fire(eventName(ev, (await getState())[ev.url]), { available: 1 }, ev.url, settings, true, only);
}

// ---------- checking ----------

let running = false;

async function checkAll(reason, timing = {}) {
  if (running) {
    logEvent('skipped', `Skipped a ${reason} check: the previous check was still running`);
    return;
  }
  running = true;
  try {
    const settings = await getSettings();
    if (!settings.enabled && reason === 'timer') return;
    const { pausedUntil } = await chrome.storage.local.get('pausedUntil');
    if (reason === 'timer' && pausedUntil > Date.now() + 1000) return;
    const state = await getState();
    for (const ev of settings.events) {
      const prev = state[ev.url] || {};
      const stopAt = eventStopAt(ev);
      if (stopAt && Date.now() > stopAt) {
        if (!prev.ended) await endEvent(ev, prev, state, settings, stopAt);
        continue;
      }
      const { result: next, how, ms } = await checkEvent(ev.url, prev);
      next.ended = false;
      next.fails = next.status === 'ok' ? 0 : (prev.fails || 0) + 1;
      next.limitedStreak = next.status === 'limited' ? (prev.limitedStreak || 0) + 1 : 0;
      state[ev.url] = next;
      await setState(state);
      const alert = next.status === 'ok' && next.available >= settings.minAvailable && next.available > (prev.available || 0);
      logCheck({
        t: next.lastCheck,
        url: ev.url,
        reason,
        status: next.status,
        available: next.status === 'ok' ? next.available : null,
        sold: next.status === 'ok' ? next.sold : null,
        wanted: next.status === 'ok' ? next.wanted : null,
        error: next.status === 'ok' ? null : next.error,
        ms,
        gap: prev.lastCheck ? next.lastCheck - prev.lastCheck : null,
        late: timing.late ?? null,
        next: timing.next ?? null,
        alert,
        ...how,
      });
      logTransition(eventName(ev, next), prev, next);
      if (alert) await fire(eventName(ev, next), next, ev.url, settings, false);
      if (next.status === 'blocked' && prev.status !== 'blocked') {
        await warnBlocked(eventName(ev, next), next, ev.url, settings);
      }
      const wait = backoffMinutes(next, settings);
      if (wait) {
        const why = next.status === 'limited' ? 'TicketSwap says too many refreshes' : `${next.fails} checks in a row failed (${next.error})`;
        const at = await pause(Date.now() + wait * 6e4, why);
        await warnPaused(eventName(ev, next), why, at, ev.url, settings);
      } else if (next.status === 'ok') {
        await chrome.storage.local.remove(['pausedUntil', 'pauseReason']);
      }
    }
    await updateBadge(settings, state);
  } finally {
    running = false;
  }
}

// The event is over: log it once, close its checker tab and leave it alone from now on.
async function endEvent(ev, prev, state, settings, stopAt) {
  const name = eventName(ev, prev);
  const at = new Date(stopAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (prev.tabId) chrome.tabs.remove(prev.tabId).catch(() => {});
  state[ev.url] = { ...prev, ended: true, tabId: null };
  await setState(state);
  logEvent('ended', `${name} is over (stop time ${at}); stopped checking it`);
  if (settings.alertNotify) {
    chrome.notifications.create(`ended|${ev.url}|${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon.png',
      title: 'Resale Radar stopped',
      message: `${name} is over, so it's no longer being checked. Set a later stop time in the dashboard to keep going.`,
      priority: 0,
    });
  }
}

function logTransition(name, prev, next) {
  if (next.status === prev.status || !prev.status) return;
  if (next.status === 'ok') logEvent('recovered', `${name}: checks working again after ${prev.fails || 1} failed`);
  else if (next.status === 'blocked') logEvent('blocked', `${name}: TicketSwap is showing a verification check`);
  else if (next.status === 'limited') logEvent('limited', `${name}: TicketSwap says too many refreshes`);
  else logEvent('problem', `${name}: check failed (${next.error})`);
}

// Returns the new state for this event plus "how" details of the check for the history log.
async function checkEvent(url, prev) {
  const lastCheck = Date.now();
  const how = {};
  let result;
  try {
    const tabId = await watcherTab(url, prev.tabId, how);
    const page = await readPage(tabId, how);
    result = { ...prev, ...page, tabId, lastCheck };
  } catch (e) {
    result = { ...prev, status: 'error', error: String(e.message || e), lastCheck };
  }
  return { result, how, ms: Date.now() - lastCheck };
}

// Reloads (or creates) the pinned background tab for this event and waits for it to load.
async function watcherTab(url, tabId, how) {
  const tab = tabId && (await chrome.tabs.get(tabId).catch(() => null));
  const loadStart = Date.now();
  if (tab) {
    const same = (tab.url || '').split('?')[0] === url.split('?')[0];
    how.tab = same ? 'reloaded' : 'sent back to event';
    how.loadTimedOut = await loadTab(tab.id, () =>
      same ? chrome.tabs.reload(tab.id, { bypassCache: true }) : chrome.tabs.update(tab.id, { url })
    );
    how.loadMs = Date.now() - loadStart;
    return tab.id;
  }
  let created;
  try {
    created = await chrome.tabs.create({ url: 'about:blank', active: false, pinned: true });
    how.tab = 'opened new tab';
  } catch {
    // No browser window open: use a minimized one.
    const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized' });
    created = win.tabs[0];
    how.tab = 'opened new window';
  }
  how.loadTimedOut = await loadTab(created.id, () => chrome.tabs.update(created.id, { url }));
  how.loadMs = Date.now() - loadStart;
  return created.id;
}

// Resolves with true if the page didn't finish loading within 25 s.
function loadTab(tabId, start) {
  return new Promise((resolve, reject) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') done(resolve, false);
    };
    // Don't fail on a slow load; readPage keeps polling the page afterwards.
    const timer = setTimeout(() => done(resolve, true), 25000);
    const done = (fn, arg) => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      fn(arg);
    };
    chrome.tabs.onUpdated.addListener(listener);
    start().catch((e) => done(reject, e));
  });
}

// Polls the page text until the ticket counts show up (the page may first show a short "Verifying" screen).
async function readPage(tabId, how) {
  const readStart = Date.now();
  const deadline = readStart + 30000;
  let text = '';
  how.tries = 0;
  how.sawVerify = false;
  while (Date.now() < deadline) {
    how.tries += 1;
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          text: document.body ? document.body.innerText : '',
          title: document.title,
          httpStatus: performance.getEntriesByType('navigation')[0]?.responseStatus || null,
        }),
      });
      text = result.text;
      how.httpStatus = result.httpStatus;
      how.readError = null;
      if (VERIFY.test(text)) how.sawVerify = true;
      if (LIMITED.test(text)) break;
      const m = text.match(COUNTS);
      if (m) {
        how.readMs = Date.now() - readStart;
        return {
          status: 'ok',
          available: Number(m[1]),
          sold: Number(m[2]),
          wanted: Number(m[3]),
          title: result.title.replace(/\s*[–-]\s*TicketSwap.*$/i, '').slice(0, 80),
          error: null,
        };
      }
    } catch (e) {
      // Page is mid-navigation (try again), or Chrome is showing its own error page instead.
      how.readError = String(e.message || e).slice(0, 160);
    }
    await sleep(2000);
  }
  how.readMs = Date.now() - readStart;
  // What the page said instead, so the dashboard can show it.
  how.snippet = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  if (LIMITED.test(text) || [403, 429].includes(how.httpStatus)) {
    return { status: 'limited', error: 'TicketSwap says too many refreshes' };
  }
  if (VERIFY.test(text)) return { status: 'blocked', error: 'TicketSwap is showing a verification check' };
  if (!text && how.readError) return { status: 'error', error: `couldn't read the page: ${how.readError}` };
  return { status: 'error', error: 'could not find the ticket count on the page' };
}

// ---------- alerting ----------

const CHANNEL_SETTING = { mac: 'alertMac', notify: 'alertNotify', email: 'alertEmail', phone: 'alertPhone' };

async function fire(name, info, url, settings, test, only) {
  const n = info.available;
  const use = (channel) => (only ? only === channel : settings[CHANNEL_SETTING[channel]]);
  const title = test ? 'Test alarm: Resale Radar works' : 'Tickets available!';
  const message = test
    ? `This is what you'll get when tickets show up for ${name}.`
    : `${n} ticket${n === 1 ? '' : 's'} listed for ${name}. Go go go!`;

  let notify = 'off';
  if (use('notify')) {
    chrome.notifications.create(`alert|${url}|${Date.now()}`, {
      type: 'basic',
      iconUrl: 'icon.png',
      title,
      message,
      priority: 2,
      requireInteraction: !test,
    });
    notify = 'shown';
  }
  if (!test && settings.alertTab) await focusTab(info.tabId);
  const [mac, email, phone] = await Promise.all([
    use('mac') ? ringMac(title, message, test, settings) : 'off',
    use('email') ? sendEmail(settings, title, message, url) : 'off',
    use('phone') ? pushToPhone(settings, title, message, url, test ? 'default' : 'urgent', test) : 'off',
  ]);
  const result = { mac, email, phone, notify };
  await chrome.storage.local.set({ lastAlert: { ...result, test, at: Date.now() } });
  logEvent(
    test ? 'test' : 'alert',
    `${test ? `Test${only ? ` (${only} only)` : ''}` : `${n} ticket${n === 1 ? '' : 's'} for ${name}`}: alarm ${mac}, notification ${notify}, email ${email}, phone ${phone}`,
    result
  );
  return result;
}

async function warnBlocked(name, info, url, settings) {
  const title = 'Resale Radar is paused';
  const message = `TicketSwap is showing a verification check on ${name}. Open the pinned TicketSwap tab and finish it yourself; checking carries on after that.`;
  if (settings.alertNotify) chrome.notifications.create(`blocked|${url}|${Date.now()}`, { type: 'basic', iconUrl: 'icon.png', title, message, priority: 2 });
  await Promise.all([
    settings.alertEmail && sendEmail(settings, title, message, url),
    settings.alertPhone && pushToPhone(settings, title, message, url, 'default', false),
  ]);
}

async function warnPaused(name, why, at, url, settings) {
  const title = `Resale Radar paused until ${at}`;
  const message = `${why} on ${name}. It starts checking again by itself at ${at}. Don't refresh TicketSwap yourself meanwhile.`;
  if (settings.alertNotify) chrome.notifications.create(`paused|${url}|${Date.now()}`, { type: 'basic', iconUrl: 'icon.png', title, message, priority: 1 });
  if (settings.alertPhone) await pushToPhone(settings, title, message, url, 'default', false);
}

async function focusTab(tabId) {
  if (!tabId) return;
  const tab = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
  if (tab) await chrome.windows.update(tab.windowId, { focused: true, state: 'normal' }).catch(() => {});
}

// Loud alarm through the Mac helper; falls back to a siren played by Chrome itself.
async function ringMac(title, message, test, settings) {
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, {
      cmd: 'ring',
      title,
      message,
      seconds: test ? 8 : settings.alarmSeconds,
      volume: settings.alarmVolume,
      voice: settings.alarmVoice,
    });
    if (res && res.ok) return 'mac helper';
  } catch (e) {
    console.warn('Mac helper not reachable, using Chrome siren:', e.message || e);
  }
  await sirenInChrome(test ? 5 : Math.min(60, settings.alarmSeconds));
  return 'chrome siren';
}

async function sirenInChrome(seconds) {
  try {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['AUDIO_PLAYBACK'], justification: 'Ticket alarm sound' });
  } catch {
    // Already open.
  }
  await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'siren', seconds }).catch(() => {});
}

// The Mac helper sends the email from your Gmail (app password in the macOS Keychain).
async function sendEmail(settings, title, message, url) {
  if (!settings.email) return 'off';
  try {
    const res = await chrome.runtime.sendNativeMessage(HOST, { cmd: 'email', to: settings.email, subject: title, body: `${message}\n\n${url}` });
    return res && res.ok ? 'sent' : `failed (${(res && res.error) || 'no answer'})`;
  } catch (e) {
    return `failed (${e.message || e})`;
  }
}

// ntfy.sh pushes to any phone subscribed to the topic in the ntfy app.
async function pushToPhone(settings, title, message, url, priority, test) {
  if (!settings.ntfyTopic) return 'off';
  const headers = {
    Title: title.replace(/[^\x20-\x7e]/g, ''),
    Priority: priority,
    Tags: test ? 'test_tube' : 'rotating_light,tickets',
    Click: url,
  };
  try {
    const r = await fetch(`https://ntfy.sh/${encodeURIComponent(settings.ntfyTopic)}`, {
      method: 'POST',
      headers,
      body: `${message}\n\n${url}`,
    });
    return r.ok ? 'sent' : `failed (${r.status})`;
  } catch (e) {
    return `failed (${e.message || e})`;
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const url = id.split('|')[1];
  const state = await getState();
  if (state[url] && state[url].tabId) await focusTab(state[url].tabId);
  chrome.notifications.clear(id);
});

async function updateBadge(settings, state) {
  const list = settings.events.map((ev) => state[ev.url] || {});
  const available = list.reduce((sum, s) => sum + (s.status === 'ok' ? s.available : 0), 0);
  let text = '';
  let color = '#888888';
  if (!settings.enabled) text = 'off';
  else if (list.length && list.every((s) => s.ended)) text = 'end';
  else if (available > 0) [text, color] = [String(available), '#d00000'];
  else if (list.some((s) => s.status === 'limited')) [text, color] = ['II', '#e08000'];
  else if (list.some((s) => s.status && s.status !== 'ok')) [text, color] = ['!', '#e08000'];
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

// ---------- popup ----------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.target === 'offscreen') return false;
  handle(msg).then(reply, (e) => reply({ error: String(e.message || e) }));
  return true;
});

async function handle(msg) {
  if (msg.cmd === 'status') return status();
  if (msg.cmd === 'checkNow') {
    await Promise.all([checkAll('manual'), selfTest()]);
    return status();
  }
  if (msg.cmd === 'test') return runTest(msg.only);
  if (msg.cmd === 'ping') return { helper: await selfTest() };
  if (msg.cmd === 'pause') {
    await pause(Date.now() + msg.minutes * 6e4, 'paused by you');
    return status();
  }
  if (msg.cmd === 'resume') {
    await chrome.storage.local.remove(['pausedUntil', 'pauseReason']);
    logEvent('resumed', 'Resumed by you');
    await scheduleNext(5);
    return status();
  }
  if (msg.cmd === 'showTab') {
    const s = (await getState())[msg.url];
    const tab = s && s.tabId && (await chrome.tabs.get(s.tabId).catch(() => null));
    if (tab) await focusTab(tab.id);
    return { ok: !!tab };
  }
  if (msg.cmd === 'clearHistory') {
    await serial(async () => {
      const { histIndex = [] } = await chrome.storage.local.get('histIndex');
      await chrome.storage.local.remove([...histIndex, 'histIndex', 'events']);
    });
    logEvent('settings', 'History cleared');
    return status();
  }
  if (msg.cmd === 'newTopic') {
    const hex = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return handle({ cmd: 'save', settings: { ntfyTopic: `ts-alarm-${hex}` } });
  }
  if (msg.cmd === 'restart') {
    await logEvent('update', 'Restarted from the dashboard');
    setTimeout(() => chrome.runtime.reload(), 100);
    return { ok: true };
  }
  if (msg.cmd === 'save') {
    const before = await getSettings();
    const settings = sanitize({ ...before, ...msg.settings });
    await chrome.storage.local.set({ settings });
    const changed = Object.keys(msg.settings).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k]));
    if (changed.length) logEvent('settings', `Changed ${changed.map((k) => `${k}: ${describeSetting(k, settings[k])}`).join(', ')}`);
    const state = await getState();
    for (const url of Object.keys(state)) {
      if (!settings.events.some((ev) => ev.url === url)) {
        if (state[url].tabId) chrome.tabs.remove(state[url].tabId).catch(() => {});
        delete state[url];
      }
    }
    await setState(state);
    await updateBadge(settings, state);
    if ('minSeconds' in msg.settings || 'maxSeconds' in msg.settings || 'enabled' in msg.settings) await scheduleNext();
    return status();
  }
  return { error: `unknown command ${msg.cmd}` };
}

function describeSetting(key, value) {
  if (key === 'events') return `${value.length} event${value.length === 1 ? '' : 's'}`;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

async function status() {
  const { helper, nextCheck, pausedUntil, pauseReason, lastAlert } = await chrome.storage.local.get(['helper', 'nextCheck', 'pausedUntil', 'pauseReason', 'lastAlert']);
  return { settings: await getSettings(), state: await getState(), helper, nextCheck, pausedUntil, pauseReason, lastAlert };
}
