'use strict';
/**
 * main.js — Electron main process.
 *
 * Responsibilities
 *  - Owns the saved configuration (settings + the mascot library) and writes it to disk.
 *  - Creates one transparent, always-on-top "overlay" window per enabled mascot.
 *  - Creates the control panel window and the system-tray icon.
 *  - Relays messages between the control panel (which analyses the audio) and the overlays
 *    (which animate the GIFs).
 *  - Validates EVERYTHING that arrives over IPC or from the config file (see "Validation").
 *
 * Window layout
 *    control panel  ──tempo──▶  main  ──tempo──▶  overlay windows (one per mascot)
 *         ▲  settings / mascot edits ◀──────────────┘
 */
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage,
  desktopCapturer, session, screen, clipboard,
} = require('electron');
const { watchFullscreen } = require('./fullscreen');

// NOTE: we used to make all windows share ONE renderer process (the 'process-per-site' switch) to
// save memory. On Windows that left mascots added while the app was running with a solid white
// background until the app was restarted, so every window now gets its own process.

// ───────────────────────────── Constants ─────────────────────────────

/** Where settings are saved (e.g. %APPDATA%/dancingmascots/config.json). */
const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');

/** Largest GIF we are willing to load (guards against huge / malicious files). */
const MAX_GIF_BYTES = 100 * 1024 * 1024;

/** Settings every install starts with. Unknown keys in a saved file are ignored. */
const DEFAULT_SETTINGS = {
  audioSource: 'loopback', // 'loopback' = what you hear, otherwise an audio-input deviceId
  tempoMode: 'auto',       // 'auto' = detect from audio, 'manual' = use manualBpm
  manualBpm: 120,
  globalSpeed: 1,          // multiplier applied to every mascot
  octave: 1,               // 0.5 / 1 / 2 — fixes half-time / double-time detection mistakes
  locked: false,           // true = overlays are click-through
  bounce: false,           // squash-and-stretch pulse on every beat
  bounceStrength: 0.5,     // 0..1
  pauseOnFullscreen: true, // pause + hide mascots on a monitor while another app is fullscreen there
  launchAtLogin: false,    // start with Windows (hidden in the tray)
  alwaysOnTop: true,       // true = mascots stay above other windows; false = behave like a normal window
};

// ───────────────────────────── State ─────────────────────────────

let config = { settings: { ...DEFAULT_SETTINGS }, mascots: [] };
let controlWin = null;            // the control panel window
let tray = null;                  // system tray icon
let quitting = false;             // true once the user really chose Quit
let tempo = { playing: false, bpm: null, beat: null, period: null }; // latest from control panel
const overlays = new Map();       // mascot id -> its overlay BrowserWindow
let fullscreenDisplayId = null;   // id of the display a foreign app is fullscreen on (or null)
let fullscreenWatcher = { supported: false };

// ───────────────────────────── Validation helpers ─────────────────────────────
// The renderer windows run with Node integration (they read GIF files directly), so anything
// that could inject code into them is dangerous. We therefore never trust data coming from
// IPC or from config.json: it is copied through these sanitizers, which only keep known keys
// with values of the right type and range.

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Small PNG thumbnails made by the control panel are stored as data: URLs; accept only that shape. */
const THUMB_RE = /^data:image\/png;base64,[A-Za-z0-9+/=]{1,200000}$/;

/** Is this an absolute path to an existing .gif that is not absurdly big? */
function isUsableGif(p) {
  try {
    return typeof p === 'string' && path.isAbsolute(p) && /\.gif$/i.test(p)
      && fs.statSync(p).isFile() && fs.statSync(p).size <= MAX_GIF_BYTES;
  } catch { return false; }
}

/**
 * The size a mascot's window should open at, worked out from the GIF's own header (its width and
 * height are stored in bytes 6-9). Opening the window at its final size matters: resizing a
 * transparent window right after creation can leave it with a solid white background on Windows.
 * @returns {{w:number,h:number}|null} 120–260 px wide, keeping the GIF's proportions
 */
