'use strict';
/**
 * control.js — runs in the control panel window.
 *
 * Two jobs:
 *  1. AUDIO ANALYSIS: capture the system audio (or a chosen input device), detect the tempo and
 *     beats with TempoTracker, and send the result to the main process twice a second.
 *     (This is why the panel keeps running, hidden, when you minimize it to the tray.)
 *  2. UI: show tempo status, global settings, and the list of mascots.
 *
 * Everything the UI shows is built with DOM methods / textContent — never innerHTML with
 * data from the config file — so a tampered config can't inject script into this window.
 */
const { ipcRenderer, webUtils } = require('electron');
const fs = require('fs');
const { TempoTracker, spectralFlux } = require('../shared/tempo');

const $ = (id) => document.getElementById(id);
let state = { settings: {}, mascots: [] }; // last snapshot from the main process

// ═════════════════════════════ 1. Audio analysis ═════════════════════════════

const tracker = new TempoTracker();
let audioCtx = null, analyser = null, stream = null, source = null;
let freq = null, prevFreq = null, wave = null; // reusable buffers for the analyser
let audioError = null;                         // message shown in the status line if capture fails

/** (Re)start capturing from the audio source chosen in settings. */
async function startAudio() {
  stopAudio();
  audioError = null;
  const src = state.settings.audioSource || 'loopback';
  try {
    if (src === 'loopback') {
      // The main process answers this request with a loopback of the default output device.
      // Chromium insists on a video track too; we stop it immediately and keep only the audio.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) {
        throw new Error('System audio capture is not available. Pick an input device (e.g. "Stereo Mix") instead.');
      }
    } else {
      // A specific input device. All the "helpful" voice processing is off: we want the raw music.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: src }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    audioCtx = new AudioContext();
    source = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0; // we want raw frames so onsets stay sharp
    source.connect(analyser);           // deliberately NOT connected to the speakers (no echo)
    freq = new Float32Array(analyser.frequencyBinCount);
    prevFreq = new Float32Array(analyser.frequencyBinCount).fill(-100);
    wave = new Float32Array(analyser.fftSize);
    tracker.reset();
  } catch (e) {
    audioError = e.message || String(e);
    console.error(e);
  }
  render();
}

function stopAudio() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  if (audioCtx) audioCtx.close();
  stream = audioCtx = analyser = source = null;
}

// How the analysis loop spends CPU:
//   • nobody can see a mascot (all hidden/unloaded) → do nothing, wake once a second
//   • silence                                       → peek at the loudness 5×/s
//   • music playing                                 → full analysis ~60×/s
let mascotsVisible = true; // main process tells us (see 'activity' message below)

function analysisTick() {
  let delay = 1000;
  if (analyser && mascotsVisible) {
    analyser.getFloatTimeDomainData(wave);
    let sum = 0;
    for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
    const rms = Math.sqrt(sum / wave.length); // loudness
    const t = performance.now() / 1000;

    if (tracker.playing || rms >= tracker.silenceLevel) {
      // Music: measure how much new sound energy appeared (spectral flux) and feed the tracker.
      analyser.getFloatFrequencyData(freq);
      tracker.push(t, spectralFlux(prevFreq, freq, 190), rms);
      prevFreq.set(freq);
      delay = 16;
    } else {
      // Silence: just record that it is quiet; skip the expensive spectrum work.
      tracker.push(t, 0, rms);
      prevFreq.fill(-100);
      delay = 200;
    }
  }
  setTimeout(analysisTick, delay);
}
analysisTick();

let shown = { playing: false, bpm: null }; // what the big BPM readout displays

// 2×/s: ask the tracker for its smoothed result and send it to the mascots.
setInterval(() => {
  const t = analyser ? tracker.update() : { playing: false, bpm: null, confidence: 0, beatT: null, period: null };
  const manual = state.settings.tempoMode === 'manual';
  const bpm = manual ? state.settings.manualBpm : t.bpm;

  ipcRenderer.send('tempo', {
    playing: t.playing && !!bpm,
    bpm: t.bpm,
    // Tracker time is performance.now()/1000; convert to epoch milliseconds so other windows
    // (which have their own performance clocks) can use it.
    beat: t.beatT === null ? null : performance.timeOrigin + t.beatT * 1000,
    period: t.period,
  });

  shown = { playing: t.playing, bpm: bpm ? bpm * (state.settings.octave || 1) : null };
  renderStatus();

  recordHistory({ t: Date.now(), playing: t.playing, applied: shown.bpm, raw: t.raw });
  drawGraph();
}, 500);

