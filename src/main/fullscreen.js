'use strict';
/**
 * fullscreen.js — detects when ANOTHER app (a game, a video player, a browser in F11 mode...)
 * is covering a whole monitor, so the mascots on that monitor can pause and hide.
 *
 * Windows only. It uses a few Win32 calls through `koffi` (an FFI library that ships prebuilt
 * binaries, so nothing has to be compiled). On any other OS, or if koffi can't load, the
 * watcher quietly does nothing.
 *
 * "Fullscreen" here means: the foreground window's rectangle covers an entire display AND
 * the window has no title bar. The title-bar check keeps a normally maximized window
 * (which has one) from counting. The desktop itself and our own windows never count.
 */

const WS_CAPTION = 0x00c00000;      // window style bits that make up a title bar
const GWL_STYLE = -16;
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd']); // desktop + taskbar

/**
 * Pure decision logic (kept separate so it can be unit-tested without Windows).
 * @param {{x:number,y:number,width:number,height:number}} rect  window rectangle, in the same units as displays
 * @param {Array<{id:number,bounds:{x:number,y:number,width:number,height:number}}>} displays
 * @param {{style:number, className:string, ownWindow:boolean}} win
 * @returns {number|null} id of the display the window fully covers, or null
 */
function fullscreenDisplayId(rect, displays, win) {
  if (win.ownWindow || SHELL_CLASSES.has(win.className)) return null;
  if ((win.style & WS_CAPTION) === WS_CAPTION) return null; // has a title bar → ordinary window
  for (const d of displays) {
    const b = d.bounds;
    // A tolerance of 2 px allows for rounding between physical pixels and DIPs.
    if (rect.x <= b.x + 2 && rect.y <= b.y + 2
      && rect.x + rect.width >= b.x + b.width - 2 && rect.y + rect.height >= b.y + b.height - 2) return d.id;
  }
  return null;
}

/**
 * Start polling. Calls `onChange(idOrNull)` whenever the fullscreen display changes
 * (null = nothing is fullscreen). Returns { stop() }.
 * @param {object} opts
 * @param {(id:number|null)=>void} opts.onChange
 * @param {Electron.Screen} opts.screen   Electron's `screen` module
 * @param {number} [opts.intervalMs=2000]
 */
function watchFullscreen({ onChange, screen, intervalMs = 2000 }) {
  if (process.platform !== 'win32') return { stop() {}, supported: false };

  let api;
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
    api = {
      GetForegroundWindow: user32.func('void* GetForegroundWindow()'),
      GetWindowRect: user32.func('bool GetWindowRect(void* hWnd, _Out_ RECT* lpRect)'),
      GetWindowLongW: user32.func('int32 GetWindowLongW(void* hWnd, int nIndex)'),
      GetWindowThreadProcessId: user32.func('uint32 GetWindowThreadProcessId(void* hWnd, _Out_ uint32_t* pid)'),
      GetClassNameA: user32.func('int GetClassNameA(void* hWnd, _Out_ uint8_t* buf, int max)'),
    };
  } catch (e) {
    console.error('Fullscreen detection unavailable:', e.message);
    return { stop() {}, supported: false };
  }

  let current = null;
  function poll() {
    let id = null;
    try {
      const hwnd = api.GetForegroundWindow();
      if (hwnd) {
        const r = {};
        const pid = [0];
        const nameBuf = new Uint8Array(256);
        if (api.GetWindowRect(hwnd, r)) {
          api.GetWindowThreadProcessId(hwnd, pid);
          api.GetClassNameA(hwnd, nameBuf, nameBuf.length);
          const className = Buffer.from(nameBuf).toString('latin1').split('\0')[0];
          // GetWindowRect returns physical pixels; Electron displays use DIPs, so convert.
          const rect = screen.screenToDipRect(null, { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top });
          id = fullscreenDisplayId(rect, screen.getAllDisplays(), {
            style: api.GetWindowLongW(hwnd, GWL_STYLE),
            className,
            ownWindow: pid[0] === process.pid,
          });
        }
      }
    } catch (e) {
      id = null; // on any error, assume "not fullscreen" so mascots keep dancing
    }
    if (id !== current) { current = id; onChange(id); }
  }

  const timer = setInterval(poll, intervalMs);
  poll();
  return { stop: () => clearInterval(timer), supported: true };
}

module.exports = { watchFullscreen, fullscreenDisplayId };