function defaultWindowSize(p) {
  try {
    const fd = fs.openSync(p, 'r');
    const head = Buffer.alloc(10);
    fs.readSync(fd, head, 0, 10, 0);
    fs.closeSync(fd);
    if (head.toString('latin1', 0, 4) !== 'GIF8') return null;
    const gw = head.readUInt16LE(6), gh = head.readUInt16LE(8);
    if (!gw || !gh) return null;
    const w = Math.round(clamp(gw, 120, 260));
    return { w, h: Math.max(40, Math.round(w * gh / gw)) };
  } catch { return null; }
}

/** Keep only valid, in-range settings from `src`. Unknown keys and bad values are dropped. */
function sanitizeSettings(src) {
  const out = {};
  if (!isObj(src)) return out;
  if (typeof src.audioSource === 'string' && src.audioSource.length <= 512) out.audioSource = src.audioSource;
  if (src.tempoMode === 'auto' || src.tempoMode === 'manual') out.tempoMode = src.tempoMode;
  if (isNum(src.manualBpm)) out.manualBpm = clamp(src.manualBpm, 30, 300);
  if (isNum(src.globalSpeed)) out.globalSpeed = clamp(src.globalSpeed, 0.1, 4);
  if ([0.5, 1, 2].includes(src.octave)) out.octave = src.octave;
  if (typeof src.locked === 'boolean') out.locked = src.locked;
  if (typeof src.bounce === 'boolean') out.bounce = src.bounce;
  if (isNum(src.bounceStrength)) out.bounceStrength = clamp(src.bounceStrength, 0, 1);
  if (typeof src.pauseOnFullscreen === 'boolean') out.pauseOnFullscreen = src.pauseOnFullscreen;
  if (typeof src.launchAtLogin === 'boolean') out.launchAtLogin = src.launchAtLogin;
  if (typeof src.alwaysOnTop === 'boolean') out.alwaysOnTop = src.alwaysOnTop;
  return out;
}

/** Same idea for the editable fields of a mascot (id / path are never editable via IPC). */
function sanitizeMascotPatch(src) {
  const out = {};
  if (!isObj(src)) return out;
  if (typeof src.enabled === 'boolean') out.enabled = src.enabled;
  if (typeof src.flip === 'boolean') out.flip = src.flip;
  if (typeof src.smart === 'boolean') out.smart = src.smart;
  if (isNum(src.speed)) out.speed = clamp(src.speed, 0.1, 4);
  if (isNum(src.baseBpm)) out.baseBpm = clamp(src.baseBpm, 30, 300);
  if (typeof src.thumb === 'string' && THUMB_RE.test(src.thumb)) out.thumb = src.thumb;
  return out;
}

/** Rebuild a full, trustworthy mascot record from untrusted data (used when loading config.json). */
function sanitizeMascot(src) {
  if (!isObj(src) || typeof src.id !== 'string' || !/^[a-z0-9]{1,32}$/i.test(src.id)) return null;
  if (typeof src.path !== 'string' || !path.isAbsolute(src.path) || !/\.gif$/i.test(src.path)) return null;
  return {
    id: src.id,
    name: typeof src.name === 'string' ? src.name.slice(0, 100) : path.basename(src.path, '.gif'),
    path: src.path,
    enabled: src.enabled !== false,
    x: isNum(src.x) ? Math.round(src.x) : 120,
    y: isNum(src.y) ? Math.round(src.y) : 160,
    w: isNum(src.w) ? clamp(Math.round(src.w), 0, 4000) : 0, // 0 = "pick a size on first load"
    h: isNum(src.h) ? clamp(Math.round(src.h), 0, 4000) : 0,
    baseBpm: 120, speed: 1, smart: false, flip: false,
    ...sanitizeMascotPatch(src),
  };
}

// ───────────────────────────── Persistence ─────────────────────────────

/** Read config.json (first run: file is missing, defaults are used). */
function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    config = {
      settings: { ...DEFAULT_SETTINGS, ...sanitizeSettings(saved.settings) },
      mascots: (Array.isArray(saved.mascots) ? saved.mascots : []).map(sanitizeMascot).filter(Boolean),
    };
  } catch { /* first run or unreadable file: keep defaults */ }
}

let saveTimer = null;
/** Write config.json shortly after the last change (debounced so dragging doesn't hammer the disk). */
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
  }, 200);
}

