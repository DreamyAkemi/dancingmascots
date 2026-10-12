<div align="center">

<img src="assets/icon.png" width="96" alt="Dancing Mascots icon">

# Dancing Mascots

**Your favourite dancing GIFs, living on your desktop and grooving to whatever you're listening to.**

<img width="473" height="434" alt="Dancing Mascots demo" src="https://github.com/user-attachments/assets/940705ea-c26d-4476-880e-3e113505bcf5" />

</div>

Load any looping GIFs, drop them anywhere on your screen, and they dance in time with your music. Faster
songs make them dance faster, slower songs slow them down, and when the music stops they freeze.
It works with Spotify, YouTube, games, anything that plays through your speakers or headphones.

## Features

- **Dances to the beat.** Detects the tempo of whatever is playing and adjusts each GIF's speed to match.
- **As many mascots as you like.** Move and resize each one freely, on any monitor.
- **Easy to manage.** Drag GIFs onto the app to add them, switch each one on or off with a click.
- **Full control when you want it.** Per-mascot speed, a global speed, manual BPM and tap tempo.
- **Bounce on the beat** (optional): mascots pulse with every beat.
- **Stays out of your way.** Lives in the system tray, can pause itself while a game or video is
  fullscreen, and can start with Windows.
- **Light on your PC.** Uses little CPU, and almost none while the music is off.
- **Private.** No account, no internet connection, nothing is collected.

## Download

