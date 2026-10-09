# Dancing Mascots

Looping GIFs that dance on your desktop as always-on-top overlays, and speed up / slow down with the
tempo of whatever you're playing. Silence pauses them.

## Run

```
npm install
npm start
```

Built for Windows 10/11 (Electron). Needs [Node.js](https://nodejs.org) installed. A tray icon keeps it running when you close the panel.

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
| Per-mascot Speed | Multiplier for one GIF |
| "Loop looks right at N BPM" | The tempo at which that GIF plays at its natural speed (default 120) |
| ½/2× smart | Lets a GIF use half/double time if that keeps it closer to its natural speed |

System audio capture (WASAPI loopback) works out of the box on Windows 11 and follows your default output device.
If it ever fails, pick "Stereo Mix" or a virtual cable as the audio source.

## Dev

`npm test` runs the tempo detector against synthetic drum tracks.
