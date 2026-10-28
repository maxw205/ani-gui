// AnimeCLI window. The Rust side runs ani-cli and forwards three events:
// ani-output (a line it printed), ani-menu (a menu it is waiting on) and ani-exit.
// Everything here decides what to answer and what to show.

import { facts, listMeta, lookup, nextAiring, plainDescription } from "./anilist.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g;
const PLAYING_RE = /Playing episode (.+?) of (.*?)\.\.\.\s*$/;
const PAGE_SIZE = 100;
const LOG_LIMIT = 200_000;

// shader files bundled with the app (src-tauri/shaders), by Upscaler menu value
const UPSCALERS = {
  off: [],
  "c4f32": ["ArtCNN_C4F32.glsl"],
  "c4f32-ds": ["ArtCNN_C4F32_DS.glsl"],
  "c4f32-dn": ["ArtCNN_C4F32_DN.glsl"],
  "c4f16": ["ArtCNN_C4F16.glsl"],
  "c4f16-ds": ["ArtCNN_C4F16_DS.glsl"],
  "c4f16-dn": ["ArtCNN_C4F16_DN.glsl"],
};

const $ = (id) => document.getElementById(id);
const el = {
  searchForm: $("search-form"), search: $("search"), historyBtn: $("history-btn"),
  modeButtons: [...document.querySelectorAll("[data-mode]")], quality: $("quality"),
  upscaler: $("upscaler"), upscaleHint: $("upscale-hint"), fullscreen: $("fullscreen"),
  listLabel: $("list-label"), list: $("list"),
  title: $("title"), info: $("info"), page: $("page"), episodes: $("episodes"),
  detail: $("detail"), banner: $("banner"), cover: $("cover"), altTitle: $("alt-title"),
  facts: $("facts"), genres: $("genres"), airing: $("airing"),
  descWrap: $("desc-wrap"), desc: $("desc"), descToggle: $("desc-toggle"), credit: $("credit"),
  now: $("now"), autoplay: $("autoplay"),
  prev: $("prev"), replay: $("replay"), next: $("next"), stop: $("stop"),
  status: $("status"), logBtn: $("log-btn"), log: $("log"),
  menuDialog: $("menu-dialog"), menuPrompt: $("menu-prompt"), menuOptions: $("menu-options"),
};

const state = {
  session: null, // { id, settings, pending: {prompt, options} | null, lastLine, alive }
  listMode: "search", // what the left list shows: "search" results or "history"
  query: "",
  results: [], // [[number, title]] from ani-cli's "Select anime" menu
  history: [], // [{title, episode}], newest first
  animeNo: null, // ani-cli's number for the open anime in state.results
  animeTitle: "",
  episodes: [],
  currentEp: null,
  watchedUpTo: null,
  page: 0,
  // answers to give ani-cli's next menus without asking (used by History)
  autoTitle: null,
  continueAfter: null,
  autoEpisode: null,
};
let nextSessionId = 1;

// ---------- settings ----------

function currentMode() {
  return el.modeButtons.find((b) => b.getAttribute("aria-checked") === "true").dataset.mode;
}

function setMode(mode) {
  for (const b of el.modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === mode));
}

function settingsKey() {
  return `${currentMode()}|${el.quality.value}`;
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("settings") || "{}");
    if (saved.mode) setMode(saved.mode);
    if (saved.quality) el.quality.value = saved.quality;
    if (saved.upscaler in UPSCALERS) el.upscaler.value = saved.upscaler;
    el.autoplay.checked = Boolean(saved.autoplay);
    el.fullscreen.checked = Boolean(saved.fullscreen);
  } catch {
    // no stored settings in this profile, defaults are fine
  }
}

function saveSettings() {
  try {
    localStorage.setItem("settings", JSON.stringify({
      mode: currentMode(),
      quality: el.quality.value,
      upscaler: el.upscaler.value,
      autoplay: el.autoplay.checked,
      fullscreen: el.fullscreen.checked,
    }));
  } catch {
    // storage unavailable; settings just won't be remembered
  }
}

function updateUpscaleHint() {
  // ArtCNN only runs when mpv upscales by 1.3x or more, which a 1080p stream never needs on a 1080p screen
  el.upscaleHint.hidden = el.upscaler.value === "off" || !["best", "1080"].includes(el.quality.value);
}

