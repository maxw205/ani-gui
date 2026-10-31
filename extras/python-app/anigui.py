"""AnimeCLI: a desktop window for ani-cli.

ani-cli still does all the searching and playing. This app becomes its menu:
ani-cli is pointed at bridge/anigui-menu through ANI_CLI_MENU, and that script
passes every menu (prompt + options) to this window through files in a temp
folder, then waits for the answer. Nothing is scraped here, so the app keeps
working when ani-cli is updated with `ani-cli -U`.
"""

import os
import queue
import re
import shutil
import subprocess
import tempfile
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox, ttk

APP_DIR = Path(__file__).resolve().parent
BRIDGE_DIR = APP_DIR / "bridge"
HISTORY_FILE = Path(os.environ.get("ANI_CLI_HIST_DIR", Path.home() / ".local" / "state" / "ani-cli")) / "ani-hsts"

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]")
PLAYING_RE = re.compile(r"Playing episode (.+?) of (.*?)\.\.\.\s*$")
EPISODES_PER_PAGE = 100
EP_BUTTON_WIDTH = 64
QUALITIES = ["best", "1080", "720", "480", "360", "worst"]

COLORS = {
    "bg": "#15161c",
    "panel": "#1d1f27",
    "raised": "#2a2d39",
    "border": "#363a4a",
    "text": "#e6e7ee",
    "muted": "#8b8fa3",
    "accent": "#7c6cff",
    "accent_hover": "#9384ff",
    "watched": "#24392d",
    "watched_hover": "#2f4a3a",
    "watched_text": "#9fd6b0",
    "error": "#ff7a7a",
}


def find_bash():
    """Git Bash, which ani-cli needs on Windows (never WSL's bash.exe)."""
    candidates = [Path.home() / "scoop" / "apps" / "git" / "current" / "bin" / "bash.exe"]
    for var in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        if os.environ.get(var):
            candidates.append(Path(os.environ[var]) / "Git" / "bin" / "bash.exe")
    if os.environ.get("LOCALAPPDATA"):
        candidates.append(Path(os.environ["LOCALAPPDATA"]) / "Programs" / "Git" / "bin" / "bash.exe")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def build_env():
    """This process's environment plus PATH entries added since it started (scoop adds mpv that way)."""
    env = os.environ.copy()
    paths = [str(BRIDGE_DIR), env.get("PATH", "")]
    try:
        import winreg

        keys = [
            (winreg.HKEY_CURRENT_USER, "Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        ]
        for root, subkey in keys:
            try:
                with winreg.OpenKey(root, subkey) as key:
                    paths.append(os.path.expandvars(winreg.QueryValueEx(key, "Path")[0]))
            except OSError:
                pass
    except ImportError:
        pass
    env["PATH"] = os.pathsep.join(p for p in paths if p)
    env["ANI_CLI_MENU"] = "anigui-menu"
    env["TERM"] = "dumb"
    env.pop("ANI_CLI_MENU_FLAGS", None)
    env.pop("ANI_CLI_PLAYER", None)
    return env


def read_history():
    """ani-cli's watch history as [(title, last watched episode)], oldest first."""
    try:
        lines = HISTORY_FILE.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    entries = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) == 3:
            entries.append((parts[2], parts[0]))
    return entries


class Session:
    """One running ani-cli process and the menu it is waiting on."""

    def __init__(self, bash, args, env, settings):
        self.settings = settings
        self.ipc = Path(tempfile.mkdtemp(prefix="anigui-"))
        # ani-cli detaches mpv, so killing ani-cli leaves the player open; this pipe lets stop() close it
        self.mpv_pipe = rf"\\.\pipe\{self.ipc.name}"
        env = dict(env, ANIGUI_IPC=self.ipc.as_posix(), ANI_CLI_PLAYER_FLAGS=f"--input-ipc-server={self.mpv_pipe}")
        self.proc = subprocess.Popen(
            [bash, "-c", 'exec ani-cli "$@"', "ani-cli", *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            creationflags=NO_WINDOW,
        )
        self.pending = None
        self.killed = False
        self.last_line = ""
        self.lines = queue.Queue()
        self.reader = threading.Thread(target=self._read, daemon=True)
        self.reader.start()

    def _read(self):
        for raw in self.proc.stdout:
            line = ANSI_RE.sub("", raw.decode("utf-8", "replace")).replace("\r", "").strip()
            if line and not line.startswith("tput:"):
                self.lines.put(line)

    def drain(self):
        while True:
            try:
                line = self.lines.get_nowait()
            except queue.Empty:
                return
            self.last_line = line
            yield line

    def poll_request(self):
        request = self.ipc / "request"
        try:
            text = request.read_text(encoding="utf-8", errors="replace")
            request.unlink()
        except OSError:
            return None
        prompt, *options = text.split("\n")
        self.pending = (prompt.strip(), [o.strip() for o in options if o.strip()])
        return self.pending

    def waiting(self, prefix, settings):
        return self.alive() and self.settings == settings and self.pending and self.pending[0].startswith(prefix)

    def answer(self, text):
        tmp = self.ipc / "response.tmp"
        tmp.write_text(f"{text}\n" if text else "", encoding="utf-8")
        os.replace(tmp, self.ipc / "response")
        self.pending = None

    def alive(self):
        return self.proc.poll() is None

    def finished(self):
        return not self.alive() and not self.reader.is_alive()

    def stop(self):
        self.killed = True
        try:
            with open(self.mpv_pipe, "r+b", buffering=0) as pipe:
                pipe.write(b'{"command": ["quit"]}\n')
        except OSError:
            pass  # no player open
        if self.alive():
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(self.proc.pid)], capture_output=True, creationflags=NO_WINDOW)
        shutil.rmtree(self.ipc, ignore_errors=True)


