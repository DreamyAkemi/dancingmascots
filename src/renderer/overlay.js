'use strict';
/**
 * overlay.js — runs inside each mascot's transparent window.
 *
 * Job: play one GIF, with the playback speed driven by the music tempo, and (optionally)
 * pulse on every beat. Also handles dragging, resizing and the right-click menu.
 *
 * Why not just use an <img>? A browser plays GIFs at a fixed speed. To change the speed we
 * decode the GIF ourselves (gifuct-js) and draw the frames onto a <canvas> on our own clock.
 */
const { ipcRenderer } = require('electron');
const fs = require('fs');
const { parseGIF, decompressFrame } = require('gifuct-js');
const { foldedRate } = require('../shared/tempo');
const { createCompositor } = require('../shared/gifcomposite');

// ───────────────────────────── Limits (protect against huge / hostile GIFs) ─────────────────────────────
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_DIMENSION = 4096;   // px, width or height
const MAX_FRAMES = 3000;
const CACHE_BYTES = 24 * 1024 * 1024; // decoded frames are cached only if the whole GIF fits in this

// ───────────────────────────── DOM + state ─────────────────────────────
const view = document.getElementById('view');        // the visible canvas
const vctx = view.getContext('2d');
const grip = document.getElementById('grip');        // bottom-right resize handle
const bounceEl = document.getElementById('bounce');  // wrapper we scale for the beat effect

let mascot = null;                              // this mascot's record from the main process
let settings = null;                            // global settings
let tempo = { playing: false, bpm: null, beat: null, period: null }; // latest from the audio analysis

// GIF data. `frames` holds only light metadata; pixels are decoded on demand (saves a lot of RAM).
let frames = [];        // [{ dims, disposalType, delay }]
let raw = [];           // parsed-but-still-compressed frames
let gct = null;         // GIF global colour table
let patchCache = null;  // Map(frameIndex -> pixels) when the GIF is small enough to cache
let cur = 0;            // index of the frame currently shown
let acc = 0;            // milliseconds accumulated towards the next frame

// When another app is fullscreen on this monitor the main process hides us and sets `paused`,
// which stops the animation loop entirely (zero CPU) until it is cleared.
let paused = false;
let looping = false; // is the requestAnimationFrame loop currently running?

// Playback speed multiplier (1 = the GIF's own timing). `rate` chases `targetRate` smoothly.
let rate = 0;

// The picture is composed in plain memory (see gifcomposite.js) and copied to the visible canvas
// with a single putImageData per frame. No canvas-to-canvas blending, so it looks the same on every PC.
let compositor = null; // current GIF's frame composer
let imageData = null;  // ImageData view over the compositor's pixel buffer

// ───────────────────────────── Loading + decoding ─────────────────────────────

