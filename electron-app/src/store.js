// App state and the ani-cli logic. The main process runs ani-cli and forwards four events
// (ani:output a printed line, ani:menu a menu it's waiting on, ani:stream the episode's
// stream, ani:exit); everything here decides what to answer and what to show. React
// components read the state with useStore() and call the exported actions.

import { useSyncExternalStore } from "react";
import { lookup } from "./anilist.js";

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g;
const PLAYING_RE = /Playing episode (.+?) of (.*?)\.\.\.\s*$/;
export const PAGE_SIZE = 100;
const LOG_LINES = 400;

// ---------- the store ----------

/**
 * Caption look: size (× normal), text colour, background opacity, height above the bottom (% of
 * the video), outline thickness (0-10), font (a key of the player's CAPTION_FONTS) and bold.
 */
export const CAPTION_DEFAULTS = { size: 1, color: "#ffffff", background: 0.6, lift: 7, outline: 4, font: "app", bold: false };

function loadSettings() {
  const defaults = { mode: "sub", quality: "best", autoplay: false, upscaler: "off", captions: CAPTION_DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem("settings") || "{}");
    return { ...defaults, ...saved, captions: { ...defaults.captions, ...saved.captions } };
  } catch {
    return defaults;
  }
}

let state = {
  listMode: "search", // what the left list shows: "search" results or "history"
  listLabel: "Results",
  query: "",
  results: [], // [[number, title]] from ani-cli's "Select anime" menu
  history: [], // [{title, episode}], newest first
  selected: null, // index highlighted in the list
  animeNo: null, // ani-cli's number for the open anime in results
  animeTitle: "",
  title: "Search for an anime to get started",
  info: "Type a name above and press Enter.",
  details: null, // AniList entry for the open show
  covers: {}, // title -> AniList entry, for list thumbnails
  episodes: [],
  currentEp: null,
  watchedUpTo: null,
  page: 0,
  stream: null, // {session, url, subtitles, title} once ani-cli hands one over
  loadingVideo: false,
  playClickedAt: 0,
  nowPlaying: "Nothing playing",
  sessionActive: false,
  status: { text: "Ready", error: false },
  log: [],
  menu: null, // {prompt, options}: an ani-cli menu the app doesn't answer itself
  settings: loadSettings(),
};
const listeners = new Set();

function set(patch) {
  state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
  for (const listener of listeners) listener();
}

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getState = () => state;
export const useStore = () => useSyncExternalStore(subscribe, getState);

// ---------- helpers ----------

export function setStatus(text, error = false) {
  set({ status: { text, error } });
}

export function log(line) {
  set((s) => ({ log: [...s.log, line].slice(-LOG_LINES) }));
}

const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

function pageOf(ep) {
  const i = state.episodes.indexOf(ep);
  return i >= 0 ? Math.floor(i / PAGE_SIZE) : state.page;
}

async function loadHistory() {
  try {
    set({ history: (await window.anicli.history()).reverse() });
  } catch (err) {
    log(`[history unavailable] ${errorText(err)}`);
  }
}

function watchedFor(title) {
  const key = title.toLowerCase();
  return state.history.find((h) => h.title.toLowerCase() === key)?.episode ?? null;
}

async function refreshWatched() {
  await loadHistory();
  set({ watchedUpTo: watchedFor(state.animeTitle) });
}

let detailsFor = null; // the title whose AniList details are wanted right now

async function loadDetails(title) {
  detailsFor = title;
  set({ details: null });
  try {
    const media = (await lookup([title])).get(title);
    if (detailsFor === title && media) set({ details: media });
  } catch (err) {
    log(`[AniList] ${errorText(err)}`);
  }
}

function clearDetails() {
  detailsFor = null;
  set({ details: null });
}

/** Adds AniList covers for these titles (list thumbnails). */
async function loadCovers(titles) {
  try {
    const found = await lookup(titles);
    set((s) => ({ covers: { ...s.covers, ...Object.fromEntries(found) } }));
  } catch (err) {
    log(`[AniList] ${errorText(err)}`);
  }
}

// ---------- ani-cli sessions ----------

let session = null; // {id, settings, pending: {prompt, options} | null, lastLine, alive}
let nextSessionId = 1;
// answers to give ani-cli's next menus without asking (used by History and Next)
let autoTitle = null;
let continueAfter = null;
let autoEpisode = null;
let playbackTime = 0; // where the page's video is, reported by the player
let resumeAt = null; // where the next stream should start, after a Sub/Dub or Quality switch

const settingsKey = () => `${state.settings.mode}|${state.settings.quality}`;

