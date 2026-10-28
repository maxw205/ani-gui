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
| `src-tauri/src/main.rs` | Starts ani-cli, relays its menus and output as events, stops mpv |
| `src-tauri/bridge/anigui-menu` | ani-cli's menu program (written to `%LOCALAPPDATA%\com.maxw205.animecli\bridge` at startup) |

## Cover art and details

Covers, banner, synopsis, genres, score, studio and the next airing time come from [AniList](https://anilist.co)'s public GraphQL API (no account needed). ani-cli's titles come from the streaming site, so `anilist.js` matches them by name: exact title matches first (most popular wins, so "JoJo's Bizarre Adventure" is the 2012 series rather than the 1993 OVA), then a second try with a simplified title (no brackets, no "Part 2:"). Titles AniList doesn't know, like "One Piece Movie 1", just show no art rather than a wrong guess.

A whole result list is looked up in one request and results are cached in the app's localStorage for 7 days, since AniList allows only 30–90 requests a minute. The CSP in `tauri.conf.json` allows `graphql.anilist.co` and `s4.anilist.co` and nothing else.

## How it works

Same bridge design as the Python app. ani-cli runs with `ANI_CLI_MENU=anigui-menu`; each time it would show a menu, the bridge writes the prompt and options to a temp folder and waits. The Rust side watches that folder and emits `ani-menu`, `ani-output` and `ani-exit` events. `main.js` decides the answer and sends it back with the `answer` command. mpv gets `--input-ipc-server` so Stop can close it, since ani-cli detaches the player.