/** Read and parse the GIF, set up the canvases, and draw the first frame. */
function load(path) {
  if (fs.statSync(path).size > MAX_FILE_BYTES) throw new Error('GIF file is too large');
  const buf = fs.readFileSync(path);
  const gif = parseGIF(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  const { width, height } = gif.lsd;
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('GIF dimensions are not supported');

  gct = gif.gct;
  raw = gif.frames.filter((f) => f.image);
  if (!raw.length || raw.length > MAX_FRAMES) throw new Error('GIF has an unsupported number of frames');

  // One pass to collect per-frame metadata; the decoded pixels are thrown away straight away.
  frames = raw.map((f) => {
    const { dims, disposalType, delay } = decompressFrame(f, gct, false);
    return { dims, disposalType, delay };
  });

  patchCache = frames.length * width * height * 4 <= CACHE_BYTES ? new Map() : null;
  view.width = width;
  view.height = height;
  compositor = createCompositor(width, height);
  imageData = new ImageData(compositor.pixels, width, height);
  cur = 0; acc = 0;

  ipcRenderer.send('overlay:aspect', width / height, width); // lets the main process size the window
  composeFrame(0);
  showPicture();
}

/** Pixels (RGBA) of frame i, decoded on demand and cached when affordable. */
function getPatch(i) {
  if (patchCache && patchCache.has(i)) return patchCache.get(i);
  const { patch } = decompressFrame(raw[i], gct, true);
  if (patchCache) patchCache.set(i, patch);
  return patch;
}

/**
 * Apply frame i to the composed picture (honouring GIF disposal rules). Frames must be applied
 * in order, one by one, because most GIFs store each frame as a small change on top of the last
 * one. "Previous" is the frame before (the first frame of a loop starts from a blank picture).
 */
function composeFrame(i) {
  compositor.draw(i === 0 ? null : frames[i - 1], frames[i], getPatch(i));
}

/** Copy the composed picture to the screen. putImageData replaces every pixel, transparent ones too. */
function showPicture() {
  vctx.putImageData(imageData, 0, 0);
}

/** A frame's display time in ms. Browsers treat 0/10 ms delays as 100 ms; so do we. */
const frameDelay = (f) => (f.delay <= 10 ? 100 : f.delay);

// ───────────────────────────── Speed + beat logic ─────────────────────────────

/** The speed this mascot *should* have right now (0 = paused). */
function computeTargetRate() {
  if (!mascot || !settings || !tempo.playing) return 0;               // silence → freeze
  const bpm = settings.tempoMode === 'manual' ? settings.manualBpm : tempo.bpm;
  // No tempo known yet (e.g. a beatless intro): dance at the GIF's natural speed until one is found.
  const tempoRate = bpm ? foldedRate(bpm * settings.octave, mascot.baseBpm || 120, mascot.smart === true) : 1;
  const r = tempoRate * (mascot.speed || 1) * (settings.globalSpeed || 1);
  return Math.min(6, Math.max(0, r));
}

/**
 * Beat pulse in 0..1: jumps to 1 right on the beat and decays quickly (0 between beats).
 * Uses the beat grid from the audio analysis; in manual mode there is no audio sync,
 * so we just pulse at the manual tempo.
 */
function beatPulse() {
  const octave = settings.octave || 1;
  let beatAt, period;
  if (settings.tempoMode === 'manual') {
    beatAt = 0; period = 60 / settings.manualBpm / octave;
  } else {
    if (tempo.beat === null || tempo.period === null) return 0;
    beatAt = tempo.beat; period = tempo.period / octave;
  }
  const since = (Date.now() - beatAt) / 1000;             // seconds since a known beat
  const phase = (((since % period) + period) % period) / period; // 0 at the beat → 1 just before the next
  return Math.exp(-phase * 7);
}

// ───────────────────────────── Main animation loop ─────────────────────────────
let last = performance.now();

function tick(now) {
  if (paused) { looping = false; return; } // stop the loop; setPaused(false) restarts it
  const dt = Math.min(100, now - last); // cap so a long stall doesn't make the GIF skip ahead
  last = now;

  // Ease the speed so tempo changes glide instead of snapping.
  const targetRate = computeTargetRate();
  rate += (targetRate - rate) * Math.min(1, dt / 250);
  if (targetRate === 0 && rate < 0.01) rate = 0;

  // Advance frames according to elapsed time × speed.
  if (frames.length > 1 && rate > 0) {
    acc += dt * rate;
    let advanced = false;
    while (acc >= frameDelay(frames[cur])) {
      acc -= frameDelay(frames[cur]);
      cur = (cur + 1) % frames.length;
      composeFrame(cur); // every frame in turn, even if several are due at once (they build on each other)
      advanced = true;
    }
    if (advanced) showPicture();
  }

  // Optional beat bounce: rest slightly squashed, snap to full height on each beat.
  if (settings && settings.bounce && tempo.playing) {
    const squash = 0.2 * settings.bounceStrength;
    bounceEl.style.transform = `scale(${1 - 0.3 * squash * (1 - beatPulse())}, ${1 - squash * (1 - beatPulse())})`;
  } else {
    bounceEl.style.transform = '';
  }

  requestAnimationFrame(tick);
}

/** Start the loop if it isn't already running. */
function startLoop() {
  if (looping) return;
  looping = true;
  last = performance.now(); // avoid one giant time step after a pause
  requestAnimationFrame(tick);
}

// ───────────────────────────── Applying settings ─────────────────────────────
function applyMascot() { view.classList.toggle('flip', !!mascot.flip); }
function applySettings() { document.body.classList.toggle('locked', !!settings.locked); }

// ───────────────────────────── Interaction ─────────────────────────────
// The window is frameless, so we report pointer movement to the main process, which moves/resizes
// the window. setPointerCapture keeps events flowing even if the pointer leaves the (small) window.
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

// Updates pushed from the main process.
ipcRenderer.on('mascot', (_e, m) => { mascot = m; applyMascot(); });
ipcRenderer.on('settings', (_e, s) => { settings = s; applySettings(); });
ipcRenderer.on('tempo', (_e, t) => { tempo = t; });
ipcRenderer.on('paused', (_e, p) => { paused = p; if (!paused) startLoop(); });

// ───────────────────────────── Startup ─────────────────────────────
(async () => {
  const init = await ipcRenderer.invoke('overlay:init');
  if (!init) return; // not a known mascot window
  ({ mascot, settings, tempo, paused } = init);
  applyMascot(); applySettings();
  try { load(mascot.path); } catch (e) { console.error('Could not load gif:', e.message); }
  if (!paused) startLoop();
})();
