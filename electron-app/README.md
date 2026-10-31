# AnimeCLI (Electron + React)

The Electron version of AnimeCLI: search with ani-cli, pick an episode, and it plays right in the window in a normal `<video>` element, with its own controls on top. No mpv.

## Run it

```
npm install
npm start        # builds the interface, then opens the app
npm run dev      # development: hot reload for the React side
```

Needs Node.js and [ani-cli](https://github.com/pystardust/ani-cli) on PATH. mpv and fzf aren't used.

- **Windows**: ani-cli and Git for Windows, e.g. `scoop install git ani-cli`. ani-cli runs in Git Bash.
- **Linux / macOS**: ani-cli (from your package manager or its install script) with curl, sed and grep. ani-cli runs in `/bin/sh`. On Linux the upscaler needs WebGPU through Vulkan; if the GPU driver doesn't offer it, the plain video plays.

## Using it

- **Search**, pick a show, click an episode. **History** lists what you've watched; click one to jump to the next episode.
- **Player**: the controls show when the mouse moves and hide, with the cursor, after a few seconds while it plays. Space or K pause, ←/→ skip 5 s, ↑/↓ volume, M mute, C subtitles, F (or double-click) fullscreen.
- **Next / Previous / Replay / Autoplay** in the bar at the bottom; **Show log** shows ani-cli's output.

## How it works

| Path | What it does |
|---|---|
| `electron/main.cjs` | The window, and wiring for the parts below |
| `electron/anicli.cjs` | Runs ani-cli and relays its menus, output and streams to the page |
| `electron/stream.cjs` | The `anistream://` protocol: fetches the stream with the referrer it needs |
| `electron/preload.cjs` | The only API the page has (`window.anicli`) |
| `electron/bridge/` | Scripts ani-cli runs: its menu (`anigui-menu`), its "player" (`anigui-webmpv`) and a `rofi` stand-in (below) |
| `src/store.js` | App state and the ani-cli logic (what to answer, what to show) |
| `src/components/` | The React UI; `Player.jsx` is the video and its controls |
| `src/anilist.js` | Cover art and show details from AniList |

**ani-cli does the finding.** It's run with `ANI_CLI_MENU=anigui-menu`: whenever it would show a menu, that script writes the prompt and options to a temp folder and waits for the page's answer. Its player is `anigui-webmpv`, a stand-in that writes the stream URL, referrer, subtitles and title to the same folder instead of playing anything. (The name has "mpv" in it only because ani-cli passes the referrer and subtitles to players whose name contains "mpv".) Nothing is scraped by the app, so updating ani-cli keeps it working. When ani-cli isn't started from a terminal it switches to rofi or dmenu if either is installed, ignoring `ANI_CLI_MENU`; the bridge's `rofi` comes first on PATH, so ani-cli picks it and the menus still reach the page.

**The page plays it.** The stream hosts only answer requests that carry the right referrer, which a page can't set. So the page asks for `anistream://proxy/?u=<url>`; the main process fetches it with the referrer and passes it back, rewriting HLS playlists so their segments and subtitles go through the proxy too. Only hosts ani-cli handed over are fetched. hls.js plays the result. Nothing is re-encoded, so quality is the original, playback starts as soon as ani-cli has the link, and you can seek anywhere straight away.

When the video ends, the page tells the stand-in player to exit, so ani-cli shows its after-playback menu and Next / Autoplay / history work as with any player.

## Upscaler (Anime4K)

The **Upscaler** menu in the player's control bar runs [Anime4K](https://github.com/bloc97/Anime4K) on the GPU through WebGPU, using the presets from [Anime4K-WebGPU](https://github.com/Anime4KWebBoost/Anime4K-WebGPU) (MIT). Mode A suits 1080p sources, B 720p, C 480p; A+A, B+B and C+A are stronger and heavier.

`src/upscaler.js` copies each frame the `<video>` presents into a GPU texture, runs the chosen preset and draws the result into a `<canvas>` over the video, at the canvas's real pixel size. The preset always upscales to the screen's size, and the player in the window is drawn from that scaled down: building a preset compiles its shaders, which takes a moment, so this way resizing the window or going fullscreen never rebuilds it. The video keeps decoding and playing the sound underneath (invisible, but still taking the clicks); seeking is unaffected and nothing is re-encoded. The package's own `render()` helper can't be stopped and fixes its sizes once, so the presets are driven directly. While upscaling, subtitles are drawn by the player above the canvas, since the browser draws them as part of the (now invisible) video. If WebGPU isn't available or fails, it falls back to the plain video. The upscaler code (mostly the networks' weights, ~3.5 MB) loads only when it's first turned on.

## Not done yet

- ArtCNN (the GLSL shaders are written for mpv/libplacebo and would need porting to WebGPU).
- Packaging into an installer (e.g. electron-builder).