/** Tells the backend which shaders mpv should use; it switches an open player immediately. */
async function applyUpscaler(announce) {
  updateUpscaleHint();
  const id = el.upscaler.value;
  try {
    const live = await invoke("set_upscaler", { shaders: UPSCALERS[id] ?? [] });
    if (!announce) return;
    const name = `ArtCNN ${el.upscaler.selectedOptions[0].textContent}`;
    if (id === "off") setStatus(live ? "Upscaler turned off for the playing episode." : "Upscaler off.");
    else setStatus(live ? `${name} applied to the playing episode.` : `${name} will be used for the episodes you play.`);
  } catch (err) {
    setStatus(String(err), true);
  }
}

// ---------- UI helpers ----------

function setStatus(text, error = false) {
  el.status.textContent = text;
  el.status.classList.toggle("error", error);
  el.status.classList.toggle("muted", !error);
}

function log(line) {
  let text = el.log.textContent + line + "\n";
  if (text.length > LOG_LIMIT) text = text.slice(text.length - LOG_LIMIT / 2);
  el.log.textContent = text;
  el.log.scrollTop = el.log.scrollHeight;
}

let listToken = 0; // bumped on every refill so late cover lookups don't decorate the wrong list

function fillList(label, items) {
  listToken++;
  el.listLabel.textContent = label;
  el.list.replaceChildren(...items.map((item, i) => {
    const li = document.createElement("li");
    li.dataset.index = i;
    li.title = item.title;
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    const text = document.createElement("div");
    text.className = "item-text";
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "item-meta";
    meta.textContent = item.meta ?? "";
    text.append(title, meta);
    li.append(thumb, text);
    return li;
  }));
}

/** Adds AniList covers (and, for search results, year and format) to the rows of the current list. */
async function decorateList(titles, withMeta) {
  const token = listToken;
  let found;
  try {
    found = await lookup(titles);
  } catch (err) {
    log(`[AniList] ${err.message}`);
    return;
  }
  if (token !== listToken) return;
  [...el.list.children].forEach((li, i) => {
    const media = found.get(titles[i]);
    if (!media) return;
    li.querySelector(".thumb").style.backgroundImage = `url(${JSON.stringify(media.coverImage.large)})`;
    if (withMeta) li.querySelector(".item-meta").textContent = listMeta(media);
  });
}

let detailsFor = null; // the title whose AniList details are wanted right now

function clearDetails() {
  detailsFor = null;
  for (const node of [el.banner, el.cover, el.altTitle, el.facts, el.genres, el.airing, el.descWrap, el.credit]) node.hidden = true;
  el.detail.style.removeProperty("--show-color");
  el.detail.scrollTop = 0;
}

async function loadDetails(title) {
  clearDetails();
  detailsFor = title;
  let media;
  try {
    media = (await lookup([title])).get(title);
  } catch (err) {
    log(`[AniList] ${err.message}`);
    return;
  }
  if (detailsFor === title && media) renderDetails(media);
}

function setChips(container, items) {
  container.replaceChildren(...items.map((text) => {
    const chip = document.createElement("span");
    chip.textContent = text;
    return chip;
  }));
  container.hidden = !items.length;
}

function renderDetails(media) {
  if (media.coverImage?.color) el.detail.style.setProperty("--show-color", media.coverImage.color);
  if (media.bannerImage) {
    el.banner.style.backgroundImage = `url(${JSON.stringify(media.bannerImage)})`;
    el.banner.hidden = false;
  }
  el.cover.src = media.coverImage.extraLarge || media.coverImage.large;
  el.cover.hidden = false;

  // AniList often differs only in punctuation (’ vs '), which shouldn't count as another name
  const key = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const shown = key(el.title.textContent);
  const otherNames = [media.title.english, media.title.romaji, media.title.native].filter((n) => n && key(n) !== shown);
  el.altTitle.textContent = [...new Set(otherNames)].slice(0, 2).join("  ·  ");
  el.altTitle.hidden = !otherNames.length;

  setChips(el.facts, facts(media));
  setChips(el.genres, media.genres ?? []);
  const airing = nextAiring(media);
  el.airing.textContent = airing;
  el.airing.hidden = !airing;

  const description = plainDescription(media.description);
  el.desc.textContent = description;
  el.desc.classList.remove("expanded");
  el.descToggle.textContent = "More";
  el.descWrap.hidden = !description;
  // only offer "More" when the clamp actually cut something off
  requestAnimationFrame(() => {
    el.descToggle.hidden = el.desc.scrollHeight <= el.desc.clientHeight + 1;
  });
  el.credit.hidden = false;
}

function selectListItem(index) {
  for (const li of el.list.children) li.classList.toggle("selected", Number(li.dataset.index) === index);
}

function showAnime(title, info) {
  el.title.textContent = title;
  el.info.textContent = info;
}

function pageOf(ep) {
  const i = state.episodes.indexOf(ep);
  return i >= 0 ? Math.floor(i / PAGE_SIZE) : state.page;
}