async function startSession(flags, query) {
  const { mode, quality } = state.settings;
  const args = [...flags, "-q", quality, ...(mode === "dub" ? ["--dub"] : []), ...(query ? [query] : [])];
  const id = nextSessionId++;
  session = { id, settings: settingsKey(), pending: null, lastLine: "", alive: true };
  set({ sessionActive: true });
  log("$ ani-cli " + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
  try {
    await window.anicli.start(id, args);
  } catch (err) {
    if (session?.id === id) {
      session = null;
      set({ sessionActive: false });
      setStatus(errorText(err), true);
    }
  }
}

const sessionFor = (id) => (session && session.id === id ? session : null);

function waiting(prefix) {
  return Boolean(session && session.alive && session.settings === settingsKey() && session.pending?.prompt.startsWith(prefix));
}

function answer(text) {
  const s = session;
  s.pending = null;
  window.anicli.answer(s.id, text).catch((err) => log(`[answer failed] ${errorText(err)}`));
}

function onOutput(line) {
  if (line.startsWith("Checking dependencies")) setStatus("Starting ani-cli…");
  else if (line.includes("links fetched")) setStatus("Opening the stream…");
  else setStatus(line);
}

function onMenu(prompt, options) {
  if (prompt.startsWith("Select anime")) {
    const results = options.map((o) => {
      const space = o.indexOf(" ");
      return space > 0 ? [o.slice(0, space), o.slice(space + 1)] : [o, o];
    });
    set({ results });
    let status = `${results.length} results`;
    if (autoTitle) {
      const wanted = autoTitle.toLowerCase();
      autoTitle = null;
      const match = results.findIndex(([, title]) => title.toLowerCase() === wanted);
      if (match >= 0) {
        openAnime(match);
        return;
      }
      continueAfter = null;
      status = "Several matches found. Pick the right one on the left.";
    }
    set({
      listMode: "search",
      listLabel: `Results for “${state.query}”`,
      selected: null,
      title: "Pick an anime",
      info: `${results.length} results. Click one to see its episodes.`,
    });
    clearDetails();
    loadCovers(results.map(([, title]) => title));
    setStatus(status);
  } else if (prompt.startsWith("Select episode")) {
    if (state.animeNo === null) {
      // only one search result, so ani-cli skipped "Select anime"
      autoTitle = null;
      set({ results: [["1", state.query]], animeNo: "1", animeTitle: state.query, title: state.query, info: "" });
      if (state.listMode === "search") set({ listLabel: `Results for “${state.query}”`, selected: 0 });
      loadDetails(state.query);
      loadCovers([state.query]);
      set({ watchedUpTo: watchedFor(state.query) });
    }
    let target = autoEpisode;
    autoEpisode = null;
    if (continueAfter !== null) {
      const after = continueAfter;
      continueAfter = null;
      const i = options.indexOf(after);
      if (i >= 0 && i + 1 < options.length) target = options[i + 1];
      else setStatus(`You're caught up: episode ${after} is the latest one watched.`);
    }
    set({ episodes: options });
    set({ page: pageOf(target ?? state.currentEp ?? state.watchedUpTo) });
    if (target && options.includes(target)) play(target);
    else if (!target) setStatus(`${options.length} episodes. Click one to play it.`);
  } else if (PLAYING_RE.test(prompt)) {
    // ani-cli shows this once the player (here: the episode in the page) is done
    const [, ep, title] = prompt.match(PLAYING_RE);
    set((s) => ({ currentEp: ep, episodes: s.episodes.length ? s.episodes : [ep], stream: null, loadingVideo: false }));
    set({ page: pageOf(ep), nowPlaying: `Finished  ${title}  —  Episode ${ep}` });
    refreshWatched();
    const isLast = state.episodes.indexOf(ep) === state.episodes.length - 1;
    if (state.settings.autoplay && !isLast) step(1);
    else setStatus("Episode finished. Pick another one, or use Next / Replay.");
  } else {
    set({ menu: { prompt, options } });
  }
}

function onSessionEnd(s, code) {
  set({ sessionActive: false, stream: null, loadingVideo: false, nowPlaying: "Nothing playing" });
  if (code !== 0) {
    const message = s.lastLine || "ani-cli stopped unexpectedly.";
    setStatus(message, true);
    if (!state.episodes.length && state.listMode === "search" && !state.results.length) {
      clearDetails();
      set({ title: "Nothing found", info: message });
    }
  } else {
    setStatus("Ready");
  }
}

window.anicli.on("ani:output", ({ session: id, line }) => {
  const s = sessionFor(id);
  if (!s) return;
  const clean = line.replace(ANSI_RE, "").trim();
  if (!clean || clean.startsWith("tput:")) return;
  s.lastLine = clean;
  log(clean);
  onOutput(clean);
});

window.anicli.on("ani:menu", ({ session: id, prompt, options }) => {
  const s = sessionFor(id);
  if (!s) return;
  s.pending = { prompt, options };
  log(`[menu] ${prompt} (${options.length} options)`);
  onMenu(prompt, options);
});

window.anicli.on("ani:stream", (payload) => {
  if (!sessionFor(payload.session)) return;
  log(`[stream] ${payload.title}`);
  set({ stream: { ...payload, startAt: resumeAt }, loadingVideo: false, nowPlaying: `▶  ${payload.title || state.animeTitle}` });
  resumeAt = null;
  setStatus("Loading the video…");
});

window.anicli.on("ani:exit", ({ session: id, code, killed }) => {
  const s = sessionFor(id);
  if (!s) return;
  log(`[ani-cli exited with code ${code}]`);
  s.alive = false;
  session = null;
  if (!killed) onSessionEnd(s, code);
});

// ---------- actions ----------

export function search(query) {
  query = query.trim();
  if (!query) return;
  autoTitle = continueAfter = autoEpisode = null;
  set({
    query,
    results: [],
    episodes: [],
    animeNo: null,
    animeTitle: "",
    currentEp: null,
    listMode: "search",
    listLabel: `Results for “${query}”`,
    selected: null,
    title: `Searching for “${query}”…`,
    info: "",
  });
  clearDetails();
  startSession([], query);
}

export async function showHistory() {
  await refreshWatched();
  set({ listMode: "history", listLabel: "Watch history", selected: null });
  loadCovers(state.history.map((h) => h.title));
  setStatus(state.history.length
    ? "Click a show to continue from the episode after the one you last watched."
    : "No watch history yet.");
}

export function selectListItem(index) {
  set({ selected: index });
  if (state.listMode === "history") {
    const { title, episode } = state.history[index];
    autoTitle = title;
    continueAfter = episode;
    autoEpisode = null;
    set({
      query: title,
      results: [],
      episodes: [],
      animeNo: null,
      animeTitle: title,
      currentEp: null,
      watchedUpTo: episode,
      title,
      info: `Last watched episode ${episode}. Finding the next one…`,
    });
    loadDetails(title);
    startSession([], title);
  } else {
    openAnime(index);
  }
}

function openAnime(index) {
  const [number, title] = state.results[index];
  if (number === state.animeNo && state.episodes.length) return;
  set({
    animeNo: number,
    animeTitle: title,
    episodes: [],
    currentEp: null,
    watchedUpTo: watchedFor(title),
    title,
    info: "Loading episodes…",
  });
  loadDetails(title);
  if (waiting("Select anime")) answer(number);
  else startSession(["-S", number], state.query);
}

export function play(ep) {
  if (state.animeNo === null) return;
  resumeAt = null;
  set({
    currentEp: ep,
    page: pageOf(ep),
    stream: null,
    loadingVideo: true,
    playClickedAt: performance.now(),
    nowPlaying: `Loading  ${state.animeTitle}  —  Episode ${ep}…`,
  });
  if (waiting("Select episode")) {
    answer(ep);
  } else if (waiting("Playing episode")) {
    // back to ani-cli's episode menu; onMenu answers it with this episode
    autoEpisode = ep;
    answer("select");
  } else {
    startSession(["-S", state.animeNo, "-e", ep], state.query);
  }
}

export function step(delta) {
  const i = state.episodes.indexOf(state.currentEp) + delta;
  if (state.currentEp !== null && i >= 0 && i < state.episodes.length) play(state.episodes[i]);
}

export function replay() {
  if (state.currentEp) play(state.currentEp);
}

export async function stop() {
  session = null;
  set({ sessionActive: false, stream: null, loadingVideo: false, nowPlaying: "Nothing playing" });
  await window.anicli.stop();
  setStatus("Stopped");
  refreshWatched();
}

export function setPage(page) {
  set({ page });
}

export function setSetting(key, value) {
  const before = state.settings[key];
  set((s) => ({ settings: { ...s.settings, [key]: value } }));
  try {
    localStorage.setItem("settings", JSON.stringify(state.settings));
  } catch {
    // storage unavailable; settings just won't be remembered
  }
  // Sub/Dub or Quality changed mid-episode: load the episode again that way, from the same point
  if ((key === "mode" || key === "quality") && value !== before && state.currentEp && (state.stream || state.loadingVideo)) {
    const at = state.stream ? playbackTime : null;
    replay();
    resumeAt = at;
  }
}

/** The player reports its position, so a Sub/Dub switch can carry on from it. */
export function videoTime(seconds) {
  playbackTime = seconds;
}

/** The episode playing in the page has ended: ani-cli moves on to its after-playback menu. */
export function videoEnded() {
  if (state.stream) window.anicli.finish(state.stream.session);
}

/** The first frame is up; reports how long that took after the click. */
export function videoStarted() {
  if (!state.playClickedAt) return;
  const seconds = (performance.now() - state.playClickedAt) / 1000;
  set({ playClickedAt: 0 });
  setStatus(`Playing. Started ${seconds.toFixed(1)} s after clicking.`);
  log(`[player] started after ${seconds.toFixed(1)} s`);
}

/** Answers a menu shown in the dialog (an empty choice cancels it). */
export function answerMenu(choice) {
  set({ menu: null });
  if (session?.alive) answer(choice);
}

// ---------- startup ----------

loadHistory();
window.anicli.environment().then((env) => {
  if (!env.shellFound) setStatus(env.noShell, true);
});
