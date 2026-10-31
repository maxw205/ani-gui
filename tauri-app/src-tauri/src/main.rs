#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Backend for AnimeCLI: runs ani-cli and relays its menus to the window.
//!
//! ani-cli is pointed at bridge/anigui-menu through ANI_CLI_MENU. That script writes
//! each menu (prompt + options) to a file in a temp folder and waits for an answer
//! file. This side only starts processes and moves those files around; deciding what
//! to answer and what to show lives in the frontend (src/main.js).
//!
//! mpv is told to draw into a child window of the app (`--wid`, see video.rs), so the
//! video plays inside the window rather than in a separate player.

mod video;

use serde::Serialize;
use serde_json::json;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

const BRIDGE_SCRIPT: &str = include_str!("../bridge/anigui-menu");
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ERROR_PIPE_BUSY: i32 = 231;

/// ArtCNN upscaling shaders (https://github.com/Artoriuz/ArtCNN, MIT), written to the
/// app's data folder at startup so mpv can load them.
const SHADERS: &[(&str, &[u8])] = &[
    ("ArtCNN_C4F32.glsl", include_bytes!("../shaders/ArtCNN_C4F32.glsl")),
    ("ArtCNN_C4F32_DS.glsl", include_bytes!("../shaders/ArtCNN_C4F32_DS.glsl")),
    ("ArtCNN_C4F32_DN.glsl", include_bytes!("../shaders/ArtCNN_C4F32_DN.glsl")),
    ("ArtCNN_C4F16.glsl", include_bytes!("../shaders/ArtCNN_C4F16.glsl")),
    ("ArtCNN_C4F16_DS.glsl", include_bytes!("../shaders/ArtCNN_C4F16_DS.glsl")),
    ("ArtCNN_C4F16_DN.glsl", include_bytes!("../shaders/ArtCNN_C4F16_DN.glsl")),
    ("LICENSE-ArtCNN", include_bytes!("../shaders/LICENSE-ArtCNN")),
];

/// How mpv should play: chosen in the window, applied to every player a session opens.
#[derive(Default)]
struct PlayerPrefs {
    shaders: Vec<PathBuf>,
    /// start each player in the app's fullscreen (theater) mode
    fullscreen: bool,
}

/// mpv IPC commands (one JSON object per line) that replace the active shaders.
fn shader_commands(shaders: &[PathBuf]) -> String {
    let mut commands = vec![json!({ "command": ["change-list", "glsl-shaders", "clr", ""] })];
    // one append per file, so paths never need mpv's OS-specific list separator
    for path in shaders {
        commands.push(json!({ "command": ["change-list", "glsl-shaders", "append", path.to_string_lossy()] }));
    }
    commands.iter().map(|c| format!("{c}\n")).collect()
}

fn fullscreen_command(on: bool) -> String {
    format!("{}\n", json!({ "command": ["set_property", "fullscreen", on] }))
}

/// Sends commands to the mpv listening on `pipe`; false when no player is open.
fn send_to_player(pipe: &str, commands: &str) -> bool {
    for _ in 0..20 {
        match fs::OpenOptions::new().write(true).open(pipe) {
            Ok(mut conn) => return conn.write_all(commands.as_bytes()).is_ok(),
            // every pipe instance is briefly busy while mpv accepts another client
            Err(e) if e.raw_os_error() == Some(ERROR_PIPE_BUSY) => thread::sleep(Duration::from_millis(50)),
            Err(_) => return false,
        }
    }
    false
}

/// Force-closes `pid`, but only while it is still an mpv process.
fn kill_player(pid: u32) {
    let _ = Command::new("taskkill")
        .args(["/F", "/FI", &format!("PID eq {pid}"), "/FI", "IMAGENAME eq mpv.exe"])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
}

/// One running ani-cli process.
struct Session {
    id: u64,
    pid: u32,
    ipc: PathBuf,
    mpv_pipe: String,
    /// process id of the mpv this session has open, reported over its IPC pipe
    player_pid: Arc<Mutex<Option<u32>>>,
    killed: Arc<AtomicBool>,
}

