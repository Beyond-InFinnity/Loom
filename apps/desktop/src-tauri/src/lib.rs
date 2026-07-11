use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

mod mpv;
mod mpv_ffi;
mod mpv_render;
mod video_windows;
use mpv::{mpv_command, mpv_start, mpv_stop, mpv_stop_inner, MpvState};
use video_windows::{
    close_player_windows, set_overlay_interactive, setup_player_windows, sync_overlay,
};
use mpv_render::{
    player_attach, player_command, player_is_muted, player_load, player_set_mute,
    player_stop, RenderEngine,
};

struct SidecarHandle(Mutex<Option<Child>>);

/// Paths into the bundled `resources/` tree populated by
/// `scripts/setup_bundle.sh`.  All members are absolute paths under
/// the Tauri-resolved `resource_dir`.  `is_complete()` reports whether
/// every required artifact is present — incomplete bundles fall back
/// to the legacy dev defaults so a half-built install at least
/// launches with a meaningful error message.
struct BundlePaths {
    python_bin: PathBuf,
    source_dir: PathBuf,
    fonts_dir: PathBuf,
    browsers_dir: PathBuf,
}

impl BundlePaths {
    fn from_resource_dir(resource_dir: &Path) -> Self {
        // python-build-standalone interpreter — venv shim, not the
        // raw runtime.  The shim points back at runtime/cpython-... so
        // we never need to spawn the runtime directly.
        let venv_bin_relative = if cfg!(windows) {
            "python/venv/Scripts/python.exe"
        } else {
            "python/venv/bin/python"
        };
        Self {
            python_bin: resource_dir.join(venv_bin_relative),
            source_dir: resource_dir.join("python/source"),
            fonts_dir: resource_dir.join("fonts"),
            browsers_dir: resource_dir.join("playwright-browsers"),
        }
    }

    fn is_complete(&self) -> bool {
        // Tighter than just "python + source": also require the
        // browsers dir to contain a Playwright chromium-* dir.
        // Without this, a partial bundle (e.g. setup_bundle.sh
        // interrupted) would still take the bundle branch and
        // Playwright would silently fetch Chromium to ~/.cache/ on
        // first preview, defeating the bundle.
        if !self.python_bin.is_file() || !self.source_dir.is_dir() {
            return false;
        }
        std::fs::read_dir(&self.browsers_dir)
            .map(|mut entries| entries.any(|e| e.ok()
                .and_then(|e| e.file_name().into_string().ok())
                .map_or(false, |n| n.starts_with("chromium-"))))
            .unwrap_or(false)
    }
}

fn spawn_sidecar(bundle: Option<BundlePaths>) -> std::io::Result<Child> {
    let port = std::env::var("LOOM_SIDECAR_PORT").unwrap_or_else(|_| "8765".to_string());

    // Resolution order:
    //   1. LOOM_UVICORN explicitly set → dev mode, use that interpreter
    //      against the developer's project root.  Bundle is ignored
    //      even if present.
    //   2. Bundle complete → spawn the bundled python -m uvicorn against
    //      the bundled source dir.
    //   3. Neither → fall back to the legacy hardcoded dev defaults
    //      (matches Connor's setup; deliberately Linux-only).
    let mut cmd = if let Ok(uvicorn) = std::env::var("LOOM_UVICORN") {
        let project_root = std::env::var("LOOM_PROJECT_ROOT")
            .unwrap_or_else(|_| "/home/connor/Documents/projects/Loom".to_string());
        let mut c = Command::new(uvicorn);
        c.args([
            "loom_api.main:app",
            "--host", "127.0.0.1",
            "--port", &port,
        ])
        .current_dir(project_root);
        c
    } else if let Some(b) = bundle.as_ref().filter(|b| b.is_complete()) {
        let mut c = Command::new(&b.python_bin);
        c.args([
            "-m", "uvicorn",
            "loom_api.main:app",
            "--host", "127.0.0.1",
            "--port", &port,
        ])
        .current_dir(&b.source_dir);
        // Strip inherited Python env vars that could pull dev-machine
        // site-packages or pyenv shims into the bundled interpreter's
        // import path.
        c.env_remove("PYTHONHOME");
        c.env_remove("PYTHONPATH");
        c.env_remove("VIRTUAL_ENV");
        // Point Playwright at the bundled Chromium.  Without this the
        // bundled venv's Playwright would download Chromium to
        // ~/.cache/ms-playwright/ on first use, defeating the bundle.
        c.env("PLAYWRIGHT_BROWSERS_PATH", &b.browsers_dir);
        // Helpful for log streaming during dev sessions.
        c.env("PYTHONUNBUFFERED", "1");
        c
    } else {
        let mut c = Command::new("/home/connor/miniconda3/envs/srtstitcher/bin/uvicorn");
        c.args([
            "loom_api.main:app",
            "--host", "127.0.0.1",
            "--port", &port,
        ])
        .current_dir("/home/connor/Documents/projects/Loom");
        c
    };

    cmd.stdout(Stdio::inherit()).stderr(Stdio::inherit());

    // LOOM_FONT_DIR — explicit env var wins (dev override).  Otherwise
    // use the bundle's fonts dir when present.  Leaving the var unset
    // makes the FontScanner fall back to system fonts — appropriate
    // for a dev checkout that hasn't run setup_bundle.sh.
    if let Ok(explicit) = std::env::var("LOOM_FONT_DIR") {
        cmd.env("LOOM_FONT_DIR", explicit);
    } else if let Some(b) = bundle.as_ref() {
        if b.fonts_dir.is_dir() {
            cmd.env("LOOM_FONT_DIR", &b.fonts_dir);
        }
    }

    cmd.spawn()
}

fn kill_sidecar(state: &SidecarHandle) {
    if let Some(mut child) = state.0.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarHandle(Mutex::new(None)))
        .manage(MpvState(Mutex::new(None)))
        .manage(RenderEngine::default())
        .invoke_handler(tauri::generate_handler![
            mpv_start, mpv_command, mpv_stop,
            setup_player_windows, set_overlay_interactive, close_player_windows,
            player_attach, player_load, player_command, player_stop,
            player_set_mute, player_is_muted
        ])
        .setup(|app| {
            let bundle = app.path().resource_dir().ok()
                .map(|d| BundlePaths::from_resource_dir(&d));
            let child = spawn_sidecar(bundle)?;
            let state = app.state::<SidecarHandle>();
            *state.0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { .. } => {
                    // Only the MAIN window's close tears the app down; the
                    // video/overlay pair closes without killing the sidecar.
                    if window.label() == "main" {
                        kill_sidecar(&window.state::<SidecarHandle>());
                        mpv_stop_inner(&window.state::<MpvState>());
                    } else if window.label() == video_windows::VIDEO_LABEL {
                        mpv_stop_inner(&window.state::<MpvState>());
                        if let Some(o) = window
                            .app_handle()
                            .get_webview_window(video_windows::OVERLAY_LABEL)
                        {
                            let _ = o.close();
                        }
                    }
                }
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    if window.label() == video_windows::VIDEO_LABEL {
                        sync_overlay(window.app_handle());
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(&app_handle.state::<SidecarHandle>());
                mpv_stop_inner(&app_handle.state::<MpvState>());
            }
        });
}
