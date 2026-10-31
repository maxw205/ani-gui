//! The native window mpv draws into (`--wid`), placed over the video area of the page.
//!
//! The webview can't show mpv's output itself, so this black child window sits on top
//! of it, inside the app's main window, and the frontend reports where the video area
//! is so it can be moved and resized to match.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, LoadCursorW, RegisterClassW, SetCursor, SetWindowPos, ShowWindow, HWND_TOP,
    IDC_ARROW, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SW_HIDE,
    SW_SHOWNOACTIVATE, WM_MOUSEMOVE, WM_SETCURSOR, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
};

// mpv disables its own window when embedded, so mouse moves over the video land here.
// They're forwarded to the page as `video-mouse` events, which shows the fullscreen
// controls; the page hides the cursor again when the controls hide.
static APP: OnceLock<AppHandle> = OnceLock::new();
static CURSOR_HIDDEN: AtomicBool = AtomicBool::new(false);
static LAST_MOVE_MS: AtomicU64 = AtomicU64::new(0);
// Windows also sends WM_MOUSEMOVE, at the same position, when a window appears or
// disappears under a still cursor (e.g. the controls hiding); those aren't moves
static LAST_MOUSE_POS: AtomicU64 = AtomicU64::new(u64::MAX);
const MOVE_EVENT_GAP_MS: u64 = 200;

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

/// Hides the cursor over the video until the mouse next moves.
pub fn set_cursor_hidden(hidden: bool) {
    CURSOR_HIDDEN.store(hidden, Ordering::SeqCst);
}

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_SETCURSOR if CURSOR_HIDDEN.load(Ordering::SeqCst) => {
            SetCursor(std::ptr::null_mut());
            return 1;
        }
        WM_MOUSEMOVE if LAST_MOUSE_POS.swap(lparam as u32 as u64, Ordering::SeqCst) == lparam as u32 as u64 => {}
        WM_MOUSEMOVE => {
            if CURSOR_HIDDEN.swap(false, Ordering::SeqCst) {
                SetCursor(LoadCursorW(std::ptr::null_mut(), IDC_ARROW));
            }
            let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            if now.saturating_sub(LAST_MOVE_MS.load(Ordering::SeqCst)) >= MOVE_EVENT_GAP_MS {
                LAST_MOVE_MS.store(now, Ordering::SeqCst);
                if let Some(app) = APP.get() {
                    let _ = app.emit("video-mouse", "move");
                }
            }
        }
        _ => {}
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Shows a top-level window without giving it the keyboard (the fullscreen controls),
/// or hides it. Both go through Win32: Tauri doesn't see a window shown this way, so
/// its own hide() would think the window is already hidden and do nothing.
pub fn set_visible_without_focus(hwnd: isize, visible: bool) {
    unsafe {
        ShowWindow(hwnd as HWND, if visible { SW_SHOWNOACTIVATE } else { SW_HIDE });
    }
}

/// Creates the (hidden) video window as a child of `parent` and returns its handle.
/// Must run on the thread that owns `parent`.
pub fn create(parent: isize) -> isize {
    let class: Vec<u16> = "AnimeCliVideo\0".encode_utf16().collect();
    unsafe {
        let instance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSW {
            style: 0,
            lpfnWndProc: Some(window_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: instance,
            hIcon: std::ptr::null_mut(),
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
            hbrBackground: GetStockObject(BLACK_BRUSH),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class.as_ptr(),
        };
        RegisterClassW(&wc);
        CreateWindowExW(
            0,
            class.as_ptr(),
            std::ptr::null(),
            WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
            0,
            0,
            0,
            0,
            parent as HWND,
            std::ptr::null_mut(),
            instance,
            std::ptr::null(),
        ) as isize
    }
}

/// Hides the video window where it is.
///
/// Used the moment the app window starts resizing: the page re-lays itself out every
/// frame and this window can only follow one frame later, so it would hang over the
/// controls (shrinking) or leave gaps (growing). The page shows it again once the size
/// has settled.
pub fn hide(hwnd: isize) {
    unsafe {
        SetWindowPos(hwnd as HWND, std::ptr::null_mut(), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_HIDEWINDOW);
    }
}

/// Moves the video window to the given rectangle (physical pixels, relative to the
/// main window's client area), above the webview, and shows or hides it.
pub fn place(hwnd: isize, x: i32, y: i32, width: i32, height: i32, visible: bool) {
    let flags = SWP_NOACTIVATE | if visible { SWP_SHOWWINDOW } else { SWP_HIDEWINDOW };
    unsafe {
        SetWindowPos(hwnd as HWND, HWND_TOP, x, y, width.max(1), height.max(1), flags);
    }
}
