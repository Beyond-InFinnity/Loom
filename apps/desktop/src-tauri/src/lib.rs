use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

struct SidecarHandle(Mutex<Option<Child>>);

fn spawn_sidecar() -> std::io::Result<Child> {
    // Dev mode: rely on the developer's existing Python env. The defaults
    // match Connor's setup; override via env if your interpreter or repo
    // root lives elsewhere. Production bundling (step 3c) replaces this
    // with a packaged Python runtime and embedded loom_api wheel.
    let uvicorn = std::env::var("LOOM_UVICORN")
        .unwrap_or_else(|_| "/home/connor/miniconda3/envs/srtstitcher/bin/uvicorn".to_string());
    let project_root = std::env::var("LOOM_PROJECT_ROOT")
        .unwrap_or_else(|_| "/home/connor/Documents/projects/Loom".to_string());
    let port = std::env::var("LOOM_SIDECAR_PORT").unwrap_or_else(|_| "8765".to_string());

    Command::new(uvicorn)
        .args([
            "loom_api.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            &port,
        ])
        .current_dir(project_root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .spawn()
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
        .manage(SidecarHandle(Mutex::new(None)))
        .setup(|app| {
            let child = spawn_sidecar()?;
            let state = app.state::<SidecarHandle>();
            *state.0.lock().unwrap() = Some(child);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                kill_sidecar(&window.state::<SidecarHandle>());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                kill_sidecar(&app_handle.state::<SidecarHandle>());
            }
        });
}
