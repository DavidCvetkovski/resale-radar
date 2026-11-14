// Backup alarm: a sweeping siren played by Chrome when the Mac helper isn't reachable.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.target === 'offscreen' && msg.cmd === 'siren') siren(msg.seconds || 20);
});

function siren(seconds) {
  const ctx = new AudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  gain.gain.value = 0.6;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime;
  for (let t = 0; t < seconds; t += 0.6) {
    osc.frequency.setValueAtTime(650, t0 + t);
    osc.frequency.linearRampToValueAtTime(1150, t0 + t + 0.6);
  }
  osc.onended = () => ctx.close();
  osc.start(t0);
  osc.stop(t0 + seconds);
}