impl Session {
    /// Ends ani-cli and closes its player. With `wait`, returns only once the player
    /// is gone (for app exit); otherwise the fallback runs in the background.
    fn stop(&self, wait: bool) {
        self.killed.store(true, Ordering::SeqCst);
        let player = self.player_pid.lock().unwrap().take();
        // ani-cli detaches mpv, so killing ani-cli alone would leave the player open
        send_to_player(&self.mpv_pipe, &format!("{}\n", json!({ "command": ["quit"] })));
        let _ = Command::new("taskkill")
            .args(["/T", "/F", "/PID", &self.pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
        let _ = fs::remove_dir_all(&self.ipc);
        // quit normally closes mpv within a moment; if the pipe was unusable it doesn't
        if let Some(pid) = player {
            let fallback = move || {
                thread::sleep(Duration::from_millis(1500));
                kill_player(pid);
            };
            if wait {
                fallback();
            } else {
                thread::spawn(fallback);
            }
        }
    }
}

struct AppState {
    session: Mutex<Option<Session>>,
    bash: Option<PathBuf>,
    path_var: String,
    shader_dir: PathBuf,
    prefs: Arc<Mutex<PlayerPrefs>>,
    /// HWND of the child window mpv draws into
    video_window: isize,
}

impl AppState {
    /// Sends commands to the player of the running session, if one is open.
    fn send_to_current_player(&self, commands: &str) -> bool {
        let pipe = self.session.lock().unwrap().as_ref().map(|s| s.mpv_pipe.clone());
        pipe.is_some_and(|pipe| send_to_player(&pipe, commands))
    }
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    session: u64,
    line: String,
}

#[derive(Clone, Serialize)]
struct MenuEvent {
    session: u64,
    prompt: String,
    options: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ExitEvent {
    session: u64,
    code: Option<i32>,
    killed: bool,
}

/// A player opened (mpv connected) or closed.
#[derive(Clone, Serialize)]
struct PlayerEvent {
    session: u64,
    open: bool,
}

/// mpv's fullscreen property changed (f, double-click, Esc in the video, or the app).
#[derive(Clone, Serialize)]
struct FullscreenEvent {
    session: u64,
    on: bool,
}

/// One of the player properties the control bar shows changed.
#[derive(Clone, Serialize)]
struct PlayerStateEvent {
    session: u64,
    name: String,
    value: serde_json::Value,
}

/// Properties the control bar shows, observed on every player (fullscreen has id 1).
const OBSERVED: &[&str] = &["pause", "time-pos", "duration", "volume", "mute", "sub-visibility", "speed", "demuxer-cache-time"];
/// These change every frame; the bar only needs a few updates a second.
const THROTTLED: &[&str] = &["time-pos", "demuxer-cache-time"];
/// Properties the control bar may set.
const SETTABLE: &[&str] = &["pause", "volume", "mute", "sub-visibility", "speed"];

#[derive(Serialize)]
struct HistoryEntry {
    title: String,
    episode: String,
}

#[derive(Serialize)]
struct Environment {
    bash_found: bool,
}

/// Starts `ani-cli <args>`, replacing any running session. `id` comes from the
/// frontend so it can match events that arrive before this call returns.
#[tauri::command]
fn start_session(app: AppHandle, state: State<AppState>, id: u64, args: Vec<String>) -> Result<(), String> {
    let mut current = state.session.lock().unwrap();
    if let Some(old) = current.take() {
        old.stop(false);
    }
    let bash = state
        .bash
        .as_ref()
        .ok_or("Git Bash was not found, so ani-cli can't run. Install Git for Windows (or `scoop install git`).")?;

    let tag = format!("anigui-{}-{}", std::process::id(), id);
    let ipc = std::env::temp_dir().join(&tag);
    fs::create_dir_all(&ipc).map_err(|e| e.to_string())?;
    let mpv_pipe = format!(r"\\.\pipe\{tag}");

    let mut child = Command::new(bash)
        .args(["-c", r#"exec ani-cli "$@" 2>&1"#, "ani-cli"])
        .args(&args)
        .env("PATH", &state.path_var)
        .env("ANI_CLI_MENU", "anigui-menu")
        .env("ANIGUI_IPC", ipc.to_string_lossy().replace('\\', "/"))
        // ani-cli splits these on spaces; neither value can contain one
        .env("ANI_CLI_PLAYER_FLAGS", format!("--input-ipc-server={mpv_pipe} --wid={}", state.video_window))
        .env("TERM", "dumb")
        .env_remove("ANI_CLI_MENU_FLAGS")
        .env_remove("ANI_CLI_PLAYER")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|e| format!("Could not start ani-cli: {e}"))?;

    let pid = child.id();
    let stdout = child.stdout.take().expect("stdout is piped");
    let killed = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(true));

    // output, then the exit code once ani-cli is done
    {
        let (app, running, killed) = (app.clone(), running.clone(), killed.clone());
        thread::spawn(move || {
            for chunk in BufReader::new(stdout).split(b'\n') {
                let Ok(bytes) = chunk else { break };
                let line = String::from_utf8_lossy(&bytes).trim_end_matches('\r').to_string();
                let _ = app.emit("ani-output", OutputEvent { session: id, line });
            }
            let code = child.wait().ok().and_then(|status| status.code());
            running.store(false, Ordering::SeqCst);
            let _ = app.emit("ani-exit", ExitEvent { session: id, code, killed: killed.load(Ordering::SeqCst) });
        });
    }

    // menus the bridge script hands over
    {
        let (app, ipc, running) = (app.clone(), ipc.clone(), running.clone());
        thread::spawn(move || {
            let request = ipc.join("request");
            while running.load(Ordering::SeqCst) && ipc.exists() {
                if let Ok(bytes) = fs::read(&request) {
                    let _ = fs::remove_file(&request);
                    let text = String::from_utf8_lossy(&bytes);
                    let mut lines = text.split('\n');
                    let prompt = lines.next().unwrap_or("").trim().to_string();
                    let options = lines.map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
                    let _ = app.emit("ani-menu", MenuEvent { session: id, prompt, options });
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
    }

    // mpv only exists while an episode plays, and Next replaces it with a new one, so
    // keep connecting to its pipe: hand each new player the chosen upscaler, and tell
    // the window when a player opens, closes or toggles fullscreen
    let player_pid = Arc::new(Mutex::new(None));
    {
        let (app, pipe, running, prefs, player_pid) =
            (app.clone(), mpv_pipe.clone(), running.clone(), state.prefs.clone(), player_pid.clone());
        thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                let Ok(conn) = fs::OpenOptions::new().read(true).write(true).open(&pipe) else {
                    thread::sleep(Duration::from_millis(200));
                    continue;
                };
                let _ = app.emit("ani-player", PlayerEvent { session: id, open: true });
                let mut commands = {
                    let prefs = prefs.lock().unwrap();
                    let mut commands = shader_commands(&prefs.shaders);
                    // set before observing, so the first fullscreen event already says "on"
                    if prefs.fullscreen {
                        commands.push_str(&fullscreen_command(true));
                    }
                    commands
                };
                commands.push_str(&format!("{}\n", json!({ "command": ["observe_property", 1, "fullscreen"] })));
                for (i, name) in OBSERVED.iter().enumerate() {
                    commands.push_str(&format!("{}\n", json!({ "command": ["observe_property", i + 2, name] })));
                }
                commands.push_str(&format!("{}\n", json!({ "command": ["get_property", "pid"], "request_id": 1 })));
                let _ = (&conn).write_all(commands.as_bytes());
                let mut last_sent: std::collections::HashMap<String, std::time::Instant> = Default::default();
                // mpv keeps this connection open until the player closes
                for line in BufReader::new(&conn).lines() {
                    let Ok(line) = line else { break };
                    let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
                    if msg["request_id"] == 1 {
                        if let Some(pid) = msg["data"].as_u64() {
                            *player_pid.lock().unwrap() = Some(pid as u32);
                        }
                        continue;
                    }
                    if msg["event"] != "property-change" {
                        continue;
                    }
                    let Some(name) = msg["name"].as_str() else { continue };
                    if name == "fullscreen" {
                        let on = msg["data"].as_bool().unwrap_or(false);
                        let _ = app.emit("ani-player-fullscreen", FullscreenEvent { session: id, on });
                        continue;
                    }
                    if THROTTLED.contains(&name) {
                        let now = std::time::Instant::now();
                        if last_sent.get(name).is_some_and(|t| now.duration_since(*t) < Duration::from_millis(250)) {
                            continue;
                        }
                        last_sent.insert(name.to_string(), now);
                    }
                    let value = msg["data"].clone();
                    let _ = app.emit("ani-player-state", PlayerStateEvent { session: id, name: name.to_string(), value });
                }
                *player_pid.lock().unwrap() = None;
                let _ = app.emit("ani-player", PlayerEvent { session: id, open: false });
            }
        });
    }

    *current = Some(Session { id, pid, ipc, mpv_pipe, player_pid, killed });
    Ok(())
}

/// Answers the menu the session is waiting on; an empty answer cancels it.
#[tauri::command]
fn answer(state: State<AppState>, session: u64, text: String) -> Result<(), String> {
    let current = state.session.lock().unwrap();
    let s = current.as_ref().filter(|s| s.id == session).ok_or("That ani-cli session has ended.")?;
    let tmp = s.ipc.join("response.tmp");
    let body = if text.is_empty() { String::new() } else { format!("{text}\n") };
    fs::write(&tmp, body).map_err(|e| e.to_string())?;
    fs::rename(&tmp, s.ipc.join("response")).map_err(|e| e.to_string())
}

/// Chooses the upscaling shaders (file names from SHADERS; empty for none). Returns
/// true when a player was open and switched right away.
#[tauri::command]
fn set_upscaler(state: State<AppState>, shaders: Vec<String>) -> Result<bool, String> {
    let mut paths = Vec::new();
    for name in &shaders {
        if !name.ends_with(".glsl") || !SHADERS.iter().any(|(file, _)| file == name) {
            return Err(format!("Unknown shader {name}"));
        }
        paths.push(state.shader_dir.join(name));
    }
    let commands = shader_commands(&paths);
    state.prefs.lock().unwrap().shaders = paths;
    Ok(state.send_to_current_player(&commands))
}

/// Whether new players start in fullscreen (theater) mode.
#[tauri::command]
fn set_start_fullscreen(state: State<AppState>, on: bool) {
    state.prefs.lock().unwrap().fullscreen = on;
}

/// Toggles fullscreen through mpv's own property, so the f key, double-click and the
/// app's button all agree; the change comes back as an `ani-player-fullscreen` event.
#[tauri::command]
fn set_player_fullscreen(state: State<AppState>, on: bool) -> bool {
    state.send_to_current_player(&fullscreen_command(on))
}

/// Sends a control-bar command to the open player: setting one of SETTABLE, a seek,
/// or showing/hiding mpv's own on-screen controller. Returns false when no player is open.
#[tauri::command]
fn player_command(state: State<AppState>, command: Vec<serde_json::Value>) -> Result<bool, String> {
    let name = command.first().and_then(|c| c.as_str()).unwrap_or("");
    let arg = command.get(1).and_then(|a| a.as_str()).unwrap_or("");
    let allowed = match name {
        "set_property" => SETTABLE.contains(&arg),
        "seek" => command.get(1).is_some_and(|a| a.is_number()),
        "script-message" => arg == "osc-visibility",
        _ => false,
    };
    if !allowed {
        return Err(format!("player command not allowed: {command:?}"));
    }
    Ok(state.send_to_current_player(&format!("{}\n", json!({ "command": command }))))
}

/// Shows the floating control bar centred near the bottom of the (fullscreen) main
/// window, without taking the keyboard from the video; or hides it.
#[tauri::command]
fn show_controls_overlay(app: AppHandle, show: bool) -> Result<(), String> {
    let controls = app.get_webview_window("controls").ok_or("controls window not found")?;
    let controls_hwnd = controls.hwnd().map_err(|e| e.to_string())?.0 as isize;
    if !show {
        video::set_visible_without_focus(controls_hwnd, false);
        return Ok(());
    }
    let main = app.get_webview_window("main").ok_or("main window not found")?;
    let (pos, size, scale) = (
        main.outer_position().map_err(|e| e.to_string())?,
        main.outer_size().map_err(|e| e.to_string())?,
        main.scale_factor().map_err(|e| e.to_string())?,
    );
    let px = |logical: f64| (logical * scale).round() as i32;
    let width = px(1100.0).min(size.width as i32 - px(48.0)).max(px(400.0));
    let height = px(52.0);
    controls
        .set_size(tauri::PhysicalSize::new(width as u32, height as u32))
        .and_then(|_| {
            controls.set_position(tauri::PhysicalPosition::new(
                pos.x + (size.width as i32 - width) / 2,
                pos.y + size.height as i32 - height - px(28.0),
            ))
        })
        .map_err(|e| e.to_string())?;
    video::set_visible_without_focus(controls_hwnd, true);
    Ok(())
}

/// Hides the cursor over the video until the mouse next moves (fullscreen, controls hidden).
#[tauri::command]
fn set_video_cursor_hidden(hidden: bool) {
    video::set_cursor_hidden(hidden);
}

/// Puts the app window itself in or out of fullscreen (mpv can't while embedded).
#[tauri::command]
fn set_window_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("main window not found")?;
    window.set_fullscreen(on).map_err(|e| e.to_string())
}

/// Moves the video window over the page's video area (physical pixels).
#[tauri::command]
fn set_video_rect(state: State<AppState>, x: i32, y: i32, width: i32, height: i32, visible: bool) {
    video::place(state.video_window, x, y, width, height, visible);
}

#[tauri::command]
fn stop_session(state: State<AppState>) {
    if let Some(s) = state.session.lock().unwrap().take() {
        s.stop(false);
    }
}

/// ani-cli's watch history, oldest first.
#[tauri::command]
fn read_history() -> Vec<HistoryEntry> {
    let dir = std::env::var_os("ANI_CLI_HIST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local").join("state").join("ani-cli"));
    let Ok(bytes) = fs::read(dir.join("ani-hsts")) else { return Vec::new() };
    String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| match line.split('\t').collect::<Vec<_>>()[..] {
            [episode, _id, title] => Some(HistoryEntry { title: title.into(), episode: episode.into() }),
            _ => None,
        })
        .collect()
}

#[tauri::command]
fn environment(state: State<AppState>) -> Environment {
    Environment { bash_found: state.bash.is_some() }
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_default()
}

/// Git Bash, which ani-cli needs on Windows (never WSL's bash.exe).
fn find_bash() -> Option<PathBuf> {
    let mut candidates = vec![home().join(r"scoop\apps\git\current\bin\bash.exe")];
    for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(dir) = std::env::var_os(var) {
            candidates.push(PathBuf::from(dir).join(r"Git\bin\bash.exe"));
        }
    }
    if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(dir).join(r"Programs\Git\bin\bash.exe"));
    }
    candidates.into_iter().find(|c| c.is_file())
}