function renderEpisodes() {
  const eps = state.episodes;
  const pages = Math.ceil(eps.length / PAGE_SIZE);
  if (pages > 1) {
    state.page = Math.min(state.page, pages - 1);
    el.page.replaceChildren(...Array.from({ length: pages }, (_, p) => {
      const first = eps[p * PAGE_SIZE];
      const last = eps[Math.min((p + 1) * PAGE_SIZE, eps.length) - 1];
      return new Option(`${first} – ${last}`, String(p));
    }));
    el.page.value = String(state.page);
    el.page.hidden = false;
  } else {
    state.page = 0;
    el.page.hidden = true;
  }

  const watched = eps.indexOf(state.watchedUpTo);
  const start = state.page * PAGE_SIZE;
  el.episodes.replaceChildren(...eps.slice(start, start + PAGE_SIZE).map((ep, j) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ep";
    if (ep === state.currentEp) button.classList.add("current");
    else if (start + j <= watched) button.classList.add("watched");
    button.textContent = ep;
    button.dataset.ep = ep;
    return button;
  }));

  if (eps.length) {
    let info = `${eps.length} episodes · ${currentMode()}`;
    if (watched >= 0) info += ` · watched up to episode ${state.watchedUpTo}`;
    el.info.textContent = info;
  }
}

function updateControls() {
  const i = state.episodes.indexOf(state.currentEp);
  el.prev.disabled = !(i > 0);
  el.next.disabled = !(i >= 0 && i < state.episodes.length - 1);
  el.replay.disabled = i < 0;
  el.stop.disabled = !state.session;
}

async function loadHistory() {
  try {
    state.history = (await invoke("read_history")).reverse();
  } catch (err) {
    log(`[history unavailable] ${err}`);
  }
}

function refreshWatched() {
  const title = state.animeTitle.toLowerCase();
  state.watchedUpTo = state.history.find((h) => h.title.toLowerCase() === title)?.episode ?? null;
}

// ---------- ani-cli sessions ----------

