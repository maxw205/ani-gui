import { useEffect, useRef, useState } from "react";
import Detail from "./components/Detail.jsx";
import ResultList from "./components/ResultList.jsx";
import {
  answerMenu, replay, search, setSetting, showHistory, step, stop, useStore,
} from "./store.js";
import { isTyping } from "./util.js";

const QUALITIES = [["best", "best"], ["1080", "1080p"], ["720", "720p"], ["480", "480p"], ["360", "360p"], ["worst", "worst"]];

export default function App() {
  const s = useStore();
  return (
    <>
      <TopBar settings={s.settings} />
      <main className="body">
        <ResultList />
        <Detail />
      </main>
      <footer>
        <PlayerBar />
        <StatusBar />
      </footer>
      {s.menu && <MenuDialog menu={s.menu} />}
    </>
  );
}

function TopBar({ settings }) {
  const [query, setQuery] = useState("");
  const input = useRef(null);
  // Ctrl+F or / jumps to the search box
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey && e.key === "f") || (e.key === "/" && document.activeElement !== input.current && !isTyping())) {
        e.preventDefault();
        input.current.focus();
        input.current.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="topbar">
      <div className="brand">AnimeCLI</div>
      <form className="search" onSubmit={(e) => { e.preventDefault(); search(query); }}>
        <input ref={input} type="search" placeholder="Search anime…" spellCheck={false} autoFocus
          value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="primary" type="submit">Search</button>
      </form>
      <button type="button" onClick={showHistory}>History</button>
      <div className="options">
        <div className="segmented" role="radiogroup" aria-label="Audio">
          {["sub", "dub"].map((mode) => (
            <button key={mode} type="button" role="radio" aria-checked={settings.mode === mode}
              onClick={() => setSetting("mode", mode)}>{mode === "sub" ? "Sub" : "Dub"}</button>
          ))}
        </div>
        <label className="quality">Quality
          <select value={settings.quality} onChange={(e) => setSetting("quality", e.target.value)}>
            {QUALITIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>
    </header>
  );
}

function PlayerBar() {
  const s = useStore();
  const i = s.episodes.indexOf(s.currentEp);
  return (
    <div className="panel player-bar">
      <div className="now">{s.nowPlaying}</div>
      <label className="check">
        <input type="checkbox" checked={s.settings.autoplay} onChange={(e) => setSetting("autoplay", e.target.checked)} /> Autoplay next
      </label>
      <button type="button" disabled={!(i > 0)} onClick={() => step(-1)}>⏮&nbsp; Previous</button>
      <button type="button" disabled={i < 0} onClick={replay}>↻&nbsp; Replay</button>
      <button type="button" disabled={!(i >= 0 && i < s.episodes.length - 1)} onClick={() => step(1)}>Next &nbsp;⏭</button>
      <button type="button" disabled={!s.sessionActive} onClick={stop}>■&nbsp; Stop</button>
    </div>
  );
}

function StatusBar() {
  const s = useStore();
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [s.log, showLog]);
  return (
    <>
      <div className="statusbar">
        <span className={`status ${s.status.error ? "error" : "muted"}`}>{s.status.text}</span>
        <button type="button" className="ghost" onClick={() => setShowLog(!showLog)}>{showLog ? "Hide log" : "Show log"}</button>
      </div>
      {showLog && <pre ref={logRef} className="log">{s.log.join("\n")}</pre>}
    </>
  );
}

/** Any ani-cli menu the app doesn't answer by itself. */
function MenuDialog({ menu }) {
  const dialog = useRef(null);
  const [choice, setChoice] = useState(menu.options[0] ?? "");
  useEffect(() => {
    dialog.current.showModal();
  }, []);
  return (
    <dialog ref={dialog} onCancel={() => answerMenu("")}>
      <p>{menu.prompt}</p>
      <select size={8} value={choice} onChange={(e) => setChoice(e.target.value)} onDoubleClick={() => answerMenu(choice)}>
        {menu.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      <div className="dialog-buttons">
        <button type="button" onClick={() => answerMenu("")}>Cancel</button>
        <button type="button" className="primary" onClick={() => answerMenu(choice)}>OK</button>
      </div>
    </dialog>
  );
}
