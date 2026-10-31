import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { CAPTION_DEFAULTS, log, setSetting, setStatus, useStore, videoEnded, videoStarted, videoTime } from "../store.js";
import { skipTimes } from "../aniskip.js";
import { isTyping } from "../util.js";

// menu labels; the upscaler code itself (src/upscaler.js) only loads once it's turned on
const UPSCALER_LABELS = { off: "Upscaler off", a: "Anime4K A", b: "Anime4K B", c: "Anime4K C", aa: "Anime4K A+A", bb: "Anime4K B+B", ca: "Anime4K C+A" };

const HIDE_AFTER_MS = 2500;
// The speed slider runs 0.1× to 10× on a log scale, so slow and fast get the same room and 1× sits
// a bit past the middle; speeds are rounded to steps of 0.05×.
const SPEED_MIN = 0.1;
const SPEED_MAX = 10;
const speedAt = (position) =>
  Math.max(SPEED_MIN, Math.round(SPEED_MIN * (SPEED_MAX / SPEED_MIN) ** position * 20) / 20);
const positionOf = (speed) => Math.log(speed / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
const showSpeed = (speed) => `${Number(speed.toFixed(2))}×`;
const SPEED_PRESETS = [[0.5, "0.5×"], [1, "1×"], [1.5, "1.5×"], [2, "2×"]];
const SKIP_LABELS = { intro: "intro", outro: "ending", recap: "recap" };
// the caption settings menu: [setting, label, min, max, step, how to show the value]
const percent = (value) => `${Math.round(value * 100)}%`;
const CAPTION_SLIDERS = [
  ["size", "Size", 0.5, 2.5, 0.05, percent],
  ["background", "Background", 0, 1, 0.05, percent],
  ["lift", "Height", 0, 80, 1, (value) => `${value}%`],
  ["outline", "Outline", 0, 10, 0.5, String],
];
// fonts already on the computer (Windows names first, then Linux/macOS stand-ins): key -> [name, CSS]
const CAPTION_FONTS = {
  app: ["App font", '"Segoe UI", system-ui, sans-serif'],
  arial: ["Arial", 'Arial, "Liberation Sans", Helvetica, sans-serif'],
  verdana: ["Verdana", 'Verdana, "DejaVu Sans", sans-serif'],
  trebuchet: ["Trebuchet", '"Trebuchet MS", "Ubuntu", sans-serif'],
  georgia: ["Georgia", 'Georgia, "DejaVu Serif", serif'],
  mono: ["Monospace", 'Consolas, "DejaVu Sans Mono", monospace'],
};
// "#rrggbb" <-> [r, g, b], for the custom colour sliders
const toRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 0);
const toHex = (rgb) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
const CHANNELS = ["Red", "Green", "Blue"];
// outline thickness 0-10 -> stroke width; half of it shows, as it's drawn behind the letters
const outlineWidth = (outline) => `${outline * 0.025}em`;
const CAPTION_COLORS = [["#ffffff", "White"], ["#ffe14d", "Yellow"], ["#6ee7ff", "Cyan"], ["#8cff8c", "Green"], ["#ff9ecb", "Pink"]];

