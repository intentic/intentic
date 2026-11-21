//! The notice that someone is connected, on the secure desktop. remoted's own notice lives on the person's desktop;
//! while a sign-in screen, a UAC prompt or Ctrl+Alt+Del takes input instead, the person at the computer would not see
//! it, so the helper (which may draw there, as SYSTEM) puts a strip at the top of the primary monitor while any monitor
//! is duplicated for a viewer and the input desktop is not the person's own.
//!
//! A window belongs to the desktop its thread is on, and a thread with a window cannot move to another desktop, so
//! each showing is a thread of its own: it moves to the input desktop, draws, and ends (its window with it) when the
//! notice should go or the desktop changes.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use windows::Win32::Foundation::{COLORREF, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{
    BeginPaint, CreateSolidBrush, DT_CENTER, DT_SINGLELINE, DT_VCENTER, DeleteObject, DrawTextW,
    EndPaint, FillRect, PAINTSTRUCT, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, OpenInputDesktop, SetThreadDesktop,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetSystemMetrics, MSG,
    PM_REMOVE, PeekMessageW, RegisterClassW, SM_CXSCREEN, SW_SHOWNOACTIVATE, ShowWindow,
    TranslateMessage, WINDOW_EX_STYLE, WM_PAINT, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_EX_TOPMOST, WS_POPUP,
};
use windows::core::w;

const TEXT: &str = "Someone is connected to this computer through Intentic and can see this screen";

/// Watches `watched` (how many monitors are duplicated) and the input desktop for the process's life, showing the
/// notice on a secure desktop while it is above zero.
pub fn spawn(watched: Arc<AtomicUsize>) {
    let started = std::thread::Builder::new()
        .name("notice".into())
        .spawn(move || {
            let mut showing: Option<(String, Arc<AtomicBool>)> = None;
            loop {
                let desktop = crate::input_desktop_name();
                let want = watched.load(Ordering::Relaxed) > 0
                    && desktop
                        .as_deref()
                        .is_some_and(|d| !d.eq_ignore_ascii_case("Default"));
                let same = matches!((&showing, &desktop), (Some((on, _)), Some(d)) if on == d);
                if (!want || !same)
                    && let Some((_, stop)) = showing.take()
                {
                    stop.store(true, Ordering::Relaxed);
                }
                if want && showing.is_none() {
                    let stop = Arc::new(AtomicBool::new(false));
                    let flag = stop.clone();
                    if std::thread::Builder::new()
                        .name("notice-window".into())
                        .spawn(move || show(&flag))
                        .is_ok()
                    {
                        showing = Some((desktop.unwrap_or_default(), stop));
                    }
                }
                std::thread::sleep(Duration::from_millis(500));
            }
        });
    if let Err(e) = started {
        log::warn!("no notice on the secure desktop: {e}");
    }
}

/// Moves this thread to the input desktop and keeps the strip there until `stop`.
fn show(stop: &AtomicBool) {
    extern "system" fn proc(hwnd: HWND, msg: u32, wp: WPARAM, lp: LPARAM) -> LRESULT {
        if msg == WM_PAINT {
            let mut ps = PAINTSTRUCT::default();
            // SAFETY: painting this window between BeginPaint and EndPaint; the brush is freed after use.
            unsafe {
                let dc = BeginPaint(hwnd, &mut ps);
                let mut r: RECT = ps.rcPaint;
                let brush = CreateSolidBrush(COLORREF(0x0020_2020));
                FillRect(dc, &r, brush);
                let _ = DeleteObject(brush.into());
                SetBkMode(dc, TRANSPARENT);
                SetTextColor(dc, COLORREF(0x00ff_ffff));
                let mut text = crate::displays::wide(TEXT);
                text.pop();
                DrawTextW(
                    dc,
                    &mut text,
                    &mut r,
                    DT_CENTER | DT_VCENTER | DT_SINGLELINE,
                );
                let _ = EndPaint(hwnd, &ps);
            }
            return LRESULT(0);
        }
        // SAFETY: the default handling of a window this thread made.
        unsafe { DefWindowProcW(hwnd, msg, wp, lp) }
    }
    // GENERIC_ALL: this thread draws there.
    // SAFETY: the input desktop, set as this thread's before it makes any window; closed when the thread is done.
    let Ok(desk) = (unsafe {
        OpenInputDesktop(
            DESKTOP_CONTROL_FLAGS(0),
            false,
            DESKTOP_ACCESS_FLAGS(0x1000_0000),
        )
    }) else {
        return;
    };
    // SAFETY: as above.
    if unsafe { SetThreadDesktop(desk) }.is_err() {
        // SAFETY: the handle opened above.
        let _ = unsafe { CloseDesktop(desk) };
        return;
    }
    // SAFETY: a window class (registered once per desktop; a second registration fails harmlessly) and a popup window
    // of this thread, destroyed before it returns.
    unsafe {
        let inst = GetModuleHandleW(None).unwrap_or_default();
        let class = WNDCLASSW {
            lpfnWndProc: Some(proc),
            hInstance: inst.into(),
            lpszClassName: w!("intentic-remote-notice"),
            ..Default::default()
        };
        RegisterClassW(&class);
        let width = 900.min(GetSystemMetrics(SM_CXSCREEN));
        let left = (GetSystemMetrics(SM_CXSCREEN) - width) / 2;
        let ex: WINDOW_EX_STYLE = WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW;
        let Ok(hwnd) = CreateWindowExW(
            ex,
            w!("intentic-remote-notice"),
            w!("Intentic"),
            WS_POPUP,
            left,
            0,
            width,
            40,
            None,
            None,
            Some(inst.into()),
            None,
        ) else {
            let _ = CloseDesktop(desk);
            return;
        };
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        let mut msg = MSG::default();
        while !stop.load(Ordering::Relaxed) {
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = DestroyWindow(hwnd);
        let _ = CloseDesktop(desk);
    }
}
