// Cover art and show details from AniList's public GraphQL API (no account or key needed).
// ani-cli's titles come from a streaming site, so they're matched to AniList by name.
// AniList allows about 30-90 requests a minute, so lookups are batched (one request
// for a whole result list) and cached in localStorage for a week.

const ENDPOINT = "https://graphql.anilist.co";
const CACHE_KEY = "anilist-cache-v2"; // v2: also idMal, for AniSkip
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const BATCH = 10; // titles per request, keeps the query under AniList's complexity limit

const FIELDS = `id idMal title { romaji english native } synonyms popularity
  coverImage { large extraLarge color } bannerImage description(asHtml: false)
  format status episodes duration season seasonYear averageScore genres
  studios(isMain: true) { nodes { name } } nextAiringEpisode { episode airingAt }`;

const FORMATS = { TV: "TV", TV_SHORT: "TV Short", MOVIE: "Movie", SPECIAL: "Special", OVA: "OVA", ONA: "ONA", MUSIC: "Music" };
const STATUSES = { FINISHED: "Finished", RELEASING: "Airing", NOT_YET_RELEASED: "Not yet aired", CANCELLED: "Cancelled", HIATUS: "On hiatus" };

let cache = loadCache();

function loadCache() {
  try {
    localStorage.removeItem("anilist-cache-v1"); // the cache from before idMal
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    const cutoff = Date.now() - CACHE_MS;
    return Object.fromEntries(Object.entries(stored).filter(([, entry]) => entry.at > cutoff));
  } catch {
    return {};
  }
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // storage full or unavailable; lookups still work, they just aren't remembered
  }
}

const norm = (s) => (s || "").toLowerCase().replace(/\([^)]*\)/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** The streaming site's tags that AniList doesn't use, e.g. "(Uncensored)". */
const searchTerm = (title) => title.replace(/\s*\((uncensored|dub|sub|tv)\)/gi, "").trim();

/** A looser form for a second try: no brackets, no "Part 2:", " - " as ":". */
const simplified = (title) =>
  title.replace(/\s*\([^)]*\)/g, "").replace(/\bPart \d+:?\s*/gi, "").replace(/\s+-\s+/g, ": ").replace(/\s{2,}/g, " ").trim();

/** Exact name matches win (most popular first, since e.g. a 1993 OVA and a 2012 series share a name); otherwise the most popular result. */
function pickBest(title, candidates) {
  const want = norm(title);
  const byPopularity = (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0);
  const names = (m) => [m.title.english, m.title.romaji, ...(m.synonyms || [])].map(norm);
  const exact = candidates.filter((m) => names(m).includes(want)).sort(byPopularity);
  return exact[0] ?? [...candidates].sort(byPopularity)[0] ?? null;
}

async function searchMany(terms) {
  const variables = {};
  const params = [];
  const pages = [];
  terms.forEach((term, i) => {
    variables[`s${i}`] = term;
    params.push(`$s${i}: String`);
    pages.push(`r${i}: Page(perPage: 3) { media(search: $s${i}, type: ANIME, sort: SEARCH_MATCH) { ${FIELDS} } }`);
  });
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: `query (${params.join(", ")}) { ${pages.join("\n")} }`, variables }),
  });
  if (!response.ok) throw new Error(`AniList returned HTTP ${response.status}`);
  const { data } = await response.json();
  return terms.map((_, i) => data?.[`r${i}`]?.media ?? []);
}

/** AniList entries for these ani-cli titles, as a Map of title -> media (null when nothing matched). */
export async function lookup(titles) {
  const found = new Map();
  const missing = [];
  for (const title of new Set(titles)) {
    const entry = cache[norm(title)];
    if (entry) found.set(title, entry.media);
    else missing.push(title);
  }

  for (let start = 0; start < missing.length; start += BATCH) {
    const batch = missing.slice(start, start + BATCH);
    const first = await searchMany(batch.map(searchTerm));
    const retry = batch.filter((title, i) => !first[i].length && simplified(title) !== searchTerm(title));
    const second = retry.length ? await searchMany(retry.map(simplified)) : [];
    batch.forEach((title, i) => {
      const r = retry.indexOf(title);
      const media = r >= 0 ? pickBest(simplified(title), second[r]) : pickBest(searchTerm(title), first[i]);
      cache[norm(title)] = { at: Date.now(), media };
      found.set(title, media);
    });
  }
  if (missing.length) saveCache();
  return found;
}

/** AniList descriptions contain <br>, <i> and similar; this returns plain text. */
export function plainDescription(text) {
  if (!text) return "";
  // DOMParser documents never run scripts, so this only extracts text
  const doc = new DOMParser().parseFromString(text.replace(/<br\s*\/?>/gi, "\n"), "text/html");
  return doc.body.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

/** Short facts for the header, e.g. ["TV", "Fall 2023", "Finished", "28 episodes", "★ 9.3", "Madhouse"]. */
export function facts(media) {
  const season = media.season ? media.season[0] + media.season.slice(1).toLowerCase() : "";
  return [
    FORMATS[media.format] ?? media.format,
    [season, media.seasonYear].filter(Boolean).join(" "),
    STATUSES[media.status] ?? media.status,
    media.episodes ? `${media.episodes} episode${media.episodes === 1 ? "" : "s"}` : "",
    media.averageScore ? `★ ${(media.averageScore / 10).toFixed(1)}` : "",
    media.studios?.nodes?.[0]?.name ?? "",
  ].filter(Boolean);
}

/** "Episode 5 airs in 3d 4h", or "" when nothing is scheduled. */
export function nextAiring(media) {
  const next = media.nextAiringEpisode;
  if (!next) return "";
  const seconds = next.airingAt - Date.now() / 1000;
  if (seconds <= 0) return "";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const when = days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
  return `Episode ${next.episode} airs in ${when}`;
}

/** e.g. "2023 · TV" for list rows. */
export function listMeta(media) {
  return [media.seasonYear, FORMATS[media.format] ?? media.format].filter(Boolean).join(" · ");
}
