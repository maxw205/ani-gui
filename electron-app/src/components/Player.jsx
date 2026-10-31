import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { log, setStatus, useStore, videoEnded, videoStarted } from "../store.js";
import { isTyping } from "../util.js";

const HIDE_AFTER_MS = 2500;
const SPEEDS = [0.75, 1, 1.25, 1.5, 2];

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
  const { stream, loadingVideo } = useStore();
  const frame = useRef(null);
  const video = useRef(null);
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
    const hls = new Hls({ enableWorker: false });
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

  // the subtitle track follows the CC button
  useEffect(() => {
    const track = video.current?.textTracks[0];
    if (track) track.mode = subsOn ? "showing" : "hidden";
  }, [subsOn, stream?.subtitles]);

  const read = useCallback(() => {
    const el = video.current;
    if (!el) return;
    const buffered = el.buffered.length ? el.buffered.end(el.buffered.length - 1) : 0;
    setV({ paused: el.paused, time: el.currentTime, duration: el.duration || 0, buffered, volume: el.volume, muted: el.muted, speed: el.playbackRate });
  }, []);

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

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else frame.current?.requestFullscreen();
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === frame.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const el = () => video.current;
  const togglePause = () => (el().paused ? el().play() : el().pause());
  const seekBy = (s) => { el().currentTime = Math.max(0, Math.min(el().duration || 0, el().currentTime + s)); };
  const setVolume = (value) => { el().volume = value; if (value > 0) el().muted = false; };
  const toggleMute = () => { el().muted = !el().muted; };

  // keyboard shortcuts while a video is up (Esc leaves fullscreen on its own)
  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.altKey || isTyping() || !video.current) return;
      const actions = {
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
  }, [poke, toggleFullscreen]);

  const duration = v.duration;
  const shownTime = seekDrag !== null ? seekDrag * duration : v.time;
  const played = duration ? (shownTime / duration) * 100 : 0;
  const bufferedPct = duration ? Math.min(100, (v.buffered / duration) * 100) : 0;
  const muted = v.muted || v.volume === 0;
  const hidden = !controlsShown && !v.paused;

  return (
    <div className="player-area">
      <div ref={frame} className={`player-frame ${hidden ? "idle" : ""} ${fullscreen ? "fullscreen" : ""}`}
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

        {(!stream || buffering) && <div className="video-message">{loadingVideo || !stream ? "Loading video…" : "Buffering…"}</div>}

        <div className={`controls ${hidden ? "hidden" : ""}`} onMouseMove={poke}>
          <div className="seek">
            <div className="track"><div className="buffered" style={{ width: `${bufferedPct}%` }} /><div className="played" style={{ width: `${played}%` }} /></div>
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
            <select className="speed" aria-label="Playback speed" title="Playback speed" value={v.speed}
              onChange={(e) => { el().playbackRate = Number(e.target.value); }}>
              {SPEEDS.map((sp) => <option key={sp} value={sp}>{sp}×</option>)}
            </select>
            <button type="button" className={`icon cc ${subsOn ? "" : "off"}`} aria-pressed={subsOn} title="Subtitles (c)"
              disabled={!stream?.subtitles} onClick={() => setSubsOn(!subsOn)}>CC</button>
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