class App:
    def __init__(self, root):
        self.root = root
        self.bash = find_bash()
        self.env = build_env()
        self.session = None

        self.list_mode = "search"  # what the left list shows: "search" results or "history"
        self.query = ""
        self.results = []  # [(number, title)] from ani-cli's "Select anime" menu
        self.history = []  # [(title, last episode)], newest first
        self.anime_no = None  # ani-cli's number for the open anime in self.results
        self.anime_title = ""
        self.episodes = []
        self.current_ep = None
        self.watched_up_to = None
        self.page = 0
        self.ep_buttons = []
        self.grid_cols = 0

        # answers to give ani-cli's next menus without asking (used by History)
        self.auto_title = None
        self.continue_after = None
        self.auto_episode = None

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.quit)
        self._tick()
        if not self.bash:
            messagebox.showerror("AnimeCLI", "Git Bash was not found. Install Git for Windows (or `scoop install git`) so ani-cli can run.")

    # ---------- UI ----------

    def _build_ui(self):
        c = COLORS
        root = self.root
        root.title("AnimeCLI")
        root.geometry("1120x720")
        root.minsize(860, 540)
        root.configure(bg=c["bg"])

        style = ttk.Style(root)
        style.theme_use("clam")
        style.configure(
            ".", background=c["bg"], foreground=c["text"], fieldbackground=c["raised"], bordercolor=c["border"],
            lightcolor=c["border"], darkcolor=c["border"], troughcolor=c["panel"], font=("Segoe UI", 10),
        )
        style.configure("Panel.TFrame", background=c["panel"])
        style.configure("Panel.TLabel", background=c["panel"])
        style.configure("Muted.TLabel", foreground=c["muted"])
        style.configure("Error.TLabel", foreground=c["error"])
        style.configure("PanelMuted.TLabel", background=c["panel"], foreground=c["muted"])
        style.configure("Title.TLabel", background=c["panel"], font=("Segoe UI Semibold", 16))
        style.configure("Now.TLabel", background=c["panel"], font=("Segoe UI Semibold", 11))
        style.configure("Brand.TLabel", foreground=c["accent"], font=("Segoe UI Semibold", 15))

        style.configure("TButton", background=c["raised"], foreground=c["text"], borderwidth=0, padding=(12, 6), focuscolor=c["raised"])
        style.map("TButton", background=[("disabled", c["panel"]), ("active", c["border"])], foreground=[("disabled", "#555a6e")])
        style.configure("Accent.TButton", background=c["accent"], foreground="#ffffff", focuscolor=c["accent"])
        style.map("Accent.TButton", background=[("active", c["accent_hover"])])
        for name, bg, fg, hover in (
            ("Ep", c["raised"], c["text"], c["border"]),
            ("Watched", c["watched"], c["watched_text"], c["watched_hover"]),
            ("Current", c["accent"], "#ffffff", c["accent_hover"]),
        ):
            style.configure(f"{name}.TButton", background=bg, foreground=fg, focuscolor=bg, padding=(2, 7), width=5, anchor="center")
            style.map(f"{name}.TButton", background=[("active", hover)])

        style.configure("TEntry", padding=7, insertcolor=c["text"])
        style.configure("TCombobox", arrowcolor=c["text"], padding=4)
        style.map(
            "TCombobox", fieldbackground=[("readonly", c["raised"])], foreground=[("readonly", c["text"])],
            selectbackground=[("readonly", c["raised"])], selectforeground=[("readonly", c["text"])],
        )
        root.option_add("*TCombobox*Listbox.background", c["raised"])
        root.option_add("*TCombobox*Listbox.foreground", c["text"])
        root.option_add("*TCombobox*Listbox.selectBackground", c["accent"])
        for name, bg in (("TRadiobutton", c["bg"]), ("TCheckbutton", c["bg"]), ("Panel.TCheckbutton", c["panel"])):
            style.configure(name, background=bg, indicatorbackground=c["raised"], indicatorforeground=c["text"])
            style.map(name, background=[("active", bg)], indicatorbackground=[("selected", c["accent"])])
        style.configure(
            "Vertical.TScrollbar", background=c["raised"], troughcolor=c["panel"], bordercolor=c["panel"],
            lightcolor=c["raised"], darkcolor=c["raised"], arrowcolor=c["muted"], gripcount=0, borderwidth=0, arrowsize=12,
        )
        style.map("Vertical.TScrollbar", background=[("active", c["border"])])

        # search bar
        top = ttk.Frame(root, padding=(16, 14, 16, 12))
        top.pack(fill="x")
        options = ttk.Frame(top)
        options.pack(side="right", padx=(16, 0))
        self.mode_var = tk.StringVar(value="sub")
        ttk.Radiobutton(options, text="Sub", value="sub", variable=self.mode_var).pack(side="left")
        ttk.Radiobutton(options, text="Dub", value="dub", variable=self.mode_var).pack(side="left", padx=(6, 14))
        ttk.Label(options, text="Quality", style="Muted.TLabel").pack(side="left", padx=(0, 6))
        self.quality_var = tk.StringVar(value="best")
        ttk.Combobox(options, textvariable=self.quality_var, values=QUALITIES, width=6, state="readonly").pack(side="left")

        ttk.Label(top, text="AnimeCLI", style="Brand.TLabel").pack(side="left", padx=(0, 16))
        self.search_var = tk.StringVar()
        entry = ttk.Entry(top, textvariable=self.search_var)
        entry.pack(side="left", fill="x", expand=True)
        entry.bind("<Return>", lambda _e: self.search())
        entry.focus_set()
        ttk.Button(top, text="Search", style="Accent.TButton", command=self.search).pack(side="left", padx=(8, 0))
        ttk.Button(top, text="History", command=self.show_history).pack(side="left", padx=(8, 0))

        # bottom: player bar, status line, log (packed before the body so they keep their height)
        self.log_frame = ttk.Frame(root, style="Panel.TFrame", padding=(10, 6))
        self.log = tk.Text(
            self.log_frame, height=9, bg=c["panel"], fg=c["muted"], insertbackground=c["text"], borderwidth=0,
            highlightthickness=0, font=("Consolas", 9), state="disabled", wrap="word",
        )
        self.log.pack(fill="both", expand=True)

        status = ttk.Frame(root, padding=(16, 6, 16, 10))
        status.pack(side="bottom", fill="x")
        self.log_button = ttk.Button(status, text="Show log", command=self.toggle_log)
        self.log_button.pack(side="right")
        self.status_label = ttk.Label(status, text="Ready", style="Muted.TLabel")
        self.status_label.pack(side="left", fill="x", expand=True)

        bar = ttk.Frame(root, style="Panel.TFrame", padding=(16, 10))
        bar.pack(side="bottom", fill="x", padx=16, pady=(12, 0))
        self.stop_button = ttk.Button(bar, text="■  Stop", command=self.stop)
        self.stop_button.pack(side="right")
        self.next_button = ttk.Button(bar, text="Next  ⏭", command=lambda: self.step(1))
        self.next_button.pack(side="right", padx=(0, 6))
        self.replay_button = ttk.Button(bar, text="↻  Replay", command=self.replay)
        self.replay_button.pack(side="right", padx=(0, 6))
        self.prev_button = ttk.Button(bar, text="⏮  Previous", command=lambda: self.step(-1))
        self.prev_button.pack(side="right", padx=(0, 6))
        self.autoplay_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(bar, text="Autoplay next", variable=self.autoplay_var, style="Panel.TCheckbutton").pack(side="right", padx=(0, 16))
        self.now_label = ttk.Label(bar, text="Nothing playing", style="Now.TLabel")
        self.now_label.pack(side="left")

        # body: results on the left, episodes on the right
        body = ttk.Frame(root, padding=(16, 0))
        body.pack(fill="both", expand=True)

        left = ttk.Frame(body, style="Panel.TFrame", padding=(12, 12, 4, 12))
        left.pack(side="left", fill="y")
        self.list_label = ttk.Label(left, text="Results", style="PanelMuted.TLabel")
        self.list_label.pack(anchor="w", pady=(0, 6))
        list_holder = ttk.Frame(left, style="Panel.TFrame")
        list_holder.pack(fill="both", expand=True)
        self.listbox = tk.Listbox(
            list_holder, width=44, bg=c["panel"], fg=c["text"], selectbackground=c["accent"], selectforeground="#ffffff",
            highlightthickness=0, borderwidth=0, activestyle="none", font=("Segoe UI", 10), exportselection=False,
        )
        list_scroll = ttk.Scrollbar(list_holder, orient="vertical", command=self.listbox.yview)
        self.listbox.configure(yscrollcommand=list_scroll.set)
        list_scroll.pack(side="right", fill="y")
        self.listbox.pack(side="left", fill="both", expand=True)
        self.listbox.bind("<<ListboxSelect>>", self.on_list_select)

        right = ttk.Frame(body, style="Panel.TFrame", padding=(18, 14, 8, 14))
        right.pack(side="left", fill="both", expand=True, padx=(12, 0))
        header = ttk.Frame(right, style="Panel.TFrame")
        header.pack(fill="x")
        self.page_var = tk.StringVar()
        self.page_box = ttk.Combobox(header, textvariable=self.page_var, width=14, state="readonly")
        self.page_box.bind("<<ComboboxSelected>>", self.on_page_select)
        self.title_label = ttk.Label(header, text="Search for an anime to get started", style="Title.TLabel")
        self.title_label.pack(side="left", fill="x", expand=True)
        self.info_label = ttk.Label(right, text="Type a name above and press Enter.", style="PanelMuted.TLabel")
        self.info_label.pack(anchor="w", pady=(2, 12))

        grid_holder = ttk.Frame(right, style="Panel.TFrame")
        grid_holder.pack(fill="both", expand=True)
        self.canvas = tk.Canvas(grid_holder, bg=c["panel"], highlightthickness=0, borderwidth=0)
        grid_scroll = ttk.Scrollbar(grid_holder, orient="vertical", command=self.canvas.yview)
        self.canvas.configure(yscrollcommand=grid_scroll.set)
        grid_scroll.pack(side="right", fill="y")
        self.canvas.pack(side="left", fill="both", expand=True)
        self.grid_frame = ttk.Frame(self.canvas, style="Panel.TFrame")
        self.canvas.create_window((0, 0), window=self.grid_frame, anchor="nw")
        self.grid_frame.bind("<Configure>", lambda _e: self.canvas.configure(scrollregion=self.canvas.bbox("all")))
        self.canvas.bind("<Configure>", lambda _e: self._layout_grid())
        root.bind_all("<MouseWheel>", self._on_wheel)

    def _on_wheel(self, event):
        if str(event.widget).startswith(str(self.canvas)):
            self.canvas.yview_scroll(int(-event.delta / 120), "units")

    def toggle_log(self):
        if self.log_frame.winfo_ismapped():
            self.log_frame.pack_forget()
            self.log_button.configure(text="Show log")
        else:
            self.log_frame.pack(side="bottom", fill="x", padx=16, pady=(0, 12))
            self.log_button.configure(text="Hide log")

    def log_line(self, text):
        self.log.configure(state="normal")
        self.log.insert("end", text + "\n")
        if int(self.log.index("end-1c").split(".")[0]) > 800:
            self.log.delete("1.0", "200.0")
        self.log.see("end")
        self.log.configure(state="disabled")

    def set_status(self, text, error=False):
        self.status_label.configure(text=text, style="Error.TLabel" if error else "Muted.TLabel")

    def fill_list(self, label, items):
        self.list_label.configure(text=label)
        self.listbox.delete(0, "end")
        for item in items:
            self.listbox.insert("end", item)

    def show_anime(self, title, info):
        self.title_label.configure(text=title)
        self.info_label.configure(text=info)

    def render_episodes(self):
        for button in self.ep_buttons:
            button.destroy()
        self.ep_buttons = []
        self.grid_cols = 0
        eps = self.episodes

        pages = (len(eps) + EPISODES_PER_PAGE - 1) // EPISODES_PER_PAGE
        if pages > 1:
            labels = [f"{eps[p * EPISODES_PER_PAGE]} – {eps[min((p + 1) * EPISODES_PER_PAGE, len(eps)) - 1]}" for p in range(pages)]
            self.page = min(self.page, pages - 1)
            self.page_box.configure(values=labels)
            self.page_var.set(labels[self.page])
            self.page_box.pack(side="right", before=self.title_label)
        else:
            self.page = 0
            self.page_box.pack_forget()

        watched = eps.index(self.watched_up_to) if self.watched_up_to in eps else -1
        start = self.page * EPISODES_PER_PAGE
        for i in range(start, min(start + EPISODES_PER_PAGE, len(eps))):
            ep = eps[i]
            style = "Current.TButton" if ep == self.current_ep else "Watched.TButton" if i <= watched else "Ep.TButton"
            self.ep_buttons.append(ttk.Button(self.grid_frame, text=ep, style=style, command=lambda e=ep: self.play(e)))
        self._layout_grid()

        if eps:
            info = f"{len(eps)} episodes  ·  {self.mode_var.get()}"
            if watched >= 0:
                info += f"  ·  watched up to episode {self.watched_up_to}"
            self.info_label.configure(text=info)

    def _layout_grid(self):
        cols = max(1, self.canvas.winfo_width() // EP_BUTTON_WIDTH)
        if cols == self.grid_cols and self.ep_buttons and self.ep_buttons[0].winfo_manager():
            return
        self.grid_cols = cols
        for i, button in enumerate(self.ep_buttons):
            button.grid(row=i // cols, column=i % cols, padx=3, pady=3, sticky="ew")

    def page_of(self, ep):
        return self.episodes.index(ep) // EPISODES_PER_PAGE if ep in self.episodes else self.page

    def on_page_select(self, _event):
        self.page = self.page_box.current()
        self.render_episodes()
        self.canvas.yview_moveto(0)

    def refresh_watched(self):
        self.watched_up_to = next((ep for title, ep in read_history() if title.lower() == self.anime_title.lower()), None)

    def _update_controls(self):
        idx = self.episodes.index(self.current_ep) if self.current_ep in self.episodes else -1
        self.prev_button.state(["!disabled"] if idx > 0 else ["disabled"])
        self.next_button.state(["!disabled"] if 0 <= idx < len(self.episodes) - 1 else ["disabled"])
        self.replay_button.state(["!disabled"] if idx >= 0 else ["disabled"])
        self.stop_button.state(["!disabled"] if self.session else ["disabled"])

    # ---------- ani-cli sessions ----------

    def settings(self):
        return (self.mode_var.get(), self.quality_var.get())

    def start_session(self, flags, query=None):
        self.stop_session()
        if not self.bash:
            self.set_status("Git Bash not found, so ani-cli can't run.", error=True)
            return
        mode, quality = self.settings()
        args = list(flags) + ["-q", quality] + (["--dub"] if mode == "dub" else []) + ([query] if query else [])
        self.log_line("$ ani-cli " + " ".join(f'"{a}"' if " " in a else a for a in args))
        self.session = Session(self.bash, args, self.env, (mode, quality))

    def stop_session(self):
        if self.session:
            self.session.stop()
            self.session = None

    def _tick(self):
        session = self.session
        if session:
            for line in session.drain():
                self.on_output(line)
            request = session.poll_request()
            if request:
                self.log_line(f"[menu] {request[0]} ({len(request[1])} options)")
                self.on_menu(*request)
            if session is self.session and session.finished():
                for line in session.drain():
                    self.on_output(line)
                self.on_session_end(session)
        self._update_controls()
        self.root.after(100, self._tick)

    def on_output(self, line):
        self.log_line(line)
        if line.startswith("Checking dependencies"):
            self.set_status("Starting ani-cli…")
        elif "links fetched" in line:
            self.set_status("Opening mpv…  (close the player when you're done)")
            if self.current_ep:
                self.now_label.configure(text=f"▶  {self.anime_title}  —  Episode {self.current_ep}")
        else:
            self.set_status(line)

    def on_menu(self, prompt, options):
        session = self.session
        if prompt.startswith("Select anime"):
            self.results = [tuple(o.split(" ", 1)) if " " in o else (o, o) for o in options]
            if self.auto_title:
                wanted, self.auto_title = self.auto_title.lower(), None
                match = next((i for i, (_n, t) in enumerate(self.results) if t.lower() == wanted), None)
                if match is not None:
                    self.open_anime(match)
                    return
                self.continue_after = None
                self.set_status("Several matches found. Pick the right one on the left.")
            self.list_mode = "search"
            self.fill_list(f"Results for “{self.query}”", [t for _n, t in self.results])
            self.show_anime("Pick an anime", f"{len(self.results)} results. Click one to see its episodes.")
            self.set_status(f"{len(self.results)} results")

        elif prompt.startswith("Select episode"):
            if self.anime_no is None:
                # only one search result, so ani-cli skipped "Select anime"
                self.auto_title = None
                self.results = [("1", self.query)]
                self.anime_no, self.anime_title = "1", self.query
                if self.list_mode == "search":
                    self.fill_list(f"Results for “{self.query}”", [self.query])
                    self.listbox.selection_set(0)
                self.show_anime(self.anime_title, "")
                self.refresh_watched()
            self.episodes = options
            target = self.auto_episode
            self.auto_episode = None
            if self.continue_after is not None:
                after, self.continue_after = self.continue_after, None
                if after in options and options.index(after) + 1 < len(options):
                    target = options[options.index(after) + 1]
                else:
                    self.set_status(f"You're caught up: episode {after} is the latest one watched.")
            self.page = self.page_of(target or self.current_ep or self.watched_up_to)
            self.render_episodes()
            if target in options:
                self.play(target)
            elif not target:
                self.set_status(f"{len(options)} episodes. Click one to play it.")

        elif PLAYING_RE.match(prompt):
            ep, title = PLAYING_RE.match(prompt).groups()
            self.current_ep = ep
            if not self.episodes:
                self.episodes = [ep]
            self.refresh_watched()
            self.page = self.page_of(ep)
            self.render_episodes()
            self.now_label.configure(text=f"Finished  {title}  —  Episode {ep}")
            is_last = self.episodes.index(ep) == len(self.episodes) - 1 if ep in self.episodes else True
            if self.autoplay_var.get() and not is_last:
                self.step(1)
            else:
                self.set_status("Player closed. Pick another episode, or use Next / Replay.")

        else:
            self.ask_generic(session, prompt, options)

    def on_session_end(self, session):
        self.session = None
        code = session.proc.returncode
        self.log_line(f"[ani-cli exited with code {code}]")
        if session.killed:
            return
        self.now_label.configure(text="Nothing playing")
        if code != 0:
            message = session.last_line or "ani-cli stopped unexpectedly."
            self.set_status(message, error=True)
            if not self.episodes and self.list_mode == "search" and not self.results:
                self.show_anime("Nothing found", message)
        else:
            self.set_status("Ready")

    def ask_generic(self, session, prompt, options):
        """Any other ani-cli menu: show its options in a small dialog."""
        dialog = tk.Toplevel(self.root, bg=COLORS["bg"], padx=14, pady=12)
        dialog.title("ani-cli")
        dialog.transient(self.root)
        ttk.Label(dialog, text=prompt).pack(anchor="w", pady=(0, 8))
        box = tk.Listbox(dialog, width=50, height=min(12, max(3, len(options))), bg=COLORS["panel"], fg=COLORS["text"],
                         selectbackground=COLORS["accent"], highlightthickness=0, borderwidth=0)
        for option in options:
            box.insert("end", option)
        box.pack(fill="both", expand=True)

        def finish(choice):
            if session is self.session and session.alive():
                session.answer(choice)
            dialog.destroy()

        def pick(_e=None):
            selection = box.curselection()
            finish(options[selection[0]] if selection else "")

        box.bind("<Double-Button-1>", pick)
        buttons = ttk.Frame(dialog)
        buttons.pack(fill="x", pady=(10, 0))
        ttk.Button(buttons, text="Cancel", command=lambda: finish("")).pack(side="right")
        ttk.Button(buttons, text="OK", style="Accent.TButton", command=pick).pack(side="right", padx=(0, 6))
        dialog.protocol("WM_DELETE_WINDOW", lambda: finish(""))

    # ---------- actions ----------

    def search(self):
        query = self.search_var.get().strip()
        if not query:
            return
        self.query = query
        self.results, self.episodes = [], []
        self.anime_no, self.anime_title, self.current_ep = None, "", None
        self.auto_title = self.continue_after = self.auto_episode = None
        self.list_mode = "search"
        self.fill_list(f"Results for “{query}”", [])
        self.render_episodes()
        self.show_anime(f"Searching for “{query}”…", "")
        self.start_session([], query)

    def show_history(self):
        self.history = list(reversed(read_history()))
        self.list_mode = "history"
        self.fill_list("Watch history", [f"{title}   ·   ep {ep}" for title, ep in self.history])
        if self.history:
            self.set_status("Click a show to continue from the episode after the one you last watched.")
        else:
            self.set_status("No watch history yet.")

    def on_list_select(self, _event):
        selection = self.listbox.curselection()
        if not selection:
            return
        i = selection[0]
        if self.list_mode == "history":
            title, ep = self.history[i]
            self.query = title
            self.results, self.episodes = [], []
            self.anime_no, self.anime_title, self.current_ep = None, title, None
            self.auto_title, self.continue_after, self.auto_episode = title, ep, None
            self.render_episodes()
            self.show_anime(title, f"Last watched episode {ep}. Finding the next one…")
            self.start_session([], title)
        else:
            self.open_anime(i)

    def open_anime(self, i):
        number, title = self.results[i]
        if number == self.anime_no and self.episodes:
            return
        self.anime_no, self.anime_title = number, title
        self.episodes, self.current_ep = [], None
        self.refresh_watched()
        self.render_episodes()
        self.show_anime(title, "Loading episodes…")
        session = self.session
        if session and session.waiting("Select anime", self.settings()):
            session.answer(number)
        else:
            self.start_session(["-S", number], self.query)

    def play(self, ep):
        if self.anime_no is None:
            return
        self.current_ep = ep
        self.page = self.page_of(ep)
        self.render_episodes()
        self.now_label.configure(text=f"Loading  {self.anime_title}  —  Episode {ep}…")
        session, settings = self.session, self.settings()
        if session and session.waiting("Select episode", settings):
            session.answer(ep)
        elif session and session.waiting("Playing episode", settings):
            # back to ani-cli's episode menu; on_menu answers it with this episode
            self.auto_episode = ep
            session.answer("select")
        else:
            self.start_session(["-S", self.anime_no, "-e", ep], self.query)

    def step(self, delta):
        if self.current_ep in self.episodes:
            i = self.episodes.index(self.current_ep) + delta
            if 0 <= i < len(self.episodes):
                self.play(self.episodes[i])

    def replay(self):
        if self.current_ep:
            self.play(self.current_ep)

    def stop(self):
        self.stop_session()
        self.now_label.configure(text="Nothing playing")
        self.set_status("Stopped")

    def quit(self):
        self.stop_session()
        self.root.destroy()


def main():
    try:
        import ctypes

        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except (AttributeError, OSError):
        pass
    root = tk.Tk()
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
