# Development

Notes for people who want to run the app from source or work on the code.

## Run from source

Needs [Node.js](https://nodejs.org) 20+ on Windows 10/11.

```
npm install
npm start
```

## Build the installers

```
npm run dist     # output goes to dist/ (an installer and a portable .exe)
```

GitHub Actions also builds them on every push to `main` and on version tags (`v*`); a tag build attaches
the files to a GitHub Release.

## Tests

```
npm test         # tempo/beat detection against synthetic drum tracks, plus fullscreen detection logic
```

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