const findMascot = (id) => config.mascots.find((m) => m.id === id);

/** The state snapshot sent to the control panel (adds a "file is missing" flag). */
function publicState() {
  return {
    settings: config.settings,
    fullscreenSupported: !!fullscreenWatcher.supported,
    mascots: config.mascots.map((m) => ({ ...m, missing: !fs.existsSync(m.path) })),
  };
}

/** Tell the control panel + tray that something changed. */
function pushState() {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('state', publicState());
  updateTrayMenu();
}

// ───────────────────────────── Overlay windows ─────────────────────────────

/** Create the transparent always-on-top window for one mascot (no-op if already open). */
function openOverlay(m) {
  if (overlays.has(m.id) || !isUsableGif(m.path)) return;
  if (!m.w || !m.h) { // never sized yet: open at the right size straight away (no resize later)
    const size = defaultWindowSize(m.path);
    if (size) { m.w = size.w; m.h = size.h; saveConfig(); }
  }

  const win = new BrowserWindow({
    x: m.x, y: m.y,
    width: Math.max(60, m.w || 220), height: Math.max(60, m.h || 220),
    minWidth: 40, minHeight: 40,
    transparent: true, frame: false, hasShadow: false, backgroundColor: '#00000000',
    resizable: false,          // we implement resizing ourselves (see drag:* handlers)
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,   // overlay.js reads the GIF from disk. Only OUR local pages are ever loaded.
      contextIsolation: false,
      backgroundThrottling: false,                 // keep animating when nothing is focused
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  lockDownNavigation(win);
  applyStacking(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(config.settings.locked); // click-through when locked
  win.loadFile(path.join(__dirname, '../renderer/overlay.html'));
  win.on('closed', () => { overlays.delete(m.id); updateActivity(); });
  overlays.set(m.id, win);
  ensureOnScreen(win, m.id);
  applyFullscreen();
}

/**
 * "Always on top" on: the mascot floats above every other window (the high 'screen-saver' level).
 * Off: it is an ordinary window, so other windows can cover it (clicking it brings it forward).
 */
function applyStacking(win) {
  if (config.settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  else win.setAlwaysOnTop(false);
}

function closeOverlay(id) {
  const win = overlays.get(id);
  if (win && !win.isDestroyed()) win.close();
  overlays.delete(id);
  updateActivity();
}

// ───────────────────────────── Multi-monitor + fullscreen handling ─────────────────────────────

/** Is this overlay window at least partly (40×40 px) on some connected display? */
function isOnAnyDisplay(b) {
  return screen.getAllDisplays().some((d) => {
    const w = Math.min(b.x + b.width, d.bounds.x + d.bounds.width) - Math.max(b.x, d.bounds.x);
    const h = Math.min(b.y + b.height, d.bounds.y + d.bounds.height) - Math.max(b.y, d.bounds.y);
    return w >= 40 && h >= 40;
  });
}

/** Move a window onto `display` (top-left area of its work area, i.e. clear of the taskbar). */
function moveToDisplay(win, display, id) {
  const wa = display.workArea, b = win.getBounds();
  win.setBounds({ x: wa.x + 80, y: wa.y + 80, width: b.width, height: b.height });
  if (id) saveBounds(id);
  applyFullscreen();
}

/** If a monitor was unplugged (or the layout changed) and a mascot is stranded off-screen, bring it back. */
function ensureOnScreen(win, id) {
  if (!win.isDestroyed() && !isOnAnyDisplay(win.getBounds())) moveToDisplay(win, screen.getPrimaryDisplay(), id);
}

/**
 * Pause + hide the mascots that sit on a monitor where another app is fullscreen
 * (only if the "pause on fullscreen" option is on). Mascots on other monitors keep dancing.
 */
function isPausedByFullscreen(win) {
  return config.settings.pauseOnFullscreen && fullscreenDisplayId !== null
    && screen.getDisplayMatching(win.getBounds()).id === fullscreenDisplayId;
}

function applyFullscreen() {
  for (const win of overlays.values()) {
    if (win.isDestroyed()) continue;
    const paused = isPausedByFullscreen(win);
    if (paused && win.isVisible()) win.hide();
    if (!paused && !win.isVisible()) win.showInactive();
    win.webContents.send('paused', paused); // lets the overlay stop its animation loop to save CPU
  }
  updateActivity();
}

/**
 * Tell the control panel whether anyone is watching. With no visible mascots there is no point
 * analysing the audio, so the panel drops to a very cheap idle mode.
 */
function updateActivity() {
  const needed = [...overlays.values()].some((w) => !w.isDestroyed() && w.isVisible());
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('activity', needed);
}

/** Send a message to every open overlay. */
function broadcast(channel, payload) {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Remember an overlay's current position and size. */
function saveBounds(id) {
  const win = overlays.get(id), m = findMascot(id);
  if (!win || !m || win.isDestroyed()) return;
  const b = win.getBounds();
  Object.assign(m, { x: b.x, y: b.y, w: b.width, h: b.height });
  saveConfig();
}

/** Which mascot does this IPC message come from? (null if the sender isn't an overlay.) */
function overlayIdOf(sender) {
  for (const [id, win] of overlays) if (!win.isDestroyed() && win.webContents === sender) return id;
  return null;
}

/**
 * Stop a window from ever navigating away from our local pages or opening new windows.
 * Because these windows have Node integration, loading anything remote would be dangerous.
 */
function lockDownNavigation(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}

/** Add GIF files to the library (and show them). Silently skips anything invalid. */
function addMascots(paths) {
  if (!Array.isArray(paths)) return;
  for (const p of paths.slice(0, 100)) {
    if (!isUsableGif(p)) continue;
    const existing = config.mascots.find((m) => m.path === p);
    if (existing) { existing.enabled = true; openOverlay(existing); continue; }

    const n = config.mascots.length; // stagger start positions so new mascots don't stack exactly
    const m = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: path.basename(p, path.extname(p)),
      path: p, enabled: true,
      x: 120 + (n % 6) * 90, y: 160 + (n % 4) * 60,
      w: 0, h: 0, // filled in from the GIF's header when the window opens (see openOverlay)
      baseBpm: 120, speed: 1, smart: false, flip: false,
    };
    config.mascots.push(m);
    openOverlay(m);
  }
  saveConfig();
  pushState();
}

// ───────────────────────────── IPC: control panel → main ─────────────────────────────

ipcMain.handle('state:get', () => publicState());

// "+ Add GIFs" button: show a file picker.
ipcMain.handle('mascot:pick', async () => {
  const r = await dialog.showOpenDialog(controlWin, {
    title: 'Add dancing GIFs', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GIF', extensions: ['gif'] }],
  });
  if (!r.canceled) addMascots(r.filePaths);
});

// Drag & drop onto the panel.
ipcMain.on('mascot:add', (_e, paths) => addMascots(paths));

// Edit one mascot (speed, flip, enabled, ...). Also used by the tray menu.
ipcMain.on('mascot:update', (_e, id, rawPatch) => {
  const m = findMascot(id);
  if (!m) return;
  const { enabled, ...patch } = sanitizeMascotPatch(rawPatch);
  Object.assign(m, patch);

  if (enabled !== undefined) { // On/Off toggle = load/unload the overlay
    m.enabled = enabled;
    enabled ? openOverlay(m) : closeOverlay(id);
  }
  const win = overlays.get(id);
  if (win && !win.isDestroyed()) win.webContents.send('mascot', m);
  saveConfig();
  if (enabled !== undefined) pushState(); // list structure changed, so refresh the panel/tray
});

ipcMain.on('mascot:remove', (_e, id) => {
  closeOverlay(id);
  config.mascots = config.mascots.filter((m) => m.id !== id);
  saveConfig();
  pushState();
});

// "Reset positions": line everything up at the default spots on the main monitor.
ipcMain.on('mascot:reset-positions', () => { // everything back onto the primary monitor
  config.mascots.forEach((m, i) => {
    const win = overlays.get(m.id);
    const wa = screen.getPrimaryDisplay().workArea;
    const x = wa.x + 120 + (i % 6) * 90, y = wa.y + 160 + (i % 4) * 60;
    if (win && !win.isDestroyed()) { win.setPosition(x, y); saveBounds(m.id); } else Object.assign(m, { x, y });
    saveConfig();
  });
});

// Global settings (also used by the tray menu and the overlay right-click menu).
ipcMain.on('settings:update', (_e, rawPatch) => {
  const patch = sanitizeSettings(rawPatch);
  Object.assign(config.settings, patch);
  if ('locked' in patch) for (const w of overlays.values()) w.setIgnoreMouseEvents(config.settings.locked);
  if ('alwaysOnTop' in patch) for (const w of overlays.values()) if (!w.isDestroyed()) applyStacking(w);
  if ('pauseOnFullscreen' in patch) applyFullscreen();
  if ('launchAtLogin' in patch) applyLoginItem();
  broadcast('settings', config.settings);
  saveConfig();
  pushState();
});

// Latest tempo from the control panel's audio analysis → forwarded to all overlays.
ipcMain.on('tempo', (_e, t) => {
  if (!isObj(t)) return;
  tempo = {
    playing: t.playing === true,
    bpm: isNum(t.bpm) ? clamp(t.bpm, 30, 300) : null,
    beat: isNum(t.beat) ? t.beat : null,                       // epoch ms of a beat
    period: isNum(t.period) ? clamp(t.period, 0.2, 2) : null,  // seconds per beat
  };
  broadcast('tempo', tempo);
});

// ───────────────────────────── IPC: overlay → main ─────────────────────────────

// An overlay asks for its starting data.
ipcMain.handle('overlay:init', (e) => {
  const id = overlayIdOf(e.sender), m = findMascot(id);
  return m ? { mascot: m, settings: config.settings, tempo, paused: isPausedByFullscreen(overlays.get(id)) } : null;
});

// The overlay tells us the GIF's aspect ratio once it has decoded it. The window normally already
// has the right proportions (see defaultWindowSize), so this only steps in if they are wrong; resizing
// a transparent window is avoided whenever possible.
ipcMain.on('overlay:aspect', (e, aspect, naturalW) => {
  if (!isNum(aspect) || aspect <= 0 || !isNum(naturalW)) return;
  const id = overlayIdOf(e.sender), m = findMascot(id), win = overlays.get(id);
  if (!m || !win) return;
  const b = win.getBounds();
  const height = Math.round(b.width / aspect);
  if (Math.abs(height - b.height) > 1) {
    win.setBounds({ x: b.x, y: b.y, width: b.width, height });
    saveBounds(id);
  }
});

// Moving / resizing. The overlay window is frameless, so the page reports pointer positions
// (in screen coordinates) and we move/resize the window ourselves.
let drag = null; // { id, win, b: bounds at drag start, sx/sy: pointer at start, mode, aspect }

ipcMain.on('drag:start', (e, { sx, sy, mode } = {}) => {
  const id = overlayIdOf(e.sender);
  if (!id || !isNum(sx) || !isNum(sy) || (mode !== 'move' && mode !== 'resize')) return;
  const win = overlays.get(id), b = win.getBounds();
  drag = { id, win, b, sx, sy, mode, aspect: b.width / b.height };
});

ipcMain.on('drag:move', (_e, { sx, sy } = {}) => {
  if (!drag || drag.win.isDestroyed() || !isNum(sx) || !isNum(sy)) return;
  const { b } = drag, dx = sx - drag.sx, dy = sy - drag.sy;
  if (drag.mode === 'move') {
    const x = Math.round(b.x + dx), y = Math.round(b.y + dy);
    drag.win.setBounds({ x, y, width: b.width, height: b.height });
    // Windows can resize a window when it crosses between monitors with different display
    // scaling. If that happened, put the size back.
    const now = drag.win.getBounds();
    if (now.width !== b.width || now.height !== b.height) drag.win.setBounds({ x, y, width: b.width, height: b.height });
  } else { // resize from the bottom-right grip, keeping the GIF's proportions
    const width = clamp(Math.round(b.width + Math.max(dx, dy * drag.aspect)), 50, 1600);
    drag.win.setBounds({ x: b.x, y: b.y, width, height: Math.round(width / drag.aspect) });
  }
});

ipcMain.on('drag:end', () => {
  if (drag) { saveBounds(drag.id); applyFullscreen(); } // it may now sit on a different monitor
  drag = null;
});

// Mouse wheel over a mascot: resize around its centre.
ipcMain.on('resize:wheel', (e, deltaY) => {
  if (!isNum(deltaY)) return;
  const id = overlayIdOf(e.sender), win = overlays.get(id);
  if (!win) return;
  const b = win.getBounds(), aspect = b.width / b.height;
  const width = clamp(Math.round(b.width * Math.exp(-deltaY * 0.001)), 50, 1600);
  const height = Math.round(width / aspect);
  win.setBounds({
    x: Math.round(b.x + (b.width - width) / 2), y: Math.round(b.y + (b.height - height) / 2), width, height,
  });
  saveBounds(id);
});

// Right-click menu on a mascot.
ipcMain.on('overlay:menu', (e) => {
  const id = overlayIdOf(e.sender), m = findMascot(id);
  if (!m) return;
  /** Apply a change, tell the overlay, and refresh the panel. */
  const set = (patch) => { Object.assign(m, patch); e.sender.send('mascot', m); saveConfig(); pushState(); };
  Menu.buildFromTemplate([
    { label: m.name, enabled: false },
    { type: 'separator' },
    { label: 'Flip horizontally', type: 'checkbox', checked: !!m.flip, click: () => set({ flip: !m.flip }) },
    { label: 'Speed ×1', click: () => set({ speed: 1 }) },
    { label: 'Speed ×0.5', click: () => set({ speed: 0.5 }) },
    { label: 'Speed ×2', click: () => set({ speed: 2 }) },
    ...(screen.getAllDisplays().length > 1 ? [{
      label: 'Move to monitor',
      submenu: screen.getAllDisplays().map((d, i) => ({
        label: `Monitor ${i + 1}${d.id === screen.getPrimaryDisplay().id ? ' (main)' : ''} — ${d.size.width}×${d.size.height}`,
        click: () => moveToDisplay(overlays.get(id), d, id),
      })),
    }] : []),
    { type: 'separator' },
    { label: 'Lock all (click-through)', click: () => ipcMain.emit('settings:update', null, { locked: true }) },
    { label: 'Unload', click: () => ipcMain.emit('mascot:update', null, id, { enabled: false }) },
  ]).popup();
});

// ───────────────────────────── Control panel + tray ─────────────────────────────

function createControl() {
  controlWin = new BrowserWindow({
    width: 480, height: 900, minWidth: 400, title: 'Dancing Mascots',
    show: !process.argv.includes('--hidden'), // "launch at login" starts hidden in the tray
    backgroundColor: '#14141a', autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      nodeIntegration: true,   // control.js reads GIFs for thumbnails; only our local page is loaded
      contextIsolation: false,
      backgroundThrottling: false, // this window does the audio analysis, so it must keep running when hidden
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  lockDownNavigation(controlWin);
  controlWin.loadFile(path.join(__dirname, '../renderer/control.html'));
  controlWin.webContents.on('did-finish-load', updateActivity);

  // Minimize and close both just hide the window to the tray; the app keeps running.
  controlWin.on('minimize', (e) => { e.preventDefault(); controlWin.hide(); });
  controlWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); controlWin.hide(); }
  });
}

function showControl() { controlWin.show(); controlWin.focus(); }

/** (Re)build the tray right-click menu so it reflects the current mascots and lock state. */
function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open control panel', click: showControl },
    { label: 'Lock overlays (click-through)', type: 'checkbox', checked: config.settings.locked,
      click: (item) => ipcMain.emit('settings:update', null, { locked: item.checked }) },
    { type: 'separator' },
    ...config.mascots.map((m) => ({
      label: m.name, type: 'checkbox', checked: m.enabled,
      click: (item) => ipcMain.emit('mascot:update', null, m.id, { enabled: item.checked }),
    })),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

// ───────────────────────────── Support tools ─────────────────────────────

/** One line per open mascot window: what the GIF looks like to the app, and how its window is set up. */
async function describeOverlays() {
  const lines = [];
  for (const [id, win] of overlays) {
    if (win.isDestroyed()) continue;
    let info = {};
    try {
      info = await Promise.race([
        win.webContents.executeJavaScript('window.__gifInfo && window.__gifInfo()'),
        new Promise((resolve) => setTimeout(() => resolve({ error: 'no answer' }), 3000)),
      ]) || {};
    } catch (e) { info = { error: e.message }; }
    const b = win.getBounds();
    lines.push(`  - ${JSON.stringify({ ...info, window: `${b.width}x${b.height}`, visible: win.isVisible(), background: win.getBackgroundColor(), id })}`);
  }
  return lines.length ? lines : ['  (no mascots open)'];
}

/** A plain-text summary of the system, to paste into a bug report. Contains no personal data. */
async function buildDiagnostics() {
  let gpu = {};
  try { gpu = await app.getGPUInfo('basic'); } catch { /* not available */ }
  const devices = (gpu.gpuDevice || []).map((d) => `  - vendor ${d.vendorId} device ${d.deviceId} driver ${d.driverVersion || '?'}${d.active ? ' (active)' : ''}`);
  const displays = screen.getAllDisplays().map((d, i) =>
    `  - #${i + 1}${d.id === screen.getPrimaryDisplay().id ? ' (main)' : ''}: ${d.size.width}x${d.size.height} at ${d.bounds.x},${d.bounds.y}, `
    + `scale ${d.scaleFactor}, depth ${d.colorDepth}, colorSpace "${d.colorSpace}"`);
  return [
    `Dancing Mascots ${app.getVersion()}${process.env.PORTABLE_EXECUTABLE_FILE ? ' (portable)' : ''}`,
    `Windows ${process.getSystemVersion()} ${process.arch}`,
    `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
    `GPU feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`,
    'GPU devices:', ...(devices.length ? devices : ['  (none reported)']),
    'Displays:', ...displays,
    'GIFs:', ...await describeOverlays(),
    `Mascots: ${config.mascots.length} (${[...overlays.values()].length} open)`,
    `Settings: ${JSON.stringify(config.settings)}`,
  ].join('\n');
}

// "Copy diagnostics" button.
ipcMain.handle('diagnostics', async () => {
  const text = await buildDiagnostics();
  clipboard.writeText(text);
  return text;
});

// ───────────────────────────── Launch at login ─────────────────────────────

/** Register / unregister with Windows startup. Only for the packaged app (not `npm start`). */
function applyLoginItem() {
  if (!app.isPackaged) return;
  app.setLoginItemSettings({
    openAtLogin: config.settings.launchAtLogin,
    // The portable build runs from a temp folder; PORTABLE_EXECUTABLE_FILE is the real .exe.
    path: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath,
    args: ['--hidden'],
  });
}

// ───────────────────────────── App lifecycle ─────────────────────────────

// Only one copy at a time: launching again just reopens the panel.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (controlWin) showControl(); });

  app.whenReady().then(() => {
    loadConfig();

    // Permissions: the only thing our pages ever need is microphone/line-in style audio capture.
    // Everything else (camera, geolocation, notifications, ...) is refused.
    const allow = (permission) => permission === 'media';
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allow(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allow(permission));

    // System-audio capture: the control panel calls getDisplayMedia(); we answer with a
    // loopback of the default output device (Windows WASAPI loopback = "what you hear").
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        callback({ video: sources[0], audio: 'loopback' });
      } catch (e) {
        console.error('loopback capture failed', e);
        callback({}); // the panel shows an "Audio error" status
      }
    }, { useSystemPicker: false });

    createControl();

    // React to monitors being plugged / unplugged / rearranged, and to other apps going fullscreen.
    const onDisplaysChanged = () => { overlays.forEach((w, id) => ensureOnScreen(w, id)); applyFullscreen(); };
    screen.on('display-added', onDisplaysChanged);
    screen.on('display-removed', onDisplaysChanged);
    screen.on('display-metrics-changed', onDisplaysChanged);
    fullscreenWatcher = watchFullscreen({
      screen,
      onChange: (id) => { fullscreenDisplayId = id; applyFullscreen(); },
    });
    applyLoginItem();

    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, '../../assets/tray.png')).resize({ width: 16, height: 16 }));
    tray.setToolTip('Dancing Mascots');
    tray.on('click', showControl);
    updateTrayMenu();

    config.mascots.filter((m) => m.enabled).forEach(openOverlay); // restore last session
  });

  app.on('before-quit', () => { quitting = true; });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
}
