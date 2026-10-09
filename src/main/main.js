'use strict';
const path = require('path');
const fs = require('fs');
const {
  app, BrowserWindow, ipcMain, dialog, Menu, Tray, nativeImage,
  desktopCapturer, session,
} = require('electron');

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULT_SETTINGS = {
  audioSource: 'loopback', // 'loopback' or an audio input deviceId
  tempoMode: 'auto',       // 'auto' | 'manual'
  manualBpm: 120,
  globalSpeed: 1,
  octave: 1,               // 0.5 / 1 / 2 correction for wrong half/double-time detection
  locked: false,           // click-through overlays
};

let config = { settings: { ...DEFAULT_SETTINGS }, mascots: [] };
let controlWin = null;
let tray = null;
let quitting = false;
let tempo = { playing: false, bpm: null, confidence: 0 };
const overlays = new Map(); // mascot id -> BrowserWindow

// ---------- persistence ----------
function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE(), 'utf8'));
    config = {
      settings: { ...DEFAULT_SETTINGS, ...saved.settings },
      mascots: Array.isArray(saved.mascots) ? saved.mascots : [],
    };
  } catch { /* first run */ }
}
let saveTimer = null;
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(CONFIG_FILE(), JSON.stringify(config, null, 2)); } catch (e) { console.error(e); }
  }, 200);
}
const find = (id) => config.mascots.find((m) => m.id === id);
const thumbs = new Map(); // mascot id -> small static data URL
function thumbOf(m) {
  if (!thumbs.has(m.id)) {
    const img = nativeImage.createFromPath(m.path);
    thumbs.set(m.id, img.isEmpty() ? '' : img.resize({ height: 64 }).toDataURL());
  }
  return thumbs.get(m.id);
}
function publicState() {
  return {
    settings: config.settings,
    mascots: config.mascots.map((m) => ({ ...m, missing: !fs.existsSync(m.path), thumb: thumbOf(m) })),
  };
}
function pushState() {
  if (controlWin && !controlWin.isDestroyed()) controlWin.webContents.send('state', publicState());
  updateTrayMenu();
}

// ---------- overlay windows ----------
function openOverlay(m) {
  if (overlays.has(m.id) || !fs.existsSync(m.path)) return;
  const w = Math.max(60, m.w || 220), h = Math.max(60, m.h || 220);
  const win = new BrowserWindow({
    x: m.x, y: m.y, width: w, height: h,
    transparent: true, frame: false, hasShadow: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, minWidth: 40, minHeight: 40,
    backgroundColor: '#00000000',
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(config.settings.locked);
  win.loadFile(path.join(__dirname, '../renderer/overlay.html'), { query: { id: m.id } });
  win.on('closed', () => overlays.delete(m.id));
  overlays.set(m.id, win);
}
function closeOverlay(id) {
  const win = overlays.get(id);
  if (win && !win.isDestroyed()) win.close();
  overlays.delete(id);
}
function broadcast(channel, payload) {
  for (const win of overlays.values()) if (!win.isDestroyed()) win.webContents.send(channel, payload);
}
function saveBounds(id) {
  const win = overlays.get(id), m = find(id);
  if (!win || !m || win.isDestroyed()) return;
  const b = win.getBounds();
  Object.assign(m, { x: b.x, y: b.y, w: b.width, h: b.height });
  saveConfig();
}
function idOf(sender) {
  for (const [id, win] of overlays) if (!win.isDestroyed() && win.webContents === sender) return id;
  return null;
}

function addMascots(paths) {
  for (const p of paths) {
    if (!/\.gif$/i.test(p)) continue;
    const existing = config.mascots.find((m) => m.path === p);
    if (existing) { existing.enabled = true; openOverlay(existing); continue; }
    const n = config.mascots.length;
    const m = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: path.basename(p, path.extname(p)),
      path: p, enabled: true,
      x: 120 + (n % 6) * 90, y: 160 + (n % 4) * 60, w: 0, h: 0,
      baseBpm: 120, speed: 1, smart: true, flip: false,
    };
    config.mascots.push(m);
    openOverlay(m);
  }
  saveConfig();
  pushState();
}

// ---------- IPC: control panel ----------
ipcMain.handle('state:get', () => publicState());
ipcMain.handle('mascot:pick', async () => {
  const r = await dialog.showOpenDialog(controlWin, {
    title: 'Add dancing GIFs', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'GIF', extensions: ['gif'] }],
  });
  if (!r.canceled) addMascots(r.filePaths);
});
ipcMain.on('mascot:add', (_e, paths) => addMascots(paths));
ipcMain.on('mascot:update', (_e, id, patch) => {
  const m = find(id);
  if (!m) return;
  const { enabled, ...rest } = patch;
  Object.assign(m, rest);
  if (enabled !== undefined) {
    m.enabled = enabled;
    enabled ? openOverlay(m) : closeOverlay(id);
  }
  const win = overlays.get(id);
  if (win && !win.isDestroyed()) win.webContents.send('mascot', m);
  saveConfig();
  if (enabled !== undefined) pushState();
});
ipcMain.on('mascot:remove', (_e, id) => {
  closeOverlay(id);
  config.mascots = config.mascots.filter((m) => m.id !== id);
  saveConfig();
  pushState();
});
ipcMain.on('mascot:reset-positions', () => {
  config.mascots.forEach((m, i) => {
    const win = overlays.get(m.id);
    if (win && !win.isDestroyed()) win.setPosition(120 + (i % 6) * 90, 160 + (i % 4) * 60);
    saveBounds(m.id);
  });
});
ipcMain.on('settings:update', (_e, patch) => {
  Object.assign(config.settings, patch);
  if ('locked' in patch) for (const w of overlays.values()) w.setIgnoreMouseEvents(config.settings.locked);
  broadcast('settings', config.settings);
  saveConfig();
  pushState();
});
ipcMain.on('tempo', (_e, t) => {
  tempo = t;
  broadcast('tempo', tempo);
});

