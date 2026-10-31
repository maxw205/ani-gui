# AnimeCLI (Tauri)

The Tauri version of AnimeCLI: same features as the Python app in the folder above, with an HTML/CSS interface and a small Rust backend.

## Run it

After a build, the app is `src-tauri\target\release\animecli.exe`. It's a single exe and needs no install.

Needs the same tools as the Python version: ani-cli, mpv and fzf (via scoop) and Git for Windows. WebView2 ships with Windows 10/11.

## Develop

```
npm install
tauri.cmd dev      # opens the app, rebuilds Rust on change
tauri.cmd build    # release exe + NSIS installer (add --no-bundle for just the exe)
```

`tauri.cmd` wraps `npx tauri` in the Visual Studio 2019 C++ environment. On this PC the VS 2022 toolset is missing its x64 libraries and Rust picks it by default, so plain `npx tauri build` fails with `LNK1104: cannot open file 'msvcrt.lib'`. Adding the "MSVC v143 x64/x86 build tools" component to VS 2022 in the Visual Studio Installer also fixes it.

`tauri.cmd` also swaps in a short PATH (Windows, Node, Cargo) before running `vcvars64.bat`. With a long PATH, such as an Anaconda prompt, vcvars pushes it past cmd.exe's 8191-character line limit and fails with "The input line is too long. The syntax of the command is incorrect."

If you only change files in `src/`, `cargo build` may not notice. Touch `src-tauri/src/main.rs` (or use `tauri.cmd dev`) to re-embed them.

## Layout

| Path | What it does |
|---|---|
| `src/index.html`, `src/styles.css` | The window |
| `src/main.js` | All app logic: searching, episode flow, history, player controls |
| `src/anilist.js` | Cover art and show details from AniList |
| `src-tauri/src/main.rs` | Starts ani-cli, relays its menus and output as events, controls mpv over its IPC pipe |
| `src-tauri/src/video.rs` | The native window mpv draws into, kept over the page's video area |
| `src-tauri/bridge/anigui-menu` | ani-cli's menu program (written to `%LOCALAPPDATA%\com.maxw205.animecli\bridge` at startup) |
| `src-tauri/shaders/` | ArtCNN GLSL shaders and license (written to `%LOCALAPPDATA%\com.maxw205.animecli\shaders` at startup) |

## Video inside the app

Episodes play in the app window, above the episode list. mpv still does the playing (so `mpv.conf` and your input.conf keys work), but it's started with `--wid` and draws into a black native child window (`video.rs`) that sits over the page's video box.

A native window always draws above the page, so the control bar sits directly under the video instead of over it: play/pause, ±10 s (exact seeks, since plain relative seeks snap to keyframes ~10 s apart), a seek bar with the buffered range, time, volume/mute, speed, subtitles and fullscreen. The backend observes mpv's `pause`, `time-pos`, `duration`, `volume`, `mute`, `sub-visibility`, `speed` and `demuxer-cache-time` (the per-frame ones throttled to 4 updates a second) and only accepts the few commands the bar needs (`player_command`). The bar is drawn from what mpv reports, so it also follows mpv's own keys. When the page has focus: Space, ←/→ (5 s), ↑/↓ (volume), M, C and F. mpv's own on-screen controller is hidden while the bar is showing. `main.js` reports the box's position whenever the layout changes and the backend moves the window to match; it's hidden while a dialog is open, since a native window always draws above the page.

While the app window is being resized the video is hidden: the page re-lays itself out every frame and the native window can only follow a frame later, so it would hang over the controls when shrinking and leave gaps when growing. The backend hides it on the first `Resized` event (no round trip through the page) and the page shows it again, in place, 120 ms after the size stops changing.

Fullscreen is the app's: only the video shows and the window goes fullscreen, with mpv's own on-screen controller (which mpv draws over the picture) in place of the bar. It follows mpv's own `fullscreen` property, so ⛶, **f** or double-clicking the video, and **Esc** all do the same thing whether the page or the video has focus. **Start fullscreen** enters it as each episode begins.

## Upscaler

The **Upscaler** menu picks one of the six ArtCNN shaders bundled from [Artoriuz/ArtCNN](https://github.com/Artoriuz/ArtCNN) (MIT): C4F32 for quality or C4F16 for lighter GPUs, each neutral, DS (denoise + sharpen) or DN (denoise + soften). The backend applies it over mpv's IPC pipe to each player a session opens, and immediately when you switch mid-episode.

ArtCNN is a 2× upscaler that only runs when mpv draws the video at least 1.3× bigger than the stream, so on a 1080p screen it needs a 720p stream in fullscreen. The **Use 720p** button appears when the chosen quality makes it pointless. Some episodes aren't offered in every quality and ani-cli falls back to the best one, in which case ArtCNN correctly stays off.

## Cover art and details

Covers, banner, synopsis, genres, score, studio and the next airing time come from [AniList](https://anilist.co)'s public GraphQL API (no account needed). ani-cli's titles come from the streaming site, so `anilist.js` matches them by name: exact title matches first (most popular wins, so "JoJo's Bizarre Adventure" is the 2012 series rather than the 1993 OVA), then a second try with a simplified title (no brackets, no "Part 2:"). Titles AniList doesn't know, like "One Piece Movie 1", just show no art rather than a wrong guess.

A whole result list is looked up in one request and results are cached in the app's localStorage for 7 days, since AniList allows only 30–90 requests a minute. The CSP in `tauri.conf.json` allows `graphql.anilist.co` and `s4.anilist.co` and nothing else.

## How it works

Same bridge design as the Python app. ani-cli runs with `ANI_CLI_MENU=anigui-menu`; each time it would show a menu, the bridge writes the prompt and options to a temp folder and waits. The Rust side watches that folder and emits `ani-menu`, `ani-output` and `ani-exit` events. `main.js` decides the answer and sends it back with the `answer` command. mpv gets `--input-ipc-server` so Stop can close it, since ani-cli detaches the player.