1. Go to the [**Releases** page](https://github.com/DreamyAkemi/dancingmascots/releases) and download the
   latest version:
   - **`Dancing Mascots Setup x.y.z.exe`** installs the app like any other program (recommended).
   - **`Dancing Mascots x.y.z.exe`** is the portable version: no install, just run it.
2. Run it. Windows 10 or 11 is required.

> **"Windows protected your PC" / "Unknown publisher"?** The app isn't signed with a paid certificate, so
> Windows shows this for any new app. Click **More info**, then **Run anyway**.

## Getting started

1. **Add some GIFs.** Drag `.gif` files onto the window, or click **+ Add GIFs**. They appear on your
   desktop right away.
2. **Play some music.** The status in the top right turns green and shows **Playing**, and the big number is
   the detected tempo in BPM.
3. **Arrange them.** Drag a mascot to move it, drag its bottom-right corner or scroll over it to resize it.

That's it. Close the window and the app keeps running in the system tray (next to the clock). Click the
tray icon to open it again, and right-click it to quit.

> **Tip:** GIFs with a **transparent background** look best, because they dance directly on your desktop.
> A GIF with a solid background shows up as a rectangle. The app doesn't come with any GIFs, so bring your own.

## The controls

### Tempo

| Control | What it does |
| --- | --- |
| **Audio source** | *System audio* picks up whatever you hear. Choose a specific input instead if you need to. |
| **Auto-detect / Manual** | Let the app detect the tempo, or type your own BPM. |
| **Tap** | Tap along to a song 3 or more times to set the BPM yourself (switches to Manual). |
| **Detection looks wrong?** | Press **½×** or **2×** if the app picks half or double the real tempo. |
| **All mascots speed** | Makes every mascot faster or slower. |
| **Bounce on the beat** | Makes mascots pulse with each beat. The slider sets how strong. |

The tempo takes a few seconds to lock on when a song starts. If a part of the song has no clear beat
(like an intro or a breakdown), the app keeps the last tempo it was sure about. The **Tempo history**
graph shows how it's doing.

### Behaviour

| Option | What it does |
| --- | --- |
| **Keep mascots above other windows** | On: always visible. Off: other windows can cover them. |
| **Pause & hide while another app is fullscreen** | Saves performance during games and videos. Only affects mascots on that monitor. |
| **Restart app** | Restarts the app. Use it if a mascot you just added shows a white box. |
| **Launch at Windows startup** | Starts the app hidden in the tray when you log in. |

### Each mascot

| Control | What it does |
| --- | --- |
| **On / Off** | Shows or hides the mascot. Your setup is remembered. |
| **✕** | Removes it from your list. |
| **Speed** | Makes this one mascot faster or slower than the others. |
| **Loop looks right at ... BPM** | The song tempo at which this GIF looks right at normal speed (120 by default). Raise it for a GIF that is already fast, lower it for a slow one. |
| **Auto half/double speed** | Plays the GIF at half or double speed instead of an extreme one when the song is much faster or slower than its natural tempo. Off by default. |
| **flip** | Mirrors the GIF. |

**On the mascot itself:** drag to move, drag the corner or scroll to resize, and **right-click** for flip,
speed presets, *Move to monitor*, lock and unload. **Lock overlays (click-through)** at the bottom of the
panel makes mascots ignore the mouse; unlock from the panel or the tray menu.

## Troubleshooting

**The mascots stopped reacting after I reconnected my headset / woke my PC.**
The app reconnects to the sound by itself (when a device changes, after sleep, and every so often while it hears
nothing). The panel shows which device it is listening to: **"System audio" always follows the Windows default
output device**. If your music plays on a different device than that one, change the default in
*Settings → System → Sound → Output* and the mascots pick it up within a few seconds.

**I want the mascots to ignore voice chat.**
Because the app only listens to the Windows *default* output, set your music device as the default and have your
voice app (Discord, a game's chat...) play on another device. Many headsets and tools (for example SteelSeries
Sonar's Chat / Gaming / Media outputs) already split sound this way.

**The mascots don't move.**
Check that the status says *Playing*. The app listens to your default output device, so make sure the sound
is actually playing through it. You can also try another **Audio source**, or switch to **Manual** and set a BPM.

**They dance at the wrong speed.**
Press **½×** or **2×**, tap the tempo yourself, or adjust the speed sliders. Some songs (very fast ones,
or ones with tempo changes) are hard to read automatically.

**A mascot disappeared or is off-screen.**
Click **Reset positions** at the bottom of the panel. If you unplug a monitor, mascots on it move to your
main screen automatically.

**A mascot I just added has a white box around it.**
This is a known glitch on some Windows PCs. Click **Restart app** in the panel (the panel also offers it right
after you add a GIF). Your mascots come straight back and the box is gone. If a GIF still has a solid
background after restarting, the picture itself isn't transparent (chat apps and some download sites flatten
transparency when a GIF is re-saved), so try the original file.

**I can't grab a mascot.**
**Lock overlays** is probably on. Untick it in the panel, or in the tray menu.

**Where is the window?**
Click the app's icon in the system tray (bottom right, near the clock; you may need to open the little ^ arrow).

## Keeping it light with many mascots

The app itself needs a fixed amount of memory, and then each mascot adds to it. How much a mascot adds depends
on its GIF: **memory and processor use grow with width × height × number of frames.** Mascots are shown at
roughly 250 to 300 pixels, so a GIF that is much bigger than that carries a lot of detail you never see.

- **Shrink big GIFs.** Resizing a 480 px GIF to about 300 px (for example with ezgif.com's *Resize* tool, then
  *Optimize*) makes it use noticeably less memory and processor, with no visible difference at that size.
  GIFs with fewer frames help too.
- **Switch off mascots you aren't using** with their On/Off switch.

## Privacy

Dancing Mascots works entirely on your PC. It never connects to the internet, doesn't record or store your audio
(it only measures the beat as it plays), and collects nothing. Your settings are saved in a small file on your
computer.

## Credits and license

Made by [DreamyAkemi](https://github.com/DreamyAkemi) with help from Claude. Free and open source under the
[MIT license](LICENSE). Built with [Electron](https://www.electronjs.org/),
[gifuct-js](https://github.com/matt-way/gifuct-js) and [koffi](https://koffi.dev/).

Want to run it from source or help out? See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
