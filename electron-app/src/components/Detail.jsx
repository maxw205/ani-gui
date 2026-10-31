import { useEffect, useRef, useState } from "react";
import { facts, nextAiring, plainDescription } from "../anilist.js";
import { PAGE_SIZE, play, setPage, useStore } from "../store.js";
import Player from "./Player.jsx";

/** The right-hand panel: the player while an episode plays, the show's details and its episodes. */
export default function Detail() {
  const s = useStore();
  const playing = Boolean(s.stream || s.loadingVideo);
  const media = s.details;
  return (
    <section className={`panel detail ${playing ? "playing" : ""}`}
      style={media?.coverImage?.color ? { "--show-color": media.coverImage.color } : undefined}>
      <div className="detail-scroll">
        {playing && <Player />}
        {!playing && media?.bannerImage && <div className="banner" style={{ backgroundImage: `url(${JSON.stringify(media.bannerImage)})` }} />}
        {!playing && (
          <div className="detail-head">
            {media && <img className="cover" alt="" src={media.coverImage.extraLarge || media.coverImage.large} />}
            <div className="detail-text">
              <h1>{s.title}</h1>
              {media && <ShowDetails media={media} shownTitle={s.title} />}
            </div>
          </div>
        )}
        <Episodes />
      </div>
    </section>
  );
}

function ShowDetails({ media, shownTitle }) {
  // AniList often differs only in punctuation (’ vs '), which shouldn't count as another name
  const key = (name) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const otherNames = [...new Set([media.title.english, media.title.romaji, media.title.native]
    .filter((n) => n && key(n) !== key(shownTitle)))].slice(0, 2);
  const airing = nextAiring(media);
  return (
    <>
      {otherNames.length > 0 && <p className="alt-title">{otherNames.join("  ·  ")}</p>}
      <div className="chips">{facts(media).map((f) => <span key={f}>{f}</span>)}</div>
      {media.genres?.length > 0 && <div className="chips genres">{media.genres.map((g) => <span key={g}>{g}</span>)}</div>}
      {airing && <p className="airing">{airing}</p>}
      <Description text={plainDescription(media.description)} />
    </>
  );
}

/** The synopsis, clamped to four lines with More/Less when it's longer. */
function Description({ text }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    setExpanded(false);
    const el = ref.current;
    if (el) setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  if (!text) return null;
  return (
    <div className="desc-wrap">
      <p ref={ref} className={`desc ${expanded ? "expanded" : ""}`}>{text}</p>
      {(clamped || expanded) && (
        <button type="button" className="ghost link" onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "More"}</button>
      )}
    </div>
  );
}

function Episodes() {
  const s = useStore();
  const eps = s.episodes;
  const pages = Math.ceil(eps.length / PAGE_SIZE);
  const page = Math.min(s.page, Math.max(pages - 1, 0));
  const watched = eps.indexOf(s.watchedUpTo);
  const start = page * PAGE_SIZE;
  let info = s.info;
  if (eps.length) {
    info = `${eps.length} episodes · ${s.settings.mode}`;
    if (watched >= 0) info += ` · watched up to episode ${s.watchedUpTo}`;
  }
  return (
    <>
      <div className="ep-bar">
        <p className="muted">{info}</p>
        {s.details && <span className="credit">Details from AniList</span>}
        {pages > 1 && (
          <select aria-label="Episode range" value={page} onChange={(e) => setPage(Number(e.target.value))}>
            {Array.from({ length: pages }, (_, p) => (
              <option key={p} value={p}>{eps[p * PAGE_SIZE]} – {eps[Math.min((p + 1) * PAGE_SIZE, eps.length) - 1]}</option>
            ))}
          </select>
        )}
      </div>
      <div className="episodes">
        {eps.slice(start, start + PAGE_SIZE).map((ep, j) => {
          const cls = ep === s.currentEp ? "current" : start + j <= watched ? "watched" : "";
          return <button key={ep} type="button" className={`ep ${cls}`} onClick={() => play(ep)}>{ep}</button>;
        })}
      </div>
    </>
  );
}
