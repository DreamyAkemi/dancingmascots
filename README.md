# Dancing Mascots

Looping GIFs that dance on your desktop as always-on-top overlays, and speed up / slow down with the
tempo of whatever you're playing. Silence pauses them.

<img width="473" height="434" alt="dancingmascots" src="https://github.com/user-attachments/assets/940705ea-c26d-4476-880e-3e113505bcf5" />

## Run

```
npm install
npm start
```

Built for Windows 10/11 (Electron). Needs [Node.js](https://nodejs.org) installed. A tray icon keeps it running when you close the panel.

## Get the .exe (no Node needed)

Every push builds Windows installers via GitHub Actions: open the repo's **Actions** tab, pick the latest
run and download `DancingMascots-windows` (an installer and a portable `.exe`). Pushing a tag like `v0.1.0`
also attaches them to a GitHub Release. To build locally on Windows: `npm run dist` (output in `dist/`).

The installer isn't code-signed, so Windows SmartScreen will say "Unknown publisher": click *More info → Run anyway*.

## Using it

- **Add GIFs:** drop `.gif` files on the panel or click **+ Add GIFs**. Each toggle (**On/Off**) loads / unloads
  its overlay; ✕ removes it from the library. Your setup (files, positions, sizes, speeds) is remembered.
- **Move:** drag the mascot. **Resize:** drag the corner grip or scroll the mouse wheel over it.
- **Right-click** a mascot for flip / speed presets / lock / unload.
- **Lock overlays** (panel checkbox or tray) makes them click-through; unlock from the panel or tray.

### Tempo

Audio is captured from your **output device** (system loopback), so Spotify, YouTube, anything works.
The beat is found by onset detection + a comb-filter tempo estimate over the last ~7 s, so it takes a few
seconds to lock on after a song starts and glides between speeds. No sound for ~2 s → mascots freeze.

| Control | What it does |
| --- | --- |
| Auto-detect / Manual / Tap | Use detected BPM, or type/tap one |
| ½× / 1× / 2× | Fix half-time/double-time detection mistakes |
| All mascots speed | Global multiplier |
| Bounce on the beat | Squash-and-stretch pulse on every detected beat (with a strength slider) |
| Per-mascot Speed | Multiplier for one GIF |
| "Loop looks right at N BPM" | The tempo at which that GIF plays at its natural speed (default 120) |
| Auto half/double speed | Off by default. When on, a GIF plays at half or double speed if that keeps it closer to its natural speed (so a 180 BPM song plays like 90 BPM on a 120 BPM GIF) |

System audio capture (WASAPI loopback) works out of the box on Windows 11 and follows your default output device.
If it ever fails, pick "Stereo Mix" or a virtual cable as the audio source.

## Dev

`npm test` runs the tempo detector against synthetic drum tracks.

## Behaviour options

- **Pause & hide while another app is fullscreen** (default on): per monitor, so mascots on your second
  screen keep dancing while a game runs on the first. Uses the foreground window's size + lack of title bar.
- **Keep mascots above other windows** (default on): turn it off and they behave like normal windows that
  other windows can cover.
- **Launch at Windows startup:** starts hidden in the tray (installed or portable build).
- **Tempo history:** a collapsible graph of the last 3 minutes (tempo in use, raw detections, silences).
- **Multi-monitor:** drag mascots anywhere; right-click → *Move to monitor*. If a monitor is unplugged,
  stranded mascots are moved to the main screen automatically.
- **Efficiency:** audio analysis idles in silence, and stops entirely when no mascot is visible.
  All windows share one renderer process, so 7 mascots cost far less than 7× one.

## Code map

| File | Role |
| --- | --- |
| `src/main/main.js` | Main process: config, overlay windows, tray, IPC, input validation |
| `src/renderer/control.js` | Control panel UI + audio capture and tempo analysis |
| `src/renderer/overlay.js` | One mascot window: GIF playback, speed, beat bounce, drag/resize |
| `src/main/fullscreen.js` | Fullscreen-app detection (Win32 via koffi) |
| `src/shared/tempo.js` | Tempo/beat detection and speed maths (unit-tested) |

## Security notes

- Windows run with Node integration because they read your GIF files directly, so they only ever load
  the app's own local pages: navigation and `window.open` are blocked, and each page has a strict
  Content-Security-Policy.
- All IPC messages and the saved `config.json` are validated (known keys, types, ranges); nothing from
  them is inserted as HTML.
- GIFs are size-limited (100 MB, 4096 px, 3000 frames). Only audio capture permission is granted.
- The app makes no network connections and collects nothing.
- The Windows builds are unsigned (SmartScreen warning on first run).