// ═════════════════════════════ 2. UI ═════════════════════════════

/** Shorthands for sending changes to the main process. */
const update = (patch) => ipcRenderer.send('settings:update', patch);
const updateMascot = (id, patch) => {
  const m = state.mascots.find((x) => x.id === id);
  if (m) Object.assign(m, patch); // keep our copy fresh: these edits don't trigger a list rebuild
  ipcRenderer.send('mascot:update', id, patch);
};

/** Big BPM number + status dot/text. */
function renderStatus() {
  $('bpmValue').textContent = shown.bpm ? Math.round(shown.bpm) : '--';
  const dot = $('dot'), txt = $('statusText');
  dot.className = audioError ? 'err' : shown.playing ? 'on' : '';
  txt.textContent = audioError ? 'Audio error'
    : !mascotsVisible ? 'Idle — no mascots visible'
    : shown.playing ? 'Playing'
    : analyser ? 'Silence — mascots paused' : 'No audio';
  txt.title = audioError || '';
}

// ───── Tempo history graph ─────
// Keeps ~3 minutes of readings (one every 0.5 s) and draws them: the solid line is the tempo the
// mascots are using, dots are the detector's raw guesses, and shaded gaps mean silence. A wandering
// line or scattered dots means the detector is unsure; a flat line means it is locked on.
const HISTORY_MS = 3 * 60 * 1000;
const history = [];
const graph = $('graph');
const gctx = graph.getContext('2d');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function recordHistory(sample) {
  history.push(sample);
  while (history.length && sample.t - history[0].t > HISTORY_MS) history.shift();
}

function drawGraph() {
  // Skip the work when the panel is hidden or the section is collapsed.
  if (document.hidden || !$('graphBox').open) return;

  const dpr = window.devicePixelRatio || 1;
  const w = graph.clientWidth, h = graph.clientHeight;
  if (graph.width !== Math.round(w * dpr)) { graph.width = Math.round(w * dpr); graph.height = Math.round(h * dpr); }
  gctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  gctx.clearRect(0, 0, w, h);

  const pad = { l: 34, r: 6, t: 6, b: 16 };
  const lo = 60, hi = 190; // BPM range shown
  const x = (t) => pad.l + ((t - (Date.now() - HISTORY_MS)) / HISTORY_MS) * (w - pad.l - pad.r);
  const y = (bpm) => pad.t + (1 - (Math.min(hi, Math.max(lo, bpm)) - lo) / (hi - lo)) * (h - pad.t - pad.b);

  // Grid + labels
  gctx.font = '10px system-ui'; gctx.textBaseline = 'middle';
  for (let bpm = 80; bpm <= 180; bpm += 20) {
    gctx.strokeStyle = css('--line'); gctx.beginPath();
    gctx.moveTo(pad.l, y(bpm)); gctx.lineTo(w - pad.r, y(bpm)); gctx.stroke();
    gctx.fillStyle = css('--dim'); gctx.fillText(String(bpm), 4, y(bpm));
  }
  gctx.textBaseline = 'alphabetic';
  gctx.fillText('-3 min', pad.l, h - 3); gctx.fillText('now', w - pad.r - 20, h - 3);

  // Silence shading
  gctx.fillStyle = 'rgba(255,255,255,0.05)';
  history.forEach((p) => {
    if (!p.playing) gctx.fillRect(x(p.t) - 2, pad.t, 4, h - pad.t - pad.b);
  });

  // Raw detector guesses (dots)
  gctx.fillStyle = 'rgba(140,138,160,0.8)';
  for (const p of history) {
    if (p.raw) { gctx.beginPath(); gctx.arc(x(p.t), y(p.raw), 1.8, 0, Math.PI * 2); gctx.fill(); }
  }

  // Tempo in use (line, broken at silences)
  gctx.strokeStyle = css('--accent'); gctx.lineWidth = 2; gctx.beginPath();
  let pen = false;
  for (const p of history) {
    if (!p.playing || !p.applied) { pen = false; continue; }
    pen ? gctx.lineTo(x(p.t), y(p.applied)) : gctx.moveTo(x(p.t), y(p.applied));
    pen = true;
  }
  gctx.stroke();
  gctx.lineWidth = 1;
}
$('graphBox').addEventListener('toggle', drawGraph);

