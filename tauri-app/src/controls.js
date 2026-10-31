// The control bar shown over the video in fullscreen, in a small window of its own (the
// main window can't draw over the video). main.js shows and hides this window and sends
// it mpv's state; the buttons talk to mpv directly. Same behaviour as the bar under the
// video in main.js.

const { invoke } = window.__TAURI__.core;
const { listen, emitTo } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const el = {
  play: $("vc-play"), back: $("vc-back"), fwd: $("vc-fwd"), time: $("vc-time"),
  seek: $("vc-seek"), buffer: $("vc-buffer"), progress: $("vc-progress"),
  mute: $("vc-mute"), volume: $("vc-volume"), speed: $("vc-speed"), subs: $("vc-subs"), fs: $("fs-btn"),
};
let props = {}; // mpv's state, sent by main.js
let enabled = false;
let seekDragging = false;

const command = (...args) => invoke("player_command", { command: args }).catch(() => {});
const setProperty = (name, value) => command("set_property", name, value);
const leaveFullscreen = () => invoke("set_player_fullscreen", { on: false });

function formatTime(seconds) {
  const t = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

function render() {
  const duration = props.duration || 0;
  const position = seekDragging ? (Number(el.seek.value) / 1000) * duration : props["time-pos"] || 0;
  el.play.classList.toggle("paused", Boolean(props.pause));
  el.play.title = props.pause ? "Play (space)" : "Pause (space)";
  el.time.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
  if (!seekDragging) el.seek.value = duration ? Math.round((position / duration) * 1000) : 0;
  el.progress.style.width = duration ? `${Math.min(100, (position / duration) * 100)}%` : "0";
  const cached = props["demuxer-cache-time"];
  el.buffer.style.width = duration && cached ? `${Math.min(100, (cached / duration) * 100)}%` : "0";
  const muted = Boolean(props.mute) || props.volume === 0;
  el.mute.classList.toggle("muted", muted);
  if (document.activeElement !== el.volume && typeof props.volume === "number") el.volume.value = Math.round(Math.min(100, props.volume));
  el.volume.style.setProperty("--vol", `${muted ? 0 : el.volume.value}%`);
  el.subs.setAttribute("aria-pressed", String(props["sub-visibility"] !== false));
  if (typeof props.speed === "number" && [...el.speed.options].some((o) => Number(o.value) === props.speed)) el.speed.value = String(props.speed);
  for (const control of document.querySelectorAll("button, input, select")) control.disabled = !enabled;
}

const togglePause = () => setProperty("pause", !props.pause);
const seekBy = (seconds) => command("seek", seconds, "relative+exact");
const toggleMute = () => setProperty("mute", !props.mute);
const toggleSubs = () => setProperty("sub-visibility", props["sub-visibility"] === false);
function changeVolume(delta) {
  setProperty("volume", Math.max(0, Math.min(100, Math.round((props.volume ?? 100) + delta))));
  if (props.mute && delta > 0) setProperty("mute", false);
}

el.play.addEventListener("click", togglePause);
el.back.addEventListener("click", () => seekBy(-10));
el.fwd.addEventListener("click", () => seekBy(10));
el.mute.addEventListener("click", toggleMute);
el.subs.addEventListener("click", toggleSubs);
el.fs.addEventListener("click", leaveFullscreen);
el.speed.addEventListener("change", () => setProperty("speed", Number(el.speed.value)));
el.seek.addEventListener("input", () => {
  seekDragging = true;
  render();
});
el.seek.addEventListener("change", () => {
  seekDragging = false;
  const target = (Number(el.seek.value) / 1000) * (props.duration || 0);
  command("seek", target, "absolute");
  props["time-pos"] = target;
  render();
});
el.volume.addEventListener("input", () => {
  const volume = Number(el.volume.value);
  el.volume.style.setProperty("--vol", `${volume}%`);
  setProperty("volume", volume);
  if (props.mute && volume > 0) setProperty("mute", false);
});
// keep keyboard focus off the buttons, so Space toggles pause instead of re-clicking the last button
document.addEventListener("click", (e) => {
  if (e.target.closest("button")) document.activeElement?.blur();
});

listen("controls-state", ({ payload }) => {
  props = payload.props;
  enabled = payload.enabled;
  render();
});

// keep the bar up while the mouse is on it
document.documentElement.addEventListener("mouseenter", () => emitTo("main", "controls-hover", true));
document.documentElement.addEventListener("mouseleave", () => emitTo("main", "controls-hover", false));

// once clicked, this window has the keyboard, so handle the player keys here too
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT"].includes(document.activeElement?.tagName) && e.key !== "Escape") return;
  const actions = {
    Escape: leaveFullscreen,
    f: leaveFullscreen,
    " ": togglePause,
    ArrowLeft: () => seekBy(-5),
    ArrowRight: () => seekBy(5),
    ArrowUp: () => changeVolume(5),
    ArrowDown: () => changeVolume(-5),
    m: toggleMute,
    c: toggleSubs,
  };
  const action = actions[e.key];
  if (action) {
    e.preventDefault();
    action();
  }
});

emitTo("main", "controls-ready");