// ---------- IPC: overlays ----------
ipcMain.handle('overlay:init', (e) => {
  const id = idOf(e.sender);
  return { mascot: find(id), settings: config.settings, tempo };
});
ipcMain.on('overlay:aspect', (e, aspect, naturalW) => {
  const id = idOf(e.sender), m = find(id), win = overlays.get(id);
  if (!m || !win) return;
  m.aspect = aspect;
  if (!m.w || !m.h) { // first load: pick a sensible size
    const w = Math.round(Math.min(Math.max(naturalW || 220, 120), 260));
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: w, height: Math.round(w / aspect) });
    saveBounds(id);
  } else {
    // Keep stored width, fix height to the gif's real aspect ratio.
    const b = win.getBounds();
    win.setBounds({ x: b.x, y: b.y, width: b.width, height: Math.round(b.width / aspect) });
  }
});

let drag = null;
ipcMain.on('drag:start', (e, { sx, sy, mode }) => {
  const id = idOf(e.sender);
  if (!id) return;
  const win = overlays.get(id), b = win.getBounds();
  drag = { id, win, b, sx, sy, mode, aspect: b.width / b.height };
});
ipcMain.on('drag:move', (_e, { sx, sy }) => {
  if (!drag || drag.win.isDestroyed()) return;
  const { b } = drag, dx = sx - drag.sx, dy = sy - drag.sy;
  if (drag.mode === 'move') {
    drag.win.setBounds({ x: Math.round(b.x + dx), y: Math.round(b.y + dy), width: b.width, height: b.height });
  } else {
    const width = Math.max(50, Math.round(b.width + Math.max(dx, dy * drag.aspect)));
    drag.win.setBounds({ x: b.x, y: b.y, width, height: Math.round(width / drag.aspect) });
  }
});
ipcMain.on('drag:end', () => {
  if (drag) saveBounds(drag.id);
  drag = null;
});
ipcMain.on('resize:wheel', (e, deltaY) => {
  const id = idOf(e.sender), win = overlays.get(id);
  if (!win) return;
  const b = win.getBounds(), aspect = b.width / b.height;
  const width = Math.min(1600, Math.max(50, Math.round(b.width * Math.exp(-deltaY * 0.001))));
  const height = Math.round(width / aspect);
  win.setBounds({
    x: Math.round(b.x + (b.width - width) / 2), y: Math.round(b.y + (b.height - height) / 2), width, height,
  });
  saveBounds(id);
});
ipcMain.on('overlay:menu', (e) => {
  const id = idOf(e.sender), m = find(id);
  if (!m) return;
  const set = (patch) => { Object.assign(m, patch); e.sender.send('mascot', m); saveConfig(); pushState(); };
  Menu.buildFromTemplate([
    { label: m.name, enabled: false },
    { type: 'separator' },
    { label: 'Flip horizontally', type: 'checkbox', checked: !!m.flip, click: () => set({ flip: !m.flip }) },
    { label: 'Speed ×1', click: () => set({ speed: 1 }) },
    { label: 'Speed ×0.5', click: () => set({ speed: 0.5 }) },
    { label: 'Speed ×2', click: () => set({ speed: 2 }) },
    { type: 'separator' },
    { label: 'Lock all (click-through)', click: () => { config.settings.locked = true; ipcMain.emit('settings:update', null, { locked: true }); } },
    { label: 'Unload', click: () => { m.enabled = false; closeOverlay(id); saveConfig(); pushState(); } },
  ]).popup();
});

// ---------- control window / tray ----------
function createControl() {
  controlWin = new BrowserWindow({
    width: 480, height: 760, minWidth: 400, title: 'Dancing Mascots',
    backgroundColor: '#14141a', autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false,
      backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  controlWin.loadFile(path.join(__dirname, '../renderer/control.html'));
  controlWin.on('minimize', (e) => { e.preventDefault(); controlWin.hide(); }); // minimize to tray, not taskbar
  controlWin.on('close', (e) => {
    if (!quitting) { e.preventDefault(); controlWin.hide(); } // keep analysing audio in the tray
  });
}
function showControl() { controlWin.show(); controlWin.focus(); }

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open control panel', click: showControl },
    { label: 'Lock overlays (click-through)', type: 'checkbox', checked: config.settings.locked,
      click: (i) => ipcMain.emit('settings:update', null, { locked: i.checked }) },
    { type: 'separator' },
    ...config.mascots.map((m) => ({
      label: m.name, type: 'checkbox', checked: m.enabled,
      click: (i) => ipcMain.emit('mascot:update', null, m.id, { enabled: i.checked }),
    })),
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
}

app.whenReady().then(() => {
  loadConfig();

  // System-audio capture: answer getDisplayMedia() with a loopback of the output device.
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback({ video: sources[0], audio: 'loopback' });
    } catch (e) {
      console.error('loopback capture failed', e);
      callback({});
    }
  }, { useSystemPicker: false });

  createControl();
  const icon = nativeImage.createFromPath(path.join(__dirname, '../../assets/icon.png'));
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip('Dancing Mascots');
  tray.on('click', showControl);
  updateTrayMenu();

  config.mascots.filter((m) => m.enabled).forEach(openOverlay);
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* stay alive in the tray */ });