/// This process's PATH plus entries added since it started (scoop adds mpv that way),
/// with the bridge folder first so ani-cli finds `anigui-menu`.
fn build_path(bridge_dir: &Path) -> String {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    let mut parts = vec![bridge_dir.to_string_lossy().into_owned()];
    if let Ok(path) = std::env::var("PATH") {
        parts.push(path);
    }
    let keys = [
        (HKEY_CURRENT_USER, "Environment"),
        (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ];
    for (root, subkey) in keys {
        if let Ok(value) = RegKey::predef(root).open_subkey(subkey).and_then(|k| k.get_value::<String, _>("Path")) {
            parts.push(expand_env(&value));
        }
    }
    parts.join(";")
}

/// Expands %VAR% references the way Windows does for PATH values in the registry.
fn expand_env(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return out;
        };
        let name = &after[..end];
        match std::env::var(name) {
            Ok(v) => out.push_str(&v),
            Err(_) => out.push_str(&format!("%{name}%")),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            // ani-cli finds the bridge on PATH, so it needs to be a real file
            let bridge_dir = app.path().app_local_data_dir()?.join("bridge");
            fs::create_dir_all(&bridge_dir)?;
            fs::write(bridge_dir.join("anigui-menu"), BRIDGE_SCRIPT.replace('\r', ""))?;

            let shader_dir = app.path().app_local_data_dir()?.join("shaders");
            fs::create_dir_all(&shader_dir)?;
            for (name, bytes) in SHADERS {
                let path = shader_dir.join(name);
                if fs::read(&path).ok().as_deref() != Some(*bytes) {
                    fs::write(&path, bytes)?;
                }
            }

            let main_window = app.get_webview_window("main").ok_or("main window not found")?;
            video::set_app(app.handle().clone());
            let video_window = video::create(main_window.hwnd()?.0 as isize);

            app.manage(AppState {
                session: Mutex::new(None),
                bash: find_bash(),
                path_var: build_path(&bridge_dir),
                shader_dir,
                prefs: Arc::new(Mutex::new(PlayerPrefs::default())),
                video_window,
            });

            // the fullscreen control bar, created after the state above: building a window
            // takes long enough that the main page would otherwise call commands too early.
            // Owned by the main window, so it stays above it without floating over other apps.
            tauri::WebviewWindowBuilder::new(app, "controls", tauri::WebviewUrl::App("controls.html".into()))
                .title("AnimeCLI controls")
                .parent(&main_window)?
                .decorations(false)
                .resizable(false)
                .skip_taskbar(true)
                .shadow(false)
                .focused(false)
                .visible(false)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // hide the video right away, without waiting for the page, and tell the page,
            // which brings it back once the size settles (see video::hide). The page's own
            // resize event isn't enough: going fullscreen can end with a Resized here
            // after the page has already re-laid itself out.
            WindowEvent::Resized(_) if window.label() == "main" => {
                video::hide(window.state::<AppState>().video_window);
                let _ = window.emit("video-resize-hide", ());
            }
            WindowEvent::Destroyed => {
                if let Some(s) = window.state::<AppState>().session.lock().unwrap().take() {
                    // the app is exiting, so a background fallback would never run
                    s.stop(true);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            start_session,
            answer,
            stop_session,
            read_history,
            environment,
            set_upscaler,
            set_start_fullscreen,
            set_player_fullscreen,
            set_window_fullscreen,
            show_controls_overlay,
            set_video_cursor_hidden,
            player_command,
            set_video_rect
        ])
        .run(tauri::generate_context!())
        .expect("error while running AnimeCLI");
}