let lastKey = ''; // fingerprint of the mascot list structure (see render)

/** Sync every control with `state`, and rebuild the mascot list if its structure changed. */
function render() {
  const s = state.settings;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.tempoMode;
  $('manualBpm').disabled = s.tempoMode !== 'manual';
  if (document.activeElement !== $('manualBpm')) $('manualBpm').value = s.manualBpm;
  $('globalSpeed').value = s.globalSpeed;
  $('globalSpeedOut').textContent = `×${(+s.globalSpeed).toFixed(2)}`;
  $('locked').checked = !!s.locked;
  $('bounce').checked = !!s.bounce;
  $('bounceStrength').value = s.bounceStrength;
  $('bounceStrength').disabled = !s.bounce;
  $('pauseFs').checked = !!s.pauseOnFullscreen;
  $('pauseFs').disabled = !state.fullscreenSupported;
  $('fsHint').hidden = !!state.fullscreenSupported;
  $('login').checked = !!s.launchAtLogin;
  for (const b of $('octave').children) b.classList.toggle('on', +b.dataset.v === s.octave);
  if ($('audioSource').value !== s.audioSource && !$('audioSource').matches(':focus')) $('audioSource').value = s.audioSource;
  renderStatus();

  // Rebuild the list only when something structural changed, so dragging a slider
  // isn't interrupted by the list being recreated under the mouse.
  const key = JSON.stringify(state.mascots.map((m) => [m.id, m.enabled, m.missing, m.name, !!m.thumb]));
  if (key === lastKey) return;
  lastKey = key;

  const list = $('list');
  list.replaceChildren();
  if (!state.mascots.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No mascots yet — add some GIFs!';
    list.appendChild(empty);
  }
  for (const m of state.mascots) {
    list.appendChild(mascotCard(m));
    if (!m.thumb && !m.missing) makeThumbnail(m);
  }
}

/** Tiny DOM helper: el('div', {class: 'x', text: 'hi'}, [children]) */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  node.append(...children);
  return node;
}

/** Build one mascot row (thumbnail, name, On/Off, remove, and its own sliders). */
function mascotCard(m) {
  const speed = Number(m.speed) || 1;
  const card = el('div', { class: `mascot${m.enabled ? '' : ' off'}${m.missing ? ' missing' : ''}` });

  const thumb = el('img', { class: 'thumb', alt: '' });
  if (m.thumb) thumb.src = m.thumb;

  const toggle = el('button', { class: `toggle${m.enabled ? ' on' : ''}`, text: m.enabled ? 'On' : 'Off' });
  toggle.onclick = () => updateMascot(m.id, { enabled: !m.enabled });
  const remove = el('button', { class: 'remove', title: 'Remove from library', text: '✕' });
  remove.onclick = () => ipcRenderer.send('mascot:remove', m.id);

  // Per-mascot speed slider
  const out = el('output', { text: `×${speed.toFixed(2)}` });
  const slider = el('input', { class: 'speed', type: 'range', min: 0.25, max: 3, step: 0.05, value: speed });
  slider.oninput = () => { out.textContent = `×${(+slider.value).toFixed(2)}`; updateMascot(m.id, { speed: +slider.value }); };

  // "Loop looks right at N BPM" (what tempo the GIF was drawn for)
  const base = el('input', { class: 'base', type: 'number', min: 30, max: 300, value: Number(m.baseBpm) || 120 });
  base.onchange = () => updateMascot(m.id, { baseBpm: Math.min(300, Math.max(30, +base.value || 120)) });

  const smart = el('input', { type: 'checkbox', checked: m.smart !== false });
  smart.onchange = () => updateMascot(m.id, { smart: smart.checked });
  const flip = el('input', { type: 'checkbox', checked: !!m.flip });
  flip.onchange = () => updateMascot(m.id, { flip: flip.checked });

  card.append(
    thumb,
    el('div', { class: 'name', text: m.name }),
    el('div', { class: 'btns' }, [toggle, remove]),
    el('div', { class: 'ctl' }, [
      'Speed ', slider, out,
      ' Loop looks right at ', base, ' BPM',
      el('label', {}, [smart, ' ½/2× smart']),
      el('label', {}, [flip, ' flip']),
    ]),
  );
  return card;
}

