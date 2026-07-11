// Dual-window video architecture (7c-5, MOBILE_ROADMAP.md §5).
//
// Connor's decision: .ass is never the Player's core rendering format (no
// relative positioning → furigana alignment is guesswork).  The caption
// stack renders as DOM.  Same-window webview-over-mpv compositing is broken
// on Linux, so the Player uses TWO windows Loom owns:
//
//   loom-video   — a Tauri window whose X11 id is handed to mpv via --wid;
//                  mpv renders its GL surface into it, so Loom controls the
//                  window's size/position/lifecycle.
//   loom-overlay — transparent, undecorated, always-on-top, skip-taskbar;
//                  carries the DOM caption stack (overlay.html).  Kept
//                  glued to loom-video's inner rect by the window-event
//                  hook in lib.rs (both windows are ours — event-driven
//                  sync, no foreign-window polling).  Cursor events are
//                  ignored while playing and enabled on pause (the gloss).
//
// X11-only (like the mpv IPC socket).  Wayland/Windows land with their own
// embed tracks; the overlay PAYLOAD is identical everywhere.

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder};

pub const VIDEO_LABEL: &str = "loom-video";
pub const OVERLAY_LABEL: &str = "loom-overlay";

/// Create (or reuse) the video + overlay windows and return the video
/// window's X11 id for mpv's --wid.
#[tauri::command]
pub fn setup_player_windows(app: AppHandle) -> Result<u64, String> {
    let video = match app.get_webview_window(VIDEO_LABEL) {
        Some(w) => w,
        None => WebviewWindowBuilder::new(
            &app,
            VIDEO_LABEL,
            WebviewUrl::App("video.html".into()),
        )
        .title("Loom Player — Video")
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e| format!("video window: {e}"))?,
    };

    let xid = x11_window_id(&video)?;

    if app.get_webview_window(OVERLAY_LABEL).is_none() {
        let overlay = WebviewWindowBuilder::new(
            &app,
            OVERLAY_LABEL,
            WebviewUrl::App("overlay.html".into()),
        )
        .title("Loom Player — Overlay")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .inner_size(1280.0, 720.0)
        .build()
        .map_err(|e| format!("overlay window: {e}"))?;
        // Start click-through; the webview flips this on pause via the
        // set_overlay_interactive command.
        let _ = overlay.set_ignore_cursor_events(true);
    }

    sync_overlay(&app);
    Ok(xid)
}

fn x11_window_id(window: &tauri::WebviewWindow) -> Result<u64, String> {
    let handle = window
        .window_handle()
        .map_err(|e| format!("window handle: {e}"))?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(h) => Ok(h.window),
        RawWindowHandle::Xcb(h) => Ok(h.window.get() as u64),
        other => Err(format!(
            "not an X11 window handle ({other:?}) — the dual-window embed is X11-only today",
        )),
    }
}

/// Glue the overlay to the video window's inner rect.  Called from the
/// lib.rs window-event hook on every move/resize of loom-video.
pub fn sync_overlay(app: &AppHandle) {
    let (Some(video), Some(overlay)) = (
        app.get_webview_window(VIDEO_LABEL),
        app.get_webview_window(OVERLAY_LABEL),
    ) else {
        return;
    };
    let (Ok(pos), Ok(size)) = (video.inner_position(), video.inner_size()) else {
        return;
    };
    let _ = overlay.set_position(PhysicalPosition::new(pos.x, pos.y));
    let _ = overlay.set_size(PhysicalSize::new(size.width, size.height));
}

/// Pause-gloss pointer flip: interactive overlay while paused, click-through
/// while playing.
#[tauri::command]
pub fn set_overlay_interactive(app: AppHandle, interactive: bool) -> Result<(), String> {
    let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) else {
        return Err("overlay window not created".into());
    };
    overlay
        .set_ignore_cursor_events(!interactive)
        .map_err(|e| e.to_string())
}

/// Tear both windows down (leaving the Player view).
#[tauri::command]
pub fn close_player_windows(app: AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.close();
    }
    if let Some(w) = app.get_webview_window(VIDEO_LABEL) {
        let _ = w.close();
    }
}
