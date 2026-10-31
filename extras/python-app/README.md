# AnimeCLI: the original Python app

The first version of AnimeCLI: a Python/tkinter window for [ani-cli](https://github.com/pystardust/ani-cli). Search, pick an episode, and it plays in mpv. The main app is now the Electron one at the [top of this repo](../../README.md), which plays episodes right in its window (no mpv), can upscale them with Anime4K and skips intros with [AniSkip](https://aniskip.com). This one is kept as a lighter alternative that uses mpv.

## Run it

Double-click `AnimeCLI.bat`, or:

```
pythonw anigui.py
```

Needs ani-cli, mpv, fzf and Git for Windows (all via scoop) and Python 3 with tkinter. No pip packages.

## Using it

- **Search**: type a name and press Enter, then click a show on the left to list its episodes.
- **Episodes**: click a number to play it. Watched episodes are green, the current one is purple. Long series are split into pages of 100.
- **Player bar**: Previous / Replay / Next switch episodes (the old mpv window closes), Stop closes the player. With **Autoplay next** on, closing mpv starts the next episode.
- **History**: ani-cli's watch history. Click a show to jump straight to the episode after the one you last watched.
- **Sub / Dub** and **Quality** apply to the next episode you start.
- **Show log**: ani-cli's own output, useful when something fails.

## Upscaling shaders

mpv's config (`~\scoop\persist\mpv\portable_config`) has Anime4K and [ArtCNN](https://github.com/Artoriuz/ArtCNN) v1.6.2 shaders. Press these while an episode plays:

| Key | Shaders |
|---|---|
| Ctrl+1 … Ctrl+6 | Anime4K modes A, B, C, A+A, B+B, C+A |
| Ctrl+7 | ArtCNN C4F32 |
| Ctrl+8 | ArtCNN C4F32 + adaptive sharpen |
| Ctrl+9 | ArtCNN C4F32 DS (denoise + sharpen) |
| Ctrl+0 | Off |

The upscalers only kick in when the video is drawn bigger than the stream (ArtCNN needs 1.3×), so on a 1080p screen pick Quality 720 and go fullscreen. Shift+I then 2 in mpv lists the shader passes that are running. Shader lists in input.conf must be separated with `;` on Windows, not `:`.

## How it works

The app doesn't scrape anything itself. It runs ani-cli with `ANI_CLI_MENU` pointed at `bridge/anigui-menu`, so whenever ani-cli would show a menu, the bridge hands the prompt and options to the window through a temp folder and waits for the click. Updating ani-cli (`ani-cli -U` or `scoop update ani-cli`) updates the app too.