// ───── Thumbnails ─────
// A still picture of the GIF's first frame, stored as a small PNG in the config. Made here
// (rather than shown with an <img> pointing at the GIF) so the panel never has to keep
// animated GIFs decoded in memory.
const thumbPending = new Set();

async function makeThumbnail(m) {
  if (thumbPending.has(m.id)) return;
  thumbPending.add(m.id);
  try {
    const buf = fs.readFileSync(m.path);
    if (buf.length > 100 * 1024 * 1024) return;
    const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/gif' })); // first frame only
    const c = document.createElement('canvas');
    c.height = 64;
    c.width = Math.max(1, Math.round((bitmap.width / bitmap.height) * 64));
    c.getContext('2d').drawImage(bitmap, 0, 0, c.width, c.height);
    bitmap.close();
    updateMascot(m.id, { thumb: c.toDataURL('image/png') });
    render();
  } catch (e) {
    console.error('thumbnail failed for', m.name, e.message);
  }
}

// ───── Audio source dropdown ─────
async function populateDevices() {
  const sel = $('audioSource');
  sel.replaceChildren(el('option', { value: 'loopback', text: 'System audio (what you hear)' }));
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const d of devices.filter((d) => d.kind === 'audioinput')) {
      sel.appendChild(el('option', { value: d.deviceId, text: `Input: ${d.label || d.deviceId.slice(0, 8)}` }));
    }
  } catch { /* device names may be hidden until permission is granted; the list still works */ }
  sel.value = state.settings.audioSource || 'loopback';
}

// ───── Control wiring ─────
$('audioSource').onchange = (e) => {
  state.settings.audioSource = e.target.value;
  update({ audioSource: e.target.value });
  startAudio();
};
for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => update({ tempoMode: r.value });
$('manualBpm').onchange = (e) => update({ manualBpm: Math.min(240, Math.max(40, +e.target.value || 120)) });
$('globalSpeed').oninput = (e) => {
  $('globalSpeedOut').textContent = `×${(+e.target.value).toFixed(2)}`;
  update({ globalSpeed: +e.target.value });
};
$('locked').onchange = (e) => update({ locked: e.target.checked });
$('bounce').onchange = (e) => update({ bounce: e.target.checked });
$('pauseFs').onchange = (e) => update({ pauseOnFullscreen: e.target.checked });
$('login').onchange = (e) => update({ launchAtLogin: e.target.checked });
$('bounceStrength').oninput = (e) => update({ bounceStrength: +e.target.value });
for (const b of $('octave').children) b.onclick = () => update({ octave: +b.dataset.v });
$('add').onclick = () => ipcRenderer.invoke('mascot:pick');
$('reset').onclick = () => ipcRenderer.send('mascot:reset-positions');

// Tap tempo: tap 3+ times; the average gap between taps becomes the manual BPM.
let taps = [];
$('tap').onclick = () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = []; // a pause starts a new count
  taps.push(now);
  taps = taps.slice(-8);
  if (taps.length >= 3) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    update({ tempoMode: 'manual', manualBpm: Math.round(60000 / avg) });
  }
};

// Drag & drop GIFs onto the window.
const drop = $('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => webUtils.getPathForFile(f)).filter((p) => /\.gif$/i.test(p));
  if (paths.length) ipcRenderer.send('mascot:add', paths);
});

// The main process pushes a fresh snapshot whenever the library or settings change.
ipcRenderer.on('state', (_e, s) => { state = s; render(); });

// Main tells us whether any mascot is currently visible (see analysisTick).
ipcRenderer.on('activity', (_e, needed) => { mascotsVisible = needed; renderStatus(); });

// ───── Startup ─────
(async () => {
  state = await ipcRenderer.invoke('state:get');
  render();
  await startAudio();
  await populateDevices();
  navigator.mediaDevices.addEventListener('devicechange', populateDevices);
})();
