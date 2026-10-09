'use strict';
const { ipcRenderer } = require('electron');
const fs = require('fs');
const { parseGIF, decompressFrame } = require('gifuct-js');
const { foldedRate } = require('../shared/tempo');

const view = document.getElementById('view');
const vctx = view.getContext('2d');
const grip = document.getElementById('grip');

let mascot = null, settings = null, tempo = { playing: false, bpm: null };
let frames = [], raw = [], gct = null, cur = 0, acc = 0;
// Decoded RGBA patches are big (frames x w x h x 4), so only cache them when the whole loop is small.
const CACHE_BYTES = 24 * 1024 * 1024;
let patchCache = null;
let targetRate = 0, rate = 0; // rate = playback speed multiplier relative to the gif's own timing

// Compositing state for the gif's frame disposal rules.
const canvas = document.createElement('canvas');
const ctx = canvas.getContext('2d', { willReadFrequently: false });
const patchCanvas = document.createElement('canvas');
const patchCtx = patchCanvas.getContext('2d');
let restore = null;

function load(path) {
  const buf = fs.readFileSync(path);
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  gct = gif.gct;
  raw = gif.frames.filter((f) => f.image);
  // Keep only lightweight metadata per frame; pixels are decoded on demand while playing.
  frames = raw.map((f) => {
    const { dims, disposalType, delay } = decompressFrame(f, gct, false);
    return { dims, disposalType, delay };
  });
  const { width, height } = gif.lsd;
  patchCache = frames.length * width * height * 4 <= CACHE_BYTES ? new Map() : null;
  canvas.width = view.width = width;
  canvas.height = view.height = height;
  ipcRenderer.send('overlay:aspect', width / height, width);
  cur = 0; acc = 0; restore = null;
  drawFrame(0);
}

function getPatch(i) {
  if (patchCache && patchCache.has(i)) return patchCache.get(i);
  const { patch } = decompressFrame(raw[i], gct, true);
  if (patchCache) patchCache.set(i, patch);
  return patch;
}

function drawFrame(i) {
  const f = frames[i], prev = frames[(i - 1 + frames.length) % frames.length];
  if (i === 0) ctx.clearRect(0, 0, canvas.width, canvas.height);
  else if (prev.disposalType === 2) {
    ctx.clearRect(prev.dims.left, prev.dims.top, prev.dims.width, prev.dims.height);
  } else if (prev.disposalType === 3 && restore) ctx.putImageData(restore, 0, 0);
  if (f.disposalType === 3) restore = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { width, height, left, top } = f.dims;
  patchCanvas.width = width; patchCanvas.height = height;
  patchCtx.putImageData(new ImageData(getPatch(i), width, height), 0, 0);
  ctx.drawImage(patchCanvas, left, top);
  vctx.clearRect(0, 0, view.width, view.height);
  vctx.drawImage(canvas, 0, 0);
}

const frameDelay = (f) => (f.delay <= 10 ? 100 : f.delay); // browsers treat 0/10ms delays as 100ms

function computeTargetRate() {
  if (!mascot || !settings || !tempo.playing) return 0;
  const bpm = settings.tempoMode === 'manual' ? settings.manualBpm : tempo.bpm;
  if (!bpm) return 0;
  const r = foldedRate(bpm * settings.octave, mascot.baseBpm || 120, mascot.smart !== false)
    * (mascot.speed || 1) * (settings.globalSpeed || 1);
  return Math.min(6, Math.max(0, r));
}

let last = performance.now();
function tick(now) {
  const dt = Math.min(100, now - last);
  last = now;
  targetRate = computeTargetRate();
  rate += (targetRate - rate) * Math.min(1, dt / 250); // ease so tempo changes glide
  if (targetRate === 0 && rate < 0.01) rate = 0;
  if (frames.length > 1 && rate > 0) {
    acc += dt * rate;
    let advanced = false;
    while (acc >= frameDelay(frames[cur])) {
      acc -= frameDelay(frames[cur]);
      cur = (cur + 1) % frames.length;
      advanced = true;
    }
    if (advanced) drawFrame(cur);
  }
  requestAnimationFrame(tick);
}

function applyMascot() {
  view.classList.toggle('flip', !!mascot.flip);
}
function applySettings() {
  document.body.classList.toggle('locked', !!settings.locked);
}

// ----- interaction: drag to move, grip / wheel to resize, right-click menu -----
function startDrag(e, mode) {
  e.preventDefault();
  e.currentTarget.setPointerCapture(e.pointerId);
  ipcRenderer.send('drag:start', { sx: e.screenX, sy: e.screenY, mode });
}
for (const [el, mode] of [[view, 'move'], [grip, 'resize']]) {
  el.addEventListener('pointerdown', (e) => { if (e.button === 0) { e.stopPropagation(); startDrag(e, mode); } });
  el.addEventListener('pointermove', (e) => {
    if (e.buttons & 1) ipcRenderer.send('drag:move', { sx: e.screenX, sy: e.screenY });
  });
  el.addEventListener('pointerup', () => ipcRenderer.send('drag:end'));
}
window.addEventListener('wheel', (e) => ipcRenderer.send('resize:wheel', e.deltaY), { passive: true });
window.addEventListener('contextmenu', (e) => { e.preventDefault(); ipcRenderer.send('overlay:menu'); });

ipcRenderer.on('mascot', (_e, m) => { mascot = m; applyMascot(); });
ipcRenderer.on('settings', (_e, s) => { settings = s; applySettings(); });
ipcRenderer.on('tempo', (_e, t) => { tempo = t; });

(async () => {
  const init = await ipcRenderer.invoke('overlay:init');
  ({ mascot, settings, tempo } = init);
  applyMascot(); applySettings();
  try { load(mascot.path); } catch (e) { console.error('Could not load gif', e); }
  requestAnimationFrame(tick);
})();
