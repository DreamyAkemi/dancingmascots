'use strict';
const { ipcRenderer, webUtils } = require('electron');
const { TempoTracker, spectralFlux } = require('../shared/tempo');

const $ = (id) => document.getElementById(id);
let state = { settings: {}, mascots: [] };

// ======================= audio analysis =======================
const tracker = new TempoTracker();
let audioCtx = null, analyser = null, stream = null, source = null;
let freq = null, prevFreq = null, wave = null;
let audioError = null;

async function startAudio() {
  stopAudio();
  audioError = null;
  const src = state.settings.audioSource || 'loopback';
  try {
    if (src === 'loopback') {
      // Main process answers this with a loopback of the default output device.
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (!stream.getAudioTracks().length) throw new Error('System audio capture is not available on this system. Pick an input device (e.g. "Stereo Mix" or a monitor/loopback device) instead.');
    } else {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: src }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    }
    audioCtx = new AudioContext();
    source = audioCtx.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser); // deliberately not connected to the speakers
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

setInterval(() => {
  if (!analyser) return;
  analyser.getFloatFrequencyData(freq);
  analyser.getFloatTimeDomainData(wave);
  let sum = 0;
  for (let i = 0; i < wave.length; i++) sum += wave[i] * wave[i];
  const rms = Math.sqrt(sum / wave.length);
  tracker.push(performance.now() / 1000, spectralFlux(prevFreq, freq, 190), rms);
  prevFreq.set(freq);
}, 16);

let shown = { playing: false, bpm: null };
setInterval(() => {
  const t = analyser ? tracker.update() : { playing: false, bpm: null, confidence: 0 };
  const manual = state.settings.tempoMode === 'manual';
  const bpm = manual ? state.settings.manualBpm : t.bpm;
  // In manual mode the mascots dance whenever there is sound; auto mode needs a detected tempo too.
  ipcRenderer.send('tempo', { playing: t.playing && !!bpm, bpm: t.bpm, confidence: t.confidence });
  shown = { playing: t.playing, bpm: bpm ? bpm * (state.settings.octave || 1) : null };
  renderStatus();
}, 500);

// ======================= UI =======================
const update = (patch) => ipcRenderer.send('settings:update', patch);
const updateMascot = (id, patch) => {
  const m = state.mascots.find((x) => x.id === id); // keep local copy fresh; list isn't rebuilt for these edits
  if (m) Object.assign(m, patch);
  ipcRenderer.send('mascot:update', id, patch);
};

function renderStatus() {
  $('bpmValue').textContent = shown.bpm ? Math.round(shown.bpm) : '--';
  const dot = $('dot'), txt = $('statusText');
  dot.className = audioError ? 'err' : shown.playing ? 'on' : '';
  txt.textContent = audioError ? 'Audio error' : shown.playing ? 'Playing' : analyser ? 'Silence — mascots paused' : 'No audio';
  txt.title = audioError || '';
}

let lastKey = '';
function render() {
  const s = state.settings;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === s.tempoMode;
  $('manualBpm').disabled = s.tempoMode !== 'manual';
  if (document.activeElement !== $('manualBpm')) $('manualBpm').value = s.manualBpm;
  $('globalSpeed').value = s.globalSpeed; $('globalSpeedOut').textContent = `×${(+s.globalSpeed).toFixed(2)}`;
  $('locked').checked = !!s.locked;
  for (const b of $('octave').children) b.classList.toggle('on', +b.dataset.v === s.octave);
  if ($('audioSource').value !== s.audioSource && !$('audioSource').matches(':focus')) $('audioSource').value = s.audioSource;
  renderStatus();

  // Only rebuild the mascot list when its structure changes, so sliders don't lose focus mid-drag.
  const key = JSON.stringify(state.mascots.map((m) => [m.id, m.enabled, m.missing, m.name]));
  if (key === lastKey) return;
  lastKey = key;
  const list = $('list');
  list.innerHTML = '';
  if (!state.mascots.length) list.innerHTML = '<div style="color:var(--dim);text-align:center">No mascots yet — add some GIFs!</div>';
  for (const m of state.mascots) list.appendChild(mascotCard(m));
}

