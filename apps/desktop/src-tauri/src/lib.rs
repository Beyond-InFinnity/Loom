use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

mod font_metrics;
mod mpv_ffi;
mod mpv_render;
mod settings_store;
use font_metrics::player_font_advance_ratios;
use mpv_render::{
    player_add_loom_subs, player_attach, player_command, player_dom_dirty, player_is_muted,
    player_load, player_set_mute, player_stop, player_track_list, RenderEngine,
};
use settings_store::{settings_get_all, settings_remove, settings_set, SettingsStore};

// Xlib: make the X client library thread-safe.  The EGL render path (see
// mpv_render.rs) drives eglSwapBuffers from a DEDICATED render thread while the
// GTK main thread keeps handling events, input forwarding, and the WebKit
// snapshot — so TWO threads talk to the X server.  Without XInitThreads() (which
// MUST run before the first Xlib call, i.e. before GTK opens its X connection),
// that races the X protocol stream → intermittent BadRequest/IO crashes.  mpv
// itself does exactly this when embedded.  No-op cost when the EGL path is off.
#[link(name = "X11")]
extern "C" {
    fn XInitThreads() -> std::os::raw::c_int;
}

struct SidecarHandle(Mutex<Option<Child>>);

/// Request NVIDIA PRIME render offload BEFORE any GL/GTK init.
///
/// On a hybrid-GPU (Optimus) X11 box the GL context defaults to the Intel iGPU
/// that drives the display — and NVIDIA's CUDA can't interop with an Intel GL
/// context (`cuGLGetDevices` → CUDA_ERROR_INVALID_GRAPHICS_CONTEXT).  So mpv's
/// render API is forced onto `hwdec=*-copy`, a per-frame 4K GPU→RAM→GPU
/// roundtrip that caps 4K playback at ~15 fps (measured; decode itself is
/// 50–60 fps).  Putting our GL context on the NVIDIA GPU lets `cuda-nvdec`
/// ZERO-COPY decode engage — the real fix for 4K smoothness.
///
/// Gated hard on the NVIDIA driver AND its GLX vendor lib both being present,
/// so an Intel/AMD-only machine is NEVER forced onto a missing vendor (which
/// would break GL entirely).  Sets `LOOM_PRIME_ACTIVE` so the render engine
/// picks the zero-copy hwdec default.  Escape hatch: `LOOM_NO_PRIME=1`.  Must
/// run before the first GLX call (window creation), hence first in `run()`.
fn enable_gpu_offload() {
    // OPT-IN ONLY (LOOM_PRIME=1).  Forcing the NVIDIA GLX vendor makes GDK's
    // GtkGLArea fail to create its GL context on this stack —
    // "No available configurations for the given RGBA pixel format": the
    // transparent window's RGBA (32-bit) visual has no matching NVIDIA GLX
    // FBConfig under PRIME.  So it stays OFF by default (app runs on the Intel
    // GL context with hwdec=auto-copy — the shipped behavior, no regression).
    // Kept behind the flag for the zero-copy investigation (needs a native
    // NVIDIA GL video surface, not GtkGLArea, to actually work — see notes).
    if std::env::var("LOOM_PRIME").as_deref() != Ok("1") {
        return;
    }
    if std::env::var_os("LOOM_NO_PRIME").is_some() {
        return;
    }
    // Respect an explicit vendor choice the user/environment already made.
    if std::env::var_os("__GLX_VENDOR_LIBRARY_NAME").is_some() {
        // If they pointed us at NVIDIA, still flag zero-copy as available.
        if std::env::var("__GLX_VENDOR_LIBRARY_NAME").as_deref() == Ok("nvidia") {
            std::env::set_var("LOOM_PRIME_ACTIVE", "1");
        }
        return;
    }
    // NVIDIA usable = kernel driver loaded AND the GLX vendor lib present.
    let driver_loaded = Path::new("/dev/nvidiactl").exists()
        || Path::new("/proc/driver/nvidia/version").exists();
    let vendor_lib = [
        "/usr/lib/x86_64-linux-gnu/libGLX_nvidia.so.0",
        "/usr/lib64/libGLX_nvidia.so.0",
        "/usr/lib/libGLX_nvidia.so.0",
        "/usr/lib/x86_64-linux-gnu/nvidia/current/libGLX_nvidia.so.0",
    ]
    .iter()
    .any(|p| Path::new(p).exists());
    if !driver_loaded || !vendor_lib {
        return; // no working NVIDIA → leave the default GL vendor untouched
    }
    // PRIME offload: render on NVIDIA, present to the Intel-driven display.
    std::env::set_var("__NV_PRIME_RENDER_OFFLOAD", "1");
    std::env::set_var("__GLX_VENDOR_LIBRARY_NAME", "nvidia");
    std::env::set_var("LOOM_PRIME_ACTIVE", "1");
    eprintln!(
        "[Loom] NVIDIA PRIME render offload enabled → zero-copy hwdec path (set LOOM_NO_PRIME=1 to disable)"
    );
}

/// Dev/perf-testing convenience: if `LOOM_OPEN=<path>` is set, the frontend
/// auto-loads that file on launch (and fullscreens on the 4K monitor) so a
/// render-perf run is a single command with no clicking.  Returns None in
/// normal use.
#[tauri::command]
fn player_launch_file() -> Option<String> {
    std::env::var("LOOM_OPEN").ok().filter(|s| !s.is_empty())
}

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
    // MUST be the very first thing: make Xlib thread-safe before ANY X call
    // (GTK opens the X connection during build below).  The EGL render thread
    // and the GTK main thread both talk to X — this is what keeps that safe.
    unsafe { XInitThreads() };
    // MUST be first: requests NVIDIA PRIME offload before any GLX/GTK init so
    // the video GL context lands on the NVIDIA GPU (enables zero-copy decode).
    enable_gpu_offload();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SidecarHandle(Mutex::new(None)))
        .manage(RenderEngine::default())
        .manage(SettingsStore::load())
        .invoke_handler(tauri::generate_handler![
            player_attach, player_load, player_command, player_stop,
            player_set_mute, player_is_muted, player_track_list, player_add_loom_subs,
            player_dom_dirty, player_font_advance_ratios, player_launch_file,
            settings_get_all, settings_set, settings_remove
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
            // Single integrated window: closing "main" tears the app down.
            if let WindowEvent::CloseRequested { .. } = event {
                if window.label() == "main" {
                    kill_sidecar(&window.state::<SidecarHandle>());
                    // Free the render engine on the GTK main thread, in order.
                    mpv_render::player_teardown(window.app_handle());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(&app_handle.state::<SidecarHandle>());
                mpv_render::player_teardown(app_handle);
            }
        });
}
