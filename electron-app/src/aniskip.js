// Opening, ending and recap times from AniSkip (https://aniskip.com, the database behind
// ani-skip and ani-cli's --skip), looked up by MyAnimeList id (from AniList) and episode.
// Its timings are submitted for a given cut of an episode, so where there are several, the
// one whose episode length is closest to the video that's playing is used.

const ENDPOINT = "https://api.aniskip.com/v2/skip-times";
const KINDS = { op: "intro", "mixed-op": "intro", ed: "outro", "mixed-ed": "outro", recap: "recap" };
const cache = new Map(); // "malId/episode" -> promise of the API's results

function fetchResults(malId, episode) {
  const key = `${malId}/${episode}`;
  if (!cache.has(key)) {
    const types = Object.keys(KINDS).map((t) => `types[]=${t}`).join("&");
    const request = fetch(`${ENDPOINT}/${malId}/${episode}?${types}&episodeLength=0`)
      .then((response) => (response.ok || response.status === 404 ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
      .then((data) => (data.found ? data.results : []));
    request.catch(() => cache.delete(key)); // try again next time
    cache.set(key, request);
  }
  return cache.get(key);
}

/**
 * The parts of this episode to skip, as [{ kind: "intro" | "outro" | "recap", start, end }]
 * in seconds, sorted by start. `duration` is the playing video's length.
 */
export async function skipTimes(malId, episode, duration) {
  const number = Number(episode);
  if (!malId || !Number.isInteger(number) || number < 1) return [];
  const best = new Map(); // kind -> closest result
  for (const result of await fetchResults(malId, number)) {
    const kind = KINDS[result.skipType];
    const off = Math.abs((result.episodeLength || duration) - duration);
    if (kind && (!best.has(kind) || off < best.get(kind).off)) best.set(kind, { result, off });
  }
  return [...best.entries()]
    .map(([kind, { result }]) => ({ kind, start: result.interval.startTime, end: result.interval.endTime }))
    .filter((part) => part.end > part.start)
    .sort((a, b) => a.start - b.start);
}
