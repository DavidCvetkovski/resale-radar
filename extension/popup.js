const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
let settings;

function ago(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

let pausedUntil = null;

function describe(s) {
  if (pausedUntil > Date.now()) {
    return `Paused until ${new Date(pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${s.status === 'limited' ? ': TicketSwap said too many refreshes' : ''}. Resumes by itself.`;
  }
  if (s.ended) return 'Event is over, not checking anymore';
  if (!s.lastCheck) return 'Not checked yet';
  if (s.status === 'ok') return `${s.available} available · ${s.sold} sold · ${s.wanted} wanted · checked ${ago(s.lastCheck)}`;
  if (s.status === 'blocked') return `Paused: TicketSwap wants a verification. Open the pinned tab. (${ago(s.lastCheck)})`;
  if (s.status === 'limited') return `TicketSwap said too many refreshes (${ago(s.lastCheck)})`;
  return `Problem: ${s.error} (${ago(s.lastCheck)})`;
}

function render({ settings: next, state, helper, nextCheck, pausedUntil: paused }) {
  settings = next;
  pausedUntil = paused || null;
  $('enabled').checked = settings.enabled;
  for (const id of ['minSeconds', 'maxSeconds']) {
    if (document.activeElement !== $(id)) $(id).value = settings[id];
  }
  const inSeconds = nextCheck ? Math.max(0, Math.round((nextCheck - Date.now()) / 1000)) : null;
  $('next').textContent = !settings.enabled || inSeconds === null ? '' : pausedUntil > Date.now() ? 'Paused, see below' : `Next check in ${inSeconds}s`;
  $('helper').textContent = !helper
    ? 'Mac alarm: not checked yet'
    : helper.ok
      ? 'Mac alarm: connected ✓'
      : `Mac alarm: not reachable (${helper.error})`;
  if (document.activeElement !== $('email')) $('email').value = settings.email || '';
  $('topic').textContent = settings.ntfyTopic;
  $('events').replaceChildren(
    ...settings.events.map((ev) => {
      const s = state[ev.url] || {};
      const div = document.createElement('div');
      div.className = 'event';
      const link = document.createElement('a');
      link.href = ev.url;
      link.target = '_blank';
      link.textContent = ev.name || s.title || ev.url;
      const info = document.createElement('div');
      info.className = `info ${s.status || ''} ${s.available > 0 ? 'hot' : ''}`;
      info.textContent = describe(s);
      const remove = document.createElement('button');
      remove.title = 'Stop watching';
      remove.textContent = '×';
      remove.onclick = () => save({ events: settings.events.filter((e) => e.url !== ev.url) });
      div.append(link, info, remove);
      return div;
    })
  );
}

async function save(patch) {
  render(await send({ cmd: 'save', settings: patch }));
}

$('enabled').onchange = () => save({ enabled: $('enabled').checked });
$('email').onchange = () => save({ email: $('email').value.trim() });

$('minSeconds').onchange = $('maxSeconds').onchange = () => {
  const min = Math.max(30, Math.round(Number($('minSeconds').value) || 30));
  const max = Math.max(min, Math.round(Number($('maxSeconds').value) || min));
  $('msg').textContent = `Checking every ${min}–${max} seconds.`;
  save({ minSeconds: min, maxSeconds: max });
};

$('add').onsubmit = (e) => {
  e.preventDefault();
  const url = $('newUrl').value.trim().split('?')[0];
  if (!/^https:\/\/www\.ticketswap\.(com|nl)\//.test(url)) {
    $('msg').textContent = 'That needs to be a ticketswap.com event link.';
    return;
  }
  $('newUrl').value = '';
  if (!settings.events.some((ev) => ev.url === url)) save({ events: [...settings.events, { url, name: '' }] });
};

$('check').onclick = async () => {
  $('msg').textContent = 'Checking…';
  render(await send({ cmd: 'checkNow' }));
  $('msg').textContent = 'Checked just now.';
};

$('dashboard').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });

$('test').onclick = async () => {
  $('msg').textContent = 'Ringing…';
  const r = await send({ cmd: 'test' });
  $('msg').textContent = r.error ? `Test failed: ${r.error}` : `Alarm: ${r.mac} · Email: ${r.email} · Phone push: ${r.phone}`;
};

send({ cmd: 'status' }).then(render);
setInterval(() => send({ cmd: 'status' }).then(render), 5000);
