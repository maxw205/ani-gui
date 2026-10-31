import { listMeta } from "../anilist.js";
import { selectListItem, useStore } from "../store.js";

/** Search results or watch history, with AniList covers. */
export default function ResultList() {
  const s = useStore();
  const items = s.listMode === "history"
    ? s.history.map((h) => ({ title: h.title, meta: `Watched up to ep ${h.episode}` }))
    : s.results.map(([, title]) => ({ title, meta: s.covers[title] ? listMeta(s.covers[title]) : "" }));
  return (
    <aside className="panel list-panel">
      <div className="panel-label">{s.listLabel}</div>
      <ul className="list">
        {items.map((item, i) => {
          const cover = s.covers[item.title]?.coverImage?.large;
          return (
            <li key={`${i}-${item.title}`} title={item.title} className={s.selected === i ? "selected" : ""}
              onClick={() => selectListItem(i)}>
              <div className="thumb" style={cover ? { backgroundImage: `url(${JSON.stringify(cover)})` } : undefined} />
              <div className="item-text">
                <span className="item-title">{item.title}</span>
                {item.meta && <span className="item-meta">{item.meta}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
