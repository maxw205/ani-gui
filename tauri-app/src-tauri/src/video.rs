//! The native window mpv draws into (`--wid`), placed over the video area of the page.
//!
//! The webview can't show mpv's output itself, so this black child window sits on top
//! of it, inside the app's main window, and the frontend reports where the video area
//! is so it can be moved and resized to match.

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, LoadCursorW, RegisterClassW, SetWindowPos, HWND_TOP, IDC_ARROW, SWP_HIDEWINDOW,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, WNDCLASSW, WS_CHILD, WS_CLIPCHILDREN,
    WS_CLIPSIBLINGS,
};

unsafe extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    DefWindowProcW(hwnd, msg, wparam, lparam)
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
