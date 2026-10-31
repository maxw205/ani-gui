# AnimeCLI (Electron + React)

The Electron version of AnimeCLI: search with ani-cli, pick an episode, and it plays right in the window in a normal `<video>` element, with its own controls on top. No mpv.

## Run it

```
npm install
npm start        # builds the interface, then opens the app
npm run dev      # development: hot reload for the React side
```

Needs ani-cli (and its Git Bash) installed, e.g. with scoop. mpv isn't used.

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
| `electron/bridge/` | Scripts ani-cli runs: its menu (`anigui-menu`) and its "player" (`anigui-webmpv`) |
| `src/store.js` | App state and the ani-cli logic (what to answer, what to show) |
| `src/components/` | The React UI; `Player.jsx` is the video and its controls |
| `src/anilist.js` | Cover art and show details from AniList |

**ani-cli does the finding.** It's run with `ANI_CLI_MENU=anigui-menu`: whenever it would show a menu, that script writes the prompt and options to a temp folder and waits for the page's answer. Its player is `anigui-webmpv`, a stand-in that writes the stream URL, referrer, subtitles and title to the same folder instead of playing anything. (The name has "mpv" in it only because ani-cli passes the referrer and subtitles to players whose name contains "mpv".) Nothing is scraped by the app, so updating ani-cli keeps it working.

**The page plays it.** The stream hosts only answer requests that carry the right referrer, which a page can't set. So the page asks for `anistream://proxy/?u=<url>`; the main process fetches it with the referrer and passes it back, rewriting HLS playlists so their segments and subtitles go through the proxy too. Only hosts ani-cli handed over are fetched. hls.js plays the result. Nothing is re-encoded, so quality is the original, playback starts as soon as ani-cli has the link, and you can seek anywhere straight away.

When the video ends, the page tells the stand-in player to exit, so ani-cli shows its after-playback menu and Next / Autoplay / history work as with any player.

## Not done yet

- Upscaling (planned through ffmpeg's libplacebo filter, which runs the ArtCNN shaders).
- Packaging into an installer (e.g. electron-builder).