async function startSession(flags, query) {
  const mode = currentMode();
  const args = [...flags, "-q", el.quality.value, ...(mode === "dub" ? ["--dub"] : []), ...(query ? [query] : [])];
  const id = nextSessionId++;
  state.session = { id, settings: settingsKey(), pending: null, lastLine: "", alive: true };
  log("$ ani-cli " + args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "));
  try {
    await invoke("start_session", { id, args });
  } catch (err) {
    if (state.session?.id === id) {
      state.session = null;
      setStatus(String(err), true);
    }
  }
}

async function stopSession() {
  if (state.session) {
    state.session = null;
    await invoke("stop_session");
  }
}

function sessionFor(id) {
  return state.session && state.session.id === id ? state.session : null;
}

function waiting(prefix) {
  const s = state.session;
  return Boolean(s && s.alive && s.settings === settingsKey() && s.pending?.prompt.startsWith(prefix));
}

function answer(text) {
  const s = state.session;
  s.pending = null;
  invoke("answer", { session: s.id, text }).catch((err) => log(`[answer failed] ${err}`));
}

function onOutput(line) {
  if (line.startsWith("Checking dependencies")) {
    setStatus("Starting ani-cli…");
  } else if (line.includes("links fetched")) {
    setStatus("Opening mpv…  (close the player when you're done)");
    if (state.currentEp) el.now.textContent = `▶  ${state.animeTitle}  —  Episode ${state.currentEp}`;
  } else {
    setStatus(line);
  }
}

async function onMenu(prompt, options) {
  if (prompt.startsWith("Select anime")) {
    state.results = options.map((o) => {
      const space = o.indexOf(" ");
      return space > 0 ? [o.slice(0, space), o.slice(space + 1)] : [o, o];
    });
    let status = `${state.results.length} results`;
    if (state.autoTitle) {
      const wanted = state.autoTitle.toLowerCase();
      state.autoTitle = null;
      const match = state.results.findIndex(([, title]) => title.toLowerCase() === wanted);
      if (match >= 0) {
        openAnime(match);
        return;
      }
      state.continueAfter = null;
      status = "Several matches found. Pick the right one on the left.";
    }
    state.listMode = "search";
    fillList(`Results for “${state.query}”`, state.results.map(([, title]) => ({ title })));
    decorateList(state.results.map(([, title]) => title), true);
    clearDetails();
    showAnime("Pick an anime", `${state.results.length} results. Click one to see its episodes.`);
    setStatus(status);
  } else if (prompt.startsWith("Select episode")) {
    if (state.animeNo === null) {
      // only one search result, so ani-cli skipped "Select anime"
      state.autoTitle = null;
      state.results = [["1", state.query]];
      state.animeNo = "1";
      state.animeTitle = state.query;
      if (state.listMode === "search") {
        fillList(`Results for “${state.query}”`, [{ title: state.query }]);
        selectListItem(0);
        decorateList([state.query], true);
      }
      showAnime(state.animeTitle, "");
      loadDetails(state.animeTitle);
      refreshWatched();
    }
    state.episodes = options;
    let target = state.autoEpisode;
    state.autoEpisode = null;
    if (state.continueAfter !== null) {
      const after = state.continueAfter;
      state.continueAfter = null;
      const i = options.indexOf(after);
      if (i >= 0 && i + 1 < options.length) target = options[i + 1];
      else setStatus(`You're caught up: episode ${after} is the latest one watched.`);
    }
    state.page = pageOf(target ?? state.currentEp ?? state.watchedUpTo);
    renderEpisodes();
    if (target && options.includes(target)) play(target);
    else if (!target) setStatus(`${options.length} episodes. Click one to play it.`);
  } else if (PLAYING_RE.test(prompt)) {
    const [, ep, title] = prompt.match(PLAYING_RE);
    state.currentEp = ep;
    if (!state.episodes.length) state.episodes = [ep];
    await loadHistory();
    refreshWatched();
    state.page = pageOf(ep);
    renderEpisodes();
    el.now.textContent = `Finished  ${title}  —  Episode ${ep}`;
    const isLast = state.episodes.indexOf(ep) === state.episodes.length - 1;
    if (el.autoplay.checked && !isLast) step(1);
    else setStatus("Player closed. Pick another episode, or use Next / Replay.");
  } else {
    askGeneric(prompt, options);
  }
}

function onSessionEnd(session, code) {
  el.now.textContent = "Nothing playing";
  if (code !== 0) {
    const message = session.lastLine || "ani-cli stopped unexpectedly.";
    setStatus(message, true);
    if (!state.episodes.length && state.listMode === "search" && !state.results.length) {
      clearDetails();
      showAnime("Nothing found", message);
    }
  } else {
    setStatus("Ready");
  }
}

/** Any other ani-cli menu: show its options in a small dialog. */
function askGeneric(prompt, options) {
  const session = state.session;
  el.menuPrompt.textContent = prompt;
  el.menuOptions.replaceChildren(...options.map((o) => new Option(o, o)));
  el.menuDialog.onclose = () => {
    const choice = el.menuDialog.returnValue === "ok" ? el.menuOptions.value : "";
    if (session === state.session && session.alive) answer(choice);
  };
  el.menuDialog.showModal();
}

listen("ani-output", ({ payload }) => {
  const session = sessionFor(payload.session);
  if (!session) return;
  const line = payload.line.replace(ANSI_RE, "").replace(/\r/g, "").trim();
  if (!line || line.startsWith("tput:")) return;
  session.lastLine = line;
  log(line);
  onOutput(line);
});

listen("ani-menu", ({ payload }) => {
  const session = sessionFor(payload.session);
  if (!session) return;
  session.pending = { prompt: payload.prompt, options: payload.options };
  log(`[menu] ${payload.prompt} (${payload.options.length} options)`);
  onMenu(payload.prompt, payload.options);
});

listen("ani-exit", ({ payload }) => {
  const session = sessionFor(payload.session);
  if (!session) return;
  log(`[ani-cli exited with code ${payload.code}]`);
  session.alive = false;
  state.session = null;
  if (!payload.killed) onSessionEnd(session, payload.code);
});

// ---------- actions ----------

function search() {
  const query = el.search.value.trim();
  if (!query) return;
  state.query = query;
  state.results = [];
  state.episodes = [];
  state.animeNo = null;
  state.animeTitle = "";
  state.currentEp = null;
  state.autoTitle = state.continueAfter = state.autoEpisode = null;
  state.listMode = "search";
  fillList(`Results for “${query}”`, []);
  renderEpisodes();
  clearDetails();
  showAnime(`Searching for “${query}”…`, "");
  startSession([], query);
}

async function refreshWatchedFromDisk() {
  await loadHistory();
  refreshWatched();
  if (state.episodes.length) renderEpisodes();
}

async function showHistory() {
  await refreshWatchedFromDisk();
  state.listMode = "history";
  fillList("Watch history", state.history.map((h) => ({ title: h.title, meta: `Watched up to ep ${h.episode}` })));
  decorateList(state.history.map((h) => h.title), false);
  setStatus(state.history.length
    ? "Click a show to continue from the episode after the one you last watched."
    : "No watch history yet.");
}

function onListSelect(index) {
  if (state.listMode === "history") {
    const { title, episode } = state.history[index];
    state.query = title;
    state.results = [];
    state.episodes = [];
    state.animeNo = null;
    state.animeTitle = title;
    state.currentEp = null;
    state.autoTitle = title;
    state.continueAfter = episode;
    state.autoEpisode = null;
    renderEpisodes();
    showAnime(title, `Last watched episode ${episode}. Finding the next one…`);
    loadDetails(title);
    startSession([], title);
  } else {
    openAnime(index);
  }
}

function openAnime(index) {
  const [number, title] = state.results[index];
  if (number === state.animeNo && state.episodes.length) return;
  state.animeNo = number;
  state.animeTitle = title;
  state.episodes = [];
  state.currentEp = null;
  refreshWatched();
  renderEpisodes();
  showAnime(title, "Loading episodes…");
  loadDetails(title);
  if (waiting("Select anime")) answer(number);
  else startSession(["-S", number], state.query);
}

function play(ep) {
  if (state.animeNo === null) return;
  state.currentEp = ep;
  state.page = pageOf(ep);
  renderEpisodes();
  el.now.textContent = `Loading  ${state.animeTitle}  —  Episode ${ep}…`;
  if (waiting("Select episode")) {
    answer(ep);
  } else if (waiting("Playing episode")) {
    // back to ani-cli's episode menu; onMenu answers it with this episode
    state.autoEpisode = ep;
    answer("select");
  } else {
    startSession(["-S", state.animeNo, "-e", ep], state.query);
  }
}

function step(delta) {
  const i = state.episodes.indexOf(state.currentEp) + delta;
  if (state.currentEp !== null && i >= 0 && i < state.episodes.length) play(state.episodes[i]);
}

function replay() {
  if (state.currentEp) play(state.currentEp);
}

async function stop() {
  await stopSession();
  el.now.textContent = "Nothing playing";
  setStatus("Stopped");
  await refreshWatchedFromDisk();
}

// ---------- wiring ----------

el.searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  search();
});
el.historyBtn.addEventListener("click", showHistory);
el.list.addEventListener("click", (e) => {
  const li = e.target.closest("li");
  if (!li) return;
  const index = Number(li.dataset.index);
  selectListItem(index);
  onListSelect(index);
});
el.episodes.addEventListener("click", (e) => {
  const button = e.target.closest("button.ep");
  if (button) play(button.dataset.ep);
});
el.page.addEventListener("change", () => {
  state.page = Number(el.page.value);
  renderEpisodes();
  el.page.scrollIntoView({ block: "nearest" });
});
el.descToggle.addEventListener("click", () => {
  const expanded = el.desc.classList.toggle("expanded");
  el.descToggle.textContent = expanded ? "Less" : "More";
});
el.cover.addEventListener("error", () => {
  el.cover.hidden = true;
});
for (const b of el.modeButtons) {
  b.addEventListener("click", () => {
    setMode(b.dataset.mode);
    saveSettings();
    if (state.episodes.length) renderEpisodes();
  });
}
el.quality.addEventListener("change", () => {
  saveSettings();
  updateUpscaleHint();
});
el.upscaler.addEventListener("change", () => {
  saveSettings();
  applyUpscaler(true);
});
el.upscaleHint.addEventListener("click", () => {
  el.quality.value = "720";
  saveSettings();
  updateUpscaleHint();
  setStatus("Quality set to 720p, so ArtCNN can upscale it (best in fullscreen). Applies from the next episode you start.");
});
el.fullscreen.addEventListener("change", () => {
  saveSettings();
  invoke("set_fullscreen", { on: el.fullscreen.checked });
});
el.autoplay.addEventListener("change", saveSettings);
el.prev.addEventListener("click", () => step(-1));
el.next.addEventListener("click", () => step(1));
el.replay.addEventListener("click", replay);
el.stop.addEventListener("click", stop);
el.logBtn.addEventListener("click", () => {
  el.log.hidden = !el.log.hidden;
  el.logBtn.textContent = el.log.hidden ? "Show log" : "Hide log";
  el.log.scrollTop = el.log.scrollHeight;
});
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey && e.key === "f") || (e.key === "/" && document.activeElement !== el.search)) {
    e.preventDefault();
    el.search.focus();
    el.search.select();
  }
});

loadSettings();
applyUpscaler(false);
invoke("set_fullscreen", { on: el.fullscreen.checked });
setInterval(updateControls, 200);
updateControls();
loadHistory();
invoke("environment").then((env) => {
  if (!env.bash_found) setStatus("Git Bash was not found, so ani-cli can't run. Install Git for Windows.", true);
});