function formatTime(seconds) {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * The episode in a normal <video> element (hls.js plays the stream the main process
 * proxies), with the app's control bar laid over it. Like a usual player, the bar and
 * the cursor hide after a few seconds without the mouse moving while it plays.
 */
export default function Player() {
  const { stream, loadingVideo, settings, animeTitle, currentEp, details } = useStore();
  const frame = useRef(null);
  const video = useRef(null);
  const canvas = useRef(null);
  const upscaler = useRef(null); // promise of the WebGPU upscaler, created on first use
  const [upscaling, setUpscaling] = useState(false); // the canvas is showing the upscaled picture
  const [v, setV] = useState({ paused: true, time: 0, duration: 0, buffered: 0, volume: 1, muted: false, speed: 1 });
  const [subsOn, setSubsOn] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [seekDrag, setSeekDrag] = useState(null); // 0..1 while dragging the seek bar
  const [controlsShown, setControlsShown] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const hideTimer = useRef(0);

  // load the stream into the video element
  useEffect(() => {
    const el = video.current;
    if (!stream || !el) return undefined;
    // workers would need blob: scripts, which the page's security policy doesn't allow
    // startAt: carrying on after a Sub/Dub or Quality switch
    const hls = new Hls({ enableWorker: false, startPosition: stream.startAt ?? -1 });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      log(`[hls] ${data.type} ${data.details}${data.fatal ? " (fatal)" : ""}`);
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else setStatus(`Playback error: ${data.details}`, true);
    });
    hls.loadSource(stream.url);
    hls.attachMedia(el);
    el.play().catch(() => {});
    return () => {
      hls.destroy();
      el.removeAttribute("src");
      el.load();
    };
  }, [stream?.url]);

  // Anime4K: the video keeps decoding (and playing the sound) underneath; the canvas shows
  // its frames upscaled. Falls back to the plain video if WebGPU isn't there or fails.
  useEffect(() => {
    const mode = settings.upscaler;
    if (!stream || mode === "off") {
      setUpscaling(false);
      upscaler.current?.then((u) => u.stop()).catch(() => {});
      return undefined;
    }
    let cancelled = false;
    upscaler.current ??= import("../upscaler.js").then(({ createUpscaler }) =>
      createUpscaler(canvas.current, {
        onError: (message) => {
          setUpscaling(false);
          setStatus(`Upscaler stopped: ${message}`, true);
        },
      }));
    upscaler.current
      .then((u) => {
        if (cancelled) return;
        u.start(video.current, mode);
        setUpscaling(true);
        log(`[upscaler] ${UPSCALER_LABELS[mode]}`);
      })
      .catch((err) => {
        upscaler.current = null;
        setUpscaling(false);
        setStatus(`Upscaler unavailable: ${err.message}`, true);
      });
    return () => {
      cancelled = true;
    };
  }, [settings.upscaler, stream?.url]);

  // the canvas renders at its real pixel size, so the upscale targets what's on screen
  useEffect(() => {
    const el = canvas.current;
    const observer = new ResizeObserver(() => {
      const scale = window.devicePixelRatio || 1;
      el.width = Math.max(1, Math.round(el.clientWidth * scale));
      el.height = Math.max(1, Math.round(el.clientHeight * scale));
      upscaler.current?.then((u) => u.resize()).catch(() => {});
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => {
    upscaler.current?.then((u) => u.destroy()).catch(() => {});
  }, []);

  // The subtitle track runs hidden and the player draws its current lines itself: the browser's
  // own captions can hardly be styled, and they'd be invisible while upscaling, being drawn as
  // part of the (then invisible) video.
  const [captions, setCaptions] = useState([]);
  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (!track) return undefined;
    track.mode = "hidden";
    const onCueChange = () => setCaptions([...(track.activeCues ?? [])].map((cue) => cue.text.replace(/<[^>]+>/g, "")));
    track.addEventListener("cuechange", onCueChange);
    onCueChange();
    return () => track.removeEventListener("cuechange", onCueChange);
  }, [stream?.subtitles]);

  // the control bar's pop-up menus ("captions" or "speed"), closed by clicking anywhere else
  const [menu, setMenu] = useState(null);
  const toggleMenu = (name) => setMenu((open) => (open === name ? null : name));
  useEffect(() => {
    if (!menu) return undefined;
    const onDown = (e) => {
      if (!e.target.closest(".popup, .popup-button")) setMenu(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  // caption settings
  const [colorMenu, setColorMenu] = useState(false); // its custom colour sliders
  const cap = settings.captions;
  const rgb = toRgb(cap.color);
  const customColor = !CAPTION_COLORS.some(([color]) => color === cap.color);
  const setCaption = (key, value) => setSetting("captions", { ...cap, [key]: value });

  const read = useCallback(() => {
    const el = video.current;
    if (!el) return;
    const buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
    videoTime(el.currentTime);
    setV({ paused: el.paused, time: el.currentTime, duration: el.duration || 0, buffered, volume: el.volume, muted: el.muted, speed: el.playbackRate });
  }, []);

  // Openings, endings and recaps (AniSkip, by the show's MyAnimeList id from AniList): a Skip
  // button while one plays, or with Auto-skip on, jumped over by itself, once each, so seeking
  // back into one plays it.
  const [skips, setSkips] = useState([]);
  const malId = details?.idMal;
  const hasDuration = v.duration > 0;
  useEffect(() => {
    setSkips([]);
    if (!stream || !malId || !currentEp || !hasDuration) return undefined;
    let current = true;
    skipTimes(malId, currentEp, video.current.duration)
      .then((parts) => {
        if (!current) return;
        setSkips(parts);
        if (parts.length) log(`[AniSkip] ${parts.map((p) => `${p.kind} ${Math.round(p.start)}-${Math.round(p.end)} s`).join(", ")}`);
      })
      .catch((err) => log(`[AniSkip] ${err.message}`));
    return () => {
      current = false;
    };
  }, [stream, malId, currentEp, hasDuration]);
  const skipping = skips.find((part) => v.time >= part.start && v.time < part.end - 0.5);
  const autoSkipped = useRef(new Set());
  useEffect(() => {
    autoSkipped.current = new Set();
  }, [stream]);
  useEffect(() => {
    if (!skipping || !settings.autoSkip || autoSkipped.current.has(skipping)) return;
    autoSkipped.current.add(skipping);
    video.current.currentTime = skipping.end;
  }, [skipping, settings.autoSkip]);
  // with Auto-skip on, the button only shows when seeking back into an already skipped part
  const showSkip = skipping && !(settings.autoSkip && !autoSkipped.current.has(skipping));

  // controls (and cursor) auto-hide while playing
  const poke = useCallback(() => {
    setControlsShown(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!video.current?.paused) setControlsShown(false);
    }, HIDE_AFTER_MS);
  }, []);
  useEffect(() => {
    if (v.paused) {
      clearTimeout(hideTimer.current);
      setControlsShown(true);
    } else {
      poke();
    }
  }, [v.paused, poke]);
  useEffect(() => () => clearTimeout(hideTimer.current), []);

  // Not requestFullscreen(), which in Electron shows the app stretched to the screen before the
  // video takes over. Going in, the video covers the window and is drawn before the window grows,
  // since Windows keeps showing the last frame while it resizes; coming out, both happen at once.
  const fullscreenRef = useRef(false);
  const toggleFullscreen = useCallback(() => {
    const on = !fullscreenRef.current;
    fullscreenRef.current = on;
    setFullscreen(on);
    if (!on) window.anicli.setFullscreen(false);
    else requestAnimationFrame(() => requestAnimationFrame(() => fullscreenRef.current && window.anicli.setFullscreen(true)));
  }, []);
  useEffect(() => {
    // the window left fullscreen some other way
    const off = window.anicli.on("win:left-fullscreen", () => {
      fullscreenRef.current = false;
      setFullscreen(false);
    });
    return () => {
      off();
      if (fullscreenRef.current) window.anicli.setFullscreen(false);
    };
  }, []);

  const el = () => video.current;
  const togglePause = () => (el().paused ? el().play() : el().pause());
  const seekBy = (s) => { el().currentTime = Math.max(0, Math.min(el().duration || 0, el().currentTime + s)); };
  const setVolume = (value) => { el().volume = value; if (value > 0) el().muted = false; };
  const toggleMute = () => { el().muted = !el().muted; };

  // keyboard shortcuts while a video is up
  useEffect(() => {
    const onKey = (e) => {
      // Esc closes an open menu first, even with one of its controls focused
      if (e.key === "Escape" && menu) {
        setMenu(null);
        return;
      }
      if (e.ctrlKey || e.altKey || isTyping() || !video.current) return;
      const actions = {
        Escape: () => fullscreenRef.current && toggleFullscreen(),
        " ": togglePause,
        k: togglePause,
        ArrowLeft: () => seekBy(-5),
        ArrowRight: () => seekBy(5),
        ArrowUp: () => setVolume(Math.min(1, el().volume + 0.05)),
        ArrowDown: () => setVolume(Math.max(0, el().volume - 0.05)),
        m: toggleMute,
        c: () => setSubsOn((on) => !on),
        f: toggleFullscreen,
      };
      const action = actions[e.key];
      if (action) {
        e.preventDefault();
        action();
        poke();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [poke, toggleFullscreen, menu]);

  const duration = v.duration;
  const shownTime = seekDrag !== null ? seekDrag * duration : v.time;
  const played = duration ? (shownTime / duration) * 100 : 0;
  const bufferedPct = duration ? Math.min(100, (v.buffered / duration) * 100) : 0;
  const muted = v.muted || v.volume === 0;
  const hidden = !controlsShown && !v.paused && !menu;

  return (
    <div className="player-area">
      <div ref={frame} className={`player-frame ${hidden ? "idle" : ""} ${fullscreen ? "fullscreen" : ""} ${upscaling ? "upscaled" : ""}`}
        onMouseMove={poke} onMouseLeave={() => !v.paused && setControlsShown(false)}>
        <video ref={video} className="video" crossOrigin="anonymous" playsInline
          onClick={togglePause} onDoubleClick={toggleFullscreen}
          onTimeUpdate={read} onProgress={read} onDurationChange={read} onVolumeChange={read} onRateChange={read}
          onPlay={read} onPause={read}
          onWaiting={() => setBuffering(true)}
          onPlaying={() => { setBuffering(false); read(); videoStarted(); }}
          onEnded={() => { read(); videoEnded(); }}>
          {stream?.subtitles && <track kind="subtitles" label="English" srcLang="en" src={stream.subtitles} default />}
        </video>
        {/* the upscaled picture; clicks pass through to the video */}
        <canvas ref={canvas} className="upscale-canvas" />
        {subsOn && captions.length > 0 && (
          <div className="captions"
            style={{
              "--cap-size": cap.size,
              "--cap-color": cap.color,
              "--cap-bg": cap.background,
              "--cap-lift": cap.lift,
              "--cap-outline": outlineWidth(cap.outline),
              "--cap-font": (CAPTION_FONTS[cap.font] ?? CAPTION_FONTS.app)[1],
              "--cap-weight": cap.bold ? 700 : 400,
            }}>
            {captions.map((line, i) => <span key={i}>{line}</span>)}
          </div>
        )}

        {(!stream || buffering) && <div className="video-message">{loadingVideo || !stream ? "Loading video…" : "Buffering…"}</div>}

        {showSkip && (
          <button type="button" className={`skip-button ${hidden ? "low" : ""}`}
            onClick={() => { video.current.currentTime = skipping.end; }}>
            Skip {SKIP_LABELS[skipping.kind]}
          </button>
        )}

        <div className={`title-bar ${hidden ? "hidden" : ""}`}>
          {stream?.title || [animeTitle, currentEp && `Episode ${currentEp}`].filter(Boolean).join("  —  ")}
        </div>

        <div className={`controls ${hidden ? "hidden" : ""}`} onMouseMove={poke}>
          {menu === "captions" && (
            <div className="popup cap-menu" role="dialog" aria-label="Caption settings">
              {CAPTION_SLIDERS.map(([key, label, min, max, step, show]) => (
                <label key={key} className="cap-row">
                  <span>{label}</span>
                  <input type="range" className="cap-slider" min={min} max={max} step={step} value={cap[key]}
                    style={{ "--fill": `${((cap[key] - min) / (max - min)) * 100}%` }}
                    onChange={(e) => setCaption(key, Number(e.target.value))} />
                  <span className="cap-value">{show(cap[key])}</span>
                </label>
              ))}
              <div className="cap-row">
                <span>Font</span>
                <select className="cap-font" aria-label="Caption font" value={cap.font} onChange={(e) => setCaption("font", e.target.value)}>
                  {Object.entries(CAPTION_FONTS).map(([key, [name, css]]) => (
                    <option key={key} value={key} style={{ fontFamily: css }}>{name}</option>
                  ))}
                </select>
                <button type="button" className={`cap-bold ${cap.bold ? "on" : ""}`} aria-label="Bold" title="Bold"
                  aria-pressed={cap.bold} onClick={() => setCaption("bold", !cap.bold)}>B</button>
              </div>
              <div className="cap-row">
                <span>Colour</span>
                <div className="swatches">
                  {CAPTION_COLORS.map(([color, name]) => (
                    <button key={color} type="button" className={`swatch ${cap.color === color ? "on" : ""}`}
                      style={{ background: color }} aria-label={name} title={name} aria-pressed={cap.color === color}
                      onClick={() => setCaption("color", color)} />
                  ))}
                  <button type="button" className={`swatch custom ${customColor ? "on" : ""}`} aria-label="Custom colour"
                    title="Custom colour" aria-expanded={colorMenu} onClick={() => setColorMenu(!colorMenu)} />
                </div>
              </div>
              {colorMenu && (
                <div className="cap-colors">
                  {CHANNELS.map((name, i) => {
                    // the track shows the colour each point of the slider would give
                    const at = (value) => `rgb(${rgb.map((c, j) => (j === i ? value : c)).join(" ")})`;
                    return (
                      <label key={name} className="cap-row">
                        <span>{name}</span>
                        <input type="range" className="cap-slider rgb" min="0" max="255" step="1" value={rgb[i]}
                          style={{ "--track": `linear-gradient(to right, ${at(0)}, ${at(255)})` }}
                          onChange={(e) => setCaption("color", toHex(rgb.map((c, j) => (j === i ? Number(e.target.value) : c))))} />
                        <span className="cap-value">{rgb[i]}</span>
                      </label>
                    );
                  })}
                  <div className="cap-preview">
                    <span className="swatch" style={{ background: cap.color }} />
                    <code>{cap.color}</code>
                  </div>
                </div>
              )}
              <button type="button" className="ghost cap-reset" onClick={() => setSetting("captions", CAPTION_DEFAULTS)}>Reset</button>
            </div>
          )}
          <div className="seek">
            <div className="track">
              <div className="buffered" style={{ width: `${bufferedPct}%` }} />
              <div className="played" style={{ width: `${played}%` }} />
              {duration > 0 && skips.map((part) => (
                <div key={part.kind} className="skip-mark"
                  style={{ left: `${(part.start / duration) * 100}%`, width: `${((part.end - part.start) / duration) * 100}%` }} />
              ))}
            </div>
            <input type="range" min="0" max="1000" step="1" aria-label="Seek" disabled={!stream}
              value={Math.round((duration ? shownTime / duration : 0) * 1000)}
              onChange={(e) => setSeekDrag(Number(e.target.value) / 1000)}
              onPointerUp={(e) => { el().currentTime = (Number(e.target.value) / 1000) * duration; setSeekDrag(null); }}
              onKeyUp={(e) => { el().currentTime = (Number(e.target.value) / 1000) * duration; setSeekDrag(null); }} />
          </div>
          <div className="row">
            <button type="button" className="icon" aria-label={v.paused ? "Play" : "Pause"} title={v.paused ? "Play (space)" : "Pause (space)"} disabled={!stream} onClick={togglePause}>
              {v.paused
                ? <svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" /></svg>
                : <svg viewBox="0 0 24 24"><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></svg>}
            </button>
            <button type="button" className="icon" aria-label="Back 10 seconds" title="Back 10 s (←: 5 s)" disabled={!stream} onClick={() => seekBy(-10)}>
              <svg viewBox="0 0 24 24" className="stroke"><path d="M4 12a8 8 0 1 0 2.4-5.7" /><path d="M4 4v4.5h4.5" /><text x="12" y="15.5" textAnchor="middle">10</text></svg>
            </button>
            <button type="button" className="icon" aria-label="Forward 10 seconds" title="Forward 10 s (→: 5 s)" disabled={!stream} onClick={() => seekBy(10)}>
              <svg viewBox="0 0 24 24" className="stroke"><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4v4.5h-4.5" /><text x="12" y="15.5" textAnchor="middle">10</text></svg>
            </button>
            <span className="time">{formatTime(shownTime)} / {formatTime(duration)}</span>
            <span className="spacer" />
            <button type="button" className="icon" aria-label={muted ? "Unmute" : "Mute"} title="Mute (m)" onClick={toggleMute}>
              {muted
                ? <svg viewBox="0 0 24 24" className="stroke"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" className="fill" /><path d="M16 9.5l5 5M21 9.5l-5 5" /></svg>
                : <svg viewBox="0 0 24 24" className="stroke"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" className="fill" /><path d="M15.5 9a4 4 0 0 1 0 6" /><path d="M18 6.5a7.5 7.5 0 0 1 0 11" /></svg>}
            </button>
            <input type="range" className="volume" min="0" max="1" step="0.01" aria-label="Volume"
              value={muted ? 0 : v.volume} style={{ "--vol": `${(muted ? 0 : v.volume) * 100}%` }}
              onChange={(e) => setVolume(Number(e.target.value))} />
            <span className="rate-anchor">
              <button type="button" className="rate-value popup-button" title="Playback speed"
                aria-expanded={menu === "speed"} onClick={() => toggleMenu("speed")}>{showSpeed(v.speed)}</button>
              {menu === "speed" && (
                <div className="popup rate-menu" role="dialog" aria-label="Playback speed">
                  <div className="rate-head">
                    <span>Speed</span>
                    <b>{showSpeed(v.speed)}</b>
                  </div>
                  <input type="range" className="rate" min="0" max="1" step="0.005" aria-label="Playback speed"
                    value={positionOf(v.speed)} style={{ "--rate": `${positionOf(v.speed) * 100}%` }}
                    onChange={(e) => { el().playbackRate = speedAt(Number(e.target.value)); }} />
                  <div className="rate-scale"><span>0.1×</span><span>10×</span></div>
                  <div className="rate-presets">
                    {SPEED_PRESETS.map(([speed, label]) => (
                      <button key={speed} type="button" className={v.speed === speed ? "on" : ""} aria-pressed={v.speed === speed}
                        onClick={() => { el().playbackRate = speed; }}>{label}</button>
                    ))}
                  </div>
                </div>
              )}
            </span>
            <select className="speed upscaler" aria-label="Upscaler" value={settings.upscaler}
              title="Anime4K upscaling on the GPU. Mode A suits 1080p sources, B 720p, C 480p; the + modes are stronger and heavier."
              onChange={(e) => setSetting("upscaler", e.target.value)}>
              {Object.entries(UPSCALER_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
            <button type="button" className={`icon cc ${subsOn ? "" : "off"}`} aria-pressed={subsOn} title="Subtitles (c)"
              disabled={!stream?.subtitles} onClick={() => setSubsOn(!subsOn)}>CC</button>
            <button type="button" className="icon popup-button" aria-label="Caption settings" title="Caption settings"
              aria-expanded={menu === "captions"} onClick={() => toggleMenu("captions")}>
              <svg viewBox="0 0 24 24" className="stroke"><circle cx="12" cy="12" r="3" /><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" /></svg>
            </button>
            <button type="button" className="icon" aria-label={fullscreen ? "Leave fullscreen" : "Fullscreen"} title="Fullscreen (f, or double-click the video)" onClick={toggleFullscreen}>
              {fullscreen
                ? <svg viewBox="0 0 24 24" className="stroke"><path d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5" /></svg>
                : <svg viewBox="0 0 24 24" className="stroke"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></svg>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
