// Runs ani-cli and relays it to the window.
//
// ani-cli is pointed at bridge/anigui-menu through ANI_CLI_MENU: each time it would show a
// menu, that script writes the prompt and options to a temp folder and waits for an answer
// file. Its player is bridge/anigui-webmpv, a stand-in that hands over the stream details
// (url, referrer, subtitles, title) the same way instead of playing anything. This side
// only starts processes and moves those files around; what to answer and show is decided
// in the renderer (src/store.js). Nothing is scraped here, so updating ani-cli keeps working.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { spawn, execFileSync } = require("node:child_process");

const HOME = os.homedir();

/** Git Bash, which ani-cli needs on Windows (never WSL's bash.exe). */
function findBash() {
  const candidates = [path.join(HOME, "scoop", "apps", "git", "current", "bin", "bash.exe")];
  for (const v of ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]) {
    if (process.env[v]) candidates.push(path.join(process.env[v], "Git", "bin", "bash.exe"));
  }
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, "Programs", "Git", "bin", "bash.exe"));
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

const expandEnv = (value) => value.replace(/%([^%]+)%/g, (all, name) => process.env[name] ?? all);

function registryPath(key) {
  try {
    const out = execFileSync("reg", ["query", key, "/v", "Path"], { encoding: "utf8", windowsHide: true });
    const match = out.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.*)/i);
    return match ? expandEnv(match[1].trim()) : "";
  } catch {
    return "";
  }
}

/** This process's PATH plus entries added since it started (scoop installs add to it), bridge first. */
function buildPath(bridgeDir) {
  return [
    bridgeDir,
    process.env.PATH,
    registryPath("HKCU\\Environment"),
    registryPath("HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment"),
  ].filter(Boolean).join(";");
}

/** The environment for ani-cli: ours, minus the Windows "Path" spelling that would shadow PATH. */
function aniCliEnv(pathVar, ipcDir) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toUpperCase() !== "PATH" && key !== "ANI_CLI_MENU_FLAGS") env[key] = value;
  }
  return {
    ...env,
    PATH: pathVar,
    TERM: "dumb",
    ANI_CLI_MENU: "anigui-menu",
    ANI_CLI_PLAYER: "anigui-webmpv",
    ANI_CLI_PLAYER_FLAGS: "",
    ANIGUI_IPC: ipcDir.replaceAll("\\", "/"),
  };
}

/** One running ani-cli process. */
class Session {
  constructor({ id, args, bash, pathVar, send, onStream }) {
    this.id = id;
    this.killed = false;
    this.ipc = fs.mkdtempSync(path.join(os.tmpdir(), `anigui-${id}-`));
    this.child = spawn(bash, ["-c", 'exec ani-cli "$@" 2>&1', "ani-cli", ...args], {
      env: aniCliEnv(pathVar, this.ipc),
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      send("ani:output", { session: id, line: line.replace(/\r/g, "") });
    });
    this.child.on("error", (err) => send("ani:output", { session: id, line: `Could not start ani-cli: ${err.message}` }));
    this.child.on("close", (code) => {
      clearInterval(this.poll);
      send("ani:exit", { session: id, code, killed: this.killed });
    });

    // menus the bridge script hands over, and the stream the stand-in player hands over
    const request = path.join(this.ipc, "request");
    const stream = path.join(this.ipc, "stream");
    this.poll = setInterval(() => {
      const menu = takeFile(request);
      if (menu !== null) {
        const [prompt = "", ...options] = menu.split("\n");
        send("ani:menu", { session: id, prompt: prompt.trim(), options: options.map((o) => o.trim()).filter(Boolean) });
      }
      const details = takeFile(stream);
      if (details !== null) {
        const [url = "", referrer = "", subtitles = "", title = ""] = details.split("\n").map((l) => l.trim());
        onStream(this, { url, referrer, subtitles, title });
      }
    }, 100);
  }

  /** Answers the menu ani-cli is waiting on; an empty answer cancels it. */
  answer(text) {
    const tmp = path.join(this.ipc, "response.tmp");
    fs.writeFileSync(tmp, text ? `${text}\n` : "");
    fs.renameSync(tmp, path.join(this.ipc, "response"));
  }

  /** The page finished the episode: the stand-in player exits and ani-cli moves on. */
  finish() {
    try {
      fs.writeFileSync(path.join(this.ipc, "player-done"), "");
    } catch {
      // session already gone
    }
  }

  stop() {
    this.killed = true;
    clearInterval(this.poll);
    if (this.child.exitCode === null) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(this.child.pid)], { windowsHide: true, stdio: "ignore" });
      } catch {
        // already exited
      }
    }
    // the bridge scripts exit once their folder is gone
    fs.rmSync(this.ipc, { recursive: true, force: true });
  }
}

function takeFile(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    fs.unlinkSync(file);
    return text;
  } catch {
    return null;
  }
}

class AniCli {
  /**
   * @param send  sends an event to the window: (channel, payload)
   * @param dataDir  where the bridge scripts are written (ani-cli finds them on PATH)
   * @param streams  the StreamProxy that lets the page fetch stream URLs
   */
  constructor({ send, dataDir, streams }) {
    this.send = send;
    this.streams = streams;
    this.session = null;
    this.bash = findBash();
    const bridgeDir = path.join(dataDir, "bridge");
    fs.mkdirSync(bridgeDir, { recursive: true });
    for (const name of ["anigui-menu", "anigui-webmpv"]) {
      const source = fs.readFileSync(path.join(__dirname, "bridge", name), "utf8");
      fs.writeFileSync(path.join(bridgeDir, name), source.replace(/\r/g, ""));
    }
    this.pathVar = buildPath(bridgeDir);
  }

  /** Starts `ani-cli <args>`, replacing any running session. `id` comes from the page. */
  start(id, args) {
    this.stop();
    if (!this.bash) throw new Error("Git Bash was not found, so ani-cli can't run. Install Git for Windows (or `scoop install git`).");
    this.session = new Session({
      id,
      args,
      bash: this.bash,
      pathVar: this.pathVar,
      send: this.send,
      onStream: (session, details) => this.onStream(session, details),
    });
  }

  onStream(session, { url, referrer, subtitles, title }) {
    if (!url) {
      this.send("ani:output", { session: session.id, line: "ani-cli handed over no stream." });
      return;
    }
    this.send("ani:stream", {
      session: session.id,
      url: this.streams.allow(url, referrer),
      subtitles: subtitles ? this.streams.allow(subtitles, referrer) : null,
      title,
    });
  }

  current(id) {
    return this.session && this.session.id === id ? this.session : null;
  }

  answer(id, text) {
    const session = this.current(id);
    if (!session) throw new Error("That ani-cli session has ended.");
    session.answer(text);
  }

  finish(id) {
    this.current(id)?.finish();
  }

  stop() {
    this.session?.stop();
    this.session = null;
  }

  /** ani-cli's watch history as [{title, episode}], oldest first. */
  history() {
    const dir = process.env.ANI_CLI_HIST_DIR || path.join(HOME, ".local", "state", "ani-cli");
    try {
      return fs.readFileSync(path.join(dir, "ani-hsts"), "utf8").split(/\r?\n/)
        .map((line) => line.split("\t"))
        .filter((parts) => parts.length === 3)
        .map(([episode, , title]) => ({ title, episode }));
    } catch {
      return [];
    }
  }

  environment() {
    return { bashFound: Boolean(this.bash) };
  }
}

module.exports = { AniCli };
