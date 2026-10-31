# AnimeCLI

A desktop app for watching anime through [ani-cli](https://github.com/pystardust/ani-cli), built with Electron and React: search, pick an episode, and it plays right in the window in a normal `<video>` element, with its own controls on top. No mpv. It can upscale with Anime4K and skips intros with [AniSkip](https://aniskip.com).

## Run it

```
npm install
npm start        # builds the interface, then opens the app
npm run dev      # development: hot reload for the React side
```

Needs Node.js and [ani-cli](https://github.com/pystardust/ani-cli) on PATH. mpv and fzf aren't used.

- **Windows**: ani-cli and Git for Windows, e.g. `scoop install git ani-cli`. ani-cli runs in Git Bash.
- **Linux / macOS**: ani-cli (from your package manager or its install script) with curl, sed and grep. ani-cli runs in `/bin/sh`. On Linux the upscaler needs WebGPU through Vulkan; if the GPU driver doesn't offer it, the plain video plays.

## Build an installer

```
npm run dist
```

builds the interface and packs it with [electron-builder](https://www.electron.build) into `release/AnimeCLI-Setup-<version>.exe` (about 90 MB, since Electron brings its own Chromium), to share or attach to a release. The version comes from `package.json`. On Linux the same command makes `release/AnimeCLI-<version>.AppImage` (it has to be built on Linux, or in WSL). The installed app still needs ani-cli, and Git for Windows on Windows, as above.

The app isn't code-signed, so Windows shows "Windows protected your PC" the first time; **More info → Run anyway** starts it. It has Electron's default icon until one is added. Installed or run with `npm start`, it keeps its settings in the same folder (`%APPDATA%nimecli-electron` on Windows).

## Using it

- **Search**, pick a show, click an episode. **History** lists what you've watched; click one to jump to the next episode.
- **Player**: the controls and the episode's title show when the mouse moves and hide, with the cursor, after a few seconds while it plays. Space or K pause, ←/→ skip 5 s, ↑/↓ volume, M mute, C subtitles, F (or double-click) fullscreen. While an episode plays, its episodes and the show's details are below the player.
- **Speed**: click the speed in the control bar for a slider from 0.1× to 5× and 0.5× / 1× / 1.5× / 2× buttons.
- **Captions**: the gear next to CC sets their size, colour (presets or RGB sliders), background, height, outline, font and bold. Remembered between sessions.
- **Skip intro**: a button to skip openings, endings and recaps while they play, and **Auto-skip intros** at the bottom to skip them without asking (see [Skipping intros](#skipping-intros-aniskip)).
- **Sub / Dub** and **Quality**: changing them mid-episode loads the same episode again that way, from the same point.
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
| `src/aniskip.js` | Opening, ending and recap times from AniSkip |

**ani-cli does the finding.** It's run with `ANI_CLI_MENU=anigui-menu`: whenever it would show a menu, that script writes the prompt and options to a temp folder and waits for the page's answer. Its player is `anigui-webmpv`, a stand-in that writes the stream URL, referrer, subtitles and title to the same folder instead of playing anything. (The name has "mpv" in it only because ani-cli passes the referrer and subtitles to players whose name contains "mpv".) Nothing is scraped by the app, so updating ani-cli keeps it working. When ani-cli isn't started from a terminal it switches to rofi or dmenu if either is installed, ignoring `ANI_CLI_MENU`; the bridge's `rofi` comes first on PATH, so ani-cli picks it and the menus still reach the page.

**The page plays it.** The stream hosts only answer requests that carry the right referrer, which a page can't set. So the page asks for `anistream://proxy/?u=<url>`; the main process fetches it with the referrer and passes it back, rewriting HLS playlists so their segments and subtitles go through the proxy too. Only hosts ani-cli handed over are fetched. hls.js plays the result. Nothing is re-encoded, so quality is the original, playback starts as soon as ani-cli has the link, and you can seek anywhere straight away.

When the video ends, the page tells the stand-in player to exit, so ani-cli shows its after-playback menu and Next / Autoplay / history work as with any player.

## Upscaler (Anime4K)

The **Upscaler** menu in the player's control bar runs [Anime4K](https://github.com/bloc97/Anime4K) on the GPU through WebGPU, using the presets from [Anime4K-WebGPU](https://github.com/Anime4KWebBoost/Anime4K-WebGPU) (MIT). Mode A suits 1080p sources, B 720p, C 480p; A+A, B+B and C+A are stronger and heavier.

`src/upscaler.js` copies each frame the `<video>` presents into a GPU texture, runs the chosen preset and draws the result into a `<canvas>` over the video, at the canvas's real pixel size. The preset always upscales to the screen's size, and the player in the window is drawn from that scaled down: building a preset compiles its shaders, which takes a moment, so this way resizing the window or going fullscreen never rebuilds it. The video keeps decoding and playing the sound underneath (invisible, but still taking the clicks); seeking is unaffected and nothing is re-encoded. The package's own `render()` helper can't be stopped and fixes its sizes once, so the presets are driven directly. Subtitles are always drawn by the player itself, above the canvas (the browser would draw them as part of the video, which is invisible while upscaling, and its own captions can hardly be styled). If WebGPU isn't available or fails, it falls back to the plain video. The upscaler code (mostly the networks' weights, ~3.5 MB) loads only when it's first turned on.

## Skipping intros (AniSkip)

Opening, ending and recap times come from [AniSkip](https://aniskip.com), the community database behind [ani-skip](https://github.com/synacktraa/ani-skip) (which ani-cli's `--skip` uses). ani-skip itself turns those times into an mpv script, which doesn't apply to a page's `<video>`, so the app asks AniSkip's API directly (`src/aniskip.js`):

- AniSkip knows shows by their MyAnimeList id. The app already matches each show on AniList for its cover art, and AniList gives the MyAnimeList id (`idMal`) too, so there's no extra search.
- Once the video's length is known, it asks `api.aniskip.com/v2/skip-times/<MAL id>/<episode>` for openings, endings, recaps and "mixed" openings/endings (ones played over story scenes). Submitted timings are tied to the cut of the episode they were made on, so of each kind the one whose episode length is closest to the playing video is used.
- While one of them plays, **Skip intro / ending / recap** shows over the video, and they're marked in yellow on the seek bar. With **Auto-skip intros** on, each is jumped over once by itself; seeking back into one plays it, with the button.

Nothing shows when the show didn't match on AniList (it then has no cover art either), when nobody has submitted timings for that episode yet, for half episodes (12.5), or when the streaming site numbers a season's episodes differently from MyAnimeList.

## Extras

[`extras/python-app/`](extras/python-app/README.md) is the original version: a Python/tkinter window that runs ani-cli the same way but plays in mpv, with mpv's Anime4K and ArtCNN shaders.

## Not done yet

- ArtCNN (the GLSL shaders are written for mpv/libplacebo and would need porting to WebGPU).