function mascotCard(m) {
  const el = document.createElement('div');
  el.className = `mascot${m.enabled ? '' : ' off'}${m.missing ? ' missing' : ''}`;
  const src = m.thumb || '';
  el.innerHTML = `
    <img class="thumb" src="${src}">
    <div class="name"></div>
    <div class="btns">
      <button class="toggle ${m.enabled ? 'on' : ''}">${m.enabled ? 'On' : 'Off'}</button>
      <button class="remove" title="Remove from library">✕</button>
    </div>
    <div class="ctl">
      Speed <input class="speed" type="range" min="0.25" max="3" step="0.05" value="${m.speed}">
      <output>×${(+m.speed).toFixed(2)}</output>
      Loop looks right at <input class="base" type="number" min="30" max="300" value="${m.baseBpm}"> BPM
      <label><input class="smart" type="checkbox" ${m.smart !== false ? 'checked' : ''}> ½/2× smart</label>
      <label><input class="flip" type="checkbox" ${m.flip ? 'checked' : ''}> flip</label>
    </div>`;
  el.querySelector('.name').textContent = m.name;
  el.querySelector('.toggle').onclick = () => updateMascot(m.id, { enabled: !m.enabled });
  el.querySelector('.remove').onclick = () => ipcRenderer.send('mascot:remove', m.id);
  const out = el.querySelector('output');
  el.querySelector('.speed').oninput = (e) => { out.textContent = `×${(+e.target.value).toFixed(2)}`; updateMascot(m.id, { speed: +e.target.value }); };
  el.querySelector('.base').onchange = (e) => updateMascot(m.id, { baseBpm: Math.max(30, +e.target.value || 120) });
  el.querySelector('.smart').onchange = (e) => updateMascot(m.id, { smart: e.target.checked });
  el.querySelector('.flip').onchange = (e) => updateMascot(m.id, { flip: e.target.checked });
  return el;
}

async function populateDevices() {
  const sel = $('audioSource');
  sel.innerHTML = '<option value="loopback">System audio (what you hear)</option>';
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    for (const d of devices.filter((d) => d.kind === 'audioinput')) {
      const o = document.createElement('option');
      o.value = d.deviceId; o.textContent = `Input: ${d.label || d.deviceId.slice(0, 8)}`;
      sel.appendChild(o);
    }
  } catch { /* labels need permission; the list still works */ }
  sel.value = state.settings.audioSource || 'loopback';
}

$('audioSource').onchange = (e) => { update({ audioSource: e.target.value }); state.settings.audioSource = e.target.value; startAudio(); };
for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => update({ tempoMode: r.value });
$('manualBpm').onchange = (e) => update({ manualBpm: Math.min(240, Math.max(40, +e.target.value || 120)) });
$('globalSpeed').oninput = (e) => { $('globalSpeedOut').textContent = `×${(+e.target.value).toFixed(2)}`; update({ globalSpeed: +e.target.value }); };
$('locked').onchange = (e) => update({ locked: e.target.checked });
for (const b of $('octave').children) b.onclick = () => update({ octave: +b.dataset.v });
$('add').onclick = () => ipcRenderer.invoke('mascot:pick');
$('reset').onclick = () => ipcRenderer.send('mascot:reset-positions');

// Tap tempo
let taps = [];
$('tap').onclick = () => {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
  taps.push(now);
  taps = taps.slice(-8);
  if (taps.length >= 3) {
    const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
    update({ tempoMode: 'manual', manualBpm: Math.round(60000 / avg) });
  }
};

// Drag & drop
const drop = $('drop');
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const paths = [...e.dataTransfer.files].map((f) => webUtils.getPathForFile(f)).filter((p) => /\.gif$/i.test(p));
  if (paths.length) ipcRenderer.send('mascot:add', paths);
});

ipcRenderer.on('state', (_e, s) => { state = s; render(); });

(async () => {
  state = await ipcRenderer.invoke('state:get');
  render();
  await startAudio();
  await populateDevices();
  navigator.mediaDevices.addEventListener('devicechange', populateDevices);
})();
