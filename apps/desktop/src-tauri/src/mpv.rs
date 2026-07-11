// Loom Player — mpv process engine over JSON IPC (7c, MOBILE_ROADMAP.md).
//
// Spawns the SYSTEM mpv binary with --input-ipc-server and drives it over
// the unix socket: fire-and-forget commands in, property-change events out
// (re-emitted as Tauri events the webview subscribes to).  No libmpv
// linkage — both Tauri mpv plugins report window embedding broken on
// Linux, so the MVP runs mpv in its OWN window (subtitles rendered
// natively by libass from Loom's generated 4-layer .ass) while the Tauri
// window is the interactive surface.  The webview-side PlayheadSource is
// fed exclusively by the observed `time-pos` / `pause` properties.
//
// Command replies are deliberately not routed back (no request_id
// bookkeeping): everything the UI needs to KNOW arrives via observed
// properties; everything it needs to DO is a command.  Linux-only for the
// MVP (unix socket); Windows named-pipe support lands with the Windows
// embed track.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};

#[cfg(unix)]
use std::os::unix::net::UnixStream;

pub struct MpvState(pub Mutex<Option<MpvProc>>);

pub struct MpvProc {
    child: Child,
    #[cfg(unix)]
    sock: UnixStream,
    sock_path: String,
}

/// Properties the webview's PlayheadSource + transport UI live off.
const OBSERVED_PROPERTIES: &[&str] = &[
    "time-pos",
    "pause",
    "duration",
    "eof-reached",
    "path",
    "track-list",
];

#[cfg(unix)]
fn connect_with_retry(sock_path: &str, timeout: Duration) -> std::io::Result<UnixStream> {
    let deadline = Instant::now() + timeout;
    loop {
        match UnixStream::connect(sock_path) {
            Ok(s) => return Ok(s),
            Err(e) => {
                if Instant::now() >= deadline {
                    return Err(e);
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        }
    }
}

/// Spawn mpv playing `media_path`, wire the IPC socket, start the event
/// pump.  Kills any previous instance first (one player at a time).
#[tauri::command]
pub fn mpv_start(
    app: AppHandle,
    state: State<MpvState>,
    media_path: String,
    extra_args: Vec<String>,
    wid: Option<u64>,
) -> Result<(), String> {
    #[cfg(not(unix))]
    {
        return Err("Loom Player MVP is Linux-only (unix IPC socket)".into());
    }

    #[cfg(unix)]
    {
        mpv_stop_inner(&state);

        let sock_path = format!(
            "/tmp/loom-mpv-{}-{}.sock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        );

        let mut cmd = Command::new("mpv");
        cmd.arg(format!("--input-ipc-server={}", sock_path))
            // Keep playback up at EOF so the playhead/gloss stay usable
            // over the last line; the user closes via Loom or the window.
            .arg("--keep-open=yes")
            .arg("--force-window=yes")
            // The caption stack is Loom's DOM overlay (MOBILE_ROADMAP.md §5
            // — .ass is never the core render path); the media's own
            // subtitle tracks stay unselected.
            .arg("--sid=no")
            .args(&extra_args)
            .arg(&media_path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(xid) = wid {
            // Dual-window embed: render into the Loom-owned video window
            // (video_windows.rs).  mpv must not grab keyboard focus games;
            // input stays with the Loom windows.
            cmd.arg(format!("--wid={}", xid));
        }

        let child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn mpv (is it installed?): {e}"))?;

        let sock = connect_with_retry(&sock_path, Duration::from_secs(5))
            .map_err(|e| format!("mpv IPC socket never appeared: {e}"))?;

        // Observe the properties the UI lives off.  Fire-and-forget; the
        // success replies are ignored by the pump.
        {
            let mut w = sock.try_clone().map_err(|e| e.to_string())?;
            for (i, prop) in OBSERVED_PROPERTIES.iter().enumerate() {
                let msg = json!({ "command": ["observe_property", i + 1, prop] });
                let line = format!("{}\n", msg);
                w.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            }
        }

        // Event pump: every property-change / event line becomes a Tauri
        // event.  Thread ends when the socket closes (mpv quit).
        {
            let reader_sock = sock.try_clone().map_err(|e| e.to_string())?;
            let app = app.clone();
            std::thread::spawn(move || {
                let reader = BufReader::new(reader_sock);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    let Ok(v) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    match v.get("event").and_then(Value::as_str) {
                        Some("property-change") => {
                            let _ = app.emit(
                                "mpv-prop",
                                json!({
                                    "name": v.get("name"),
                                    "data": v.get("data"),
                                }),
                            );
                        }
                        Some(other) => {
                            let _ = app.emit("mpv-event", json!({ "event": other }));
                        }
                        None => {} // command reply — deliberately ignored
                    }
                }
                let _ = app.emit("mpv-event", json!({ "event": "ipc-closed" }));
            });
        }

        *state.0.lock().unwrap() = Some(MpvProc {
            child,
            sock,
            sock_path,
        });
        Ok(())
    }
}

/// Send one raw mpv command array, e.g. ["set_property","pause",true] or
/// ["sub-add","http://localhost:8765/files/<id>","select","Loom"].
#[tauri::command]
pub fn mpv_command(state: State<MpvState>, command: Vec<Value>) -> Result<(), String> {
    #[cfg(unix)]
    {
        let mut guard = state.0.lock().unwrap();
        let Some(proc) = guard.as_mut() else {
            return Err("mpv is not running".into());
        };
        let msg = json!({ "command": command });
        let line = format!("{}\n", msg);
        proc.sock
            .write_all(line.as_bytes())
            .map_err(|e| format!("mpv IPC write failed: {e}"))
    }
    #[cfg(not(unix))]
    {
        let _ = (state, command);
        Err("Loom Player MVP is Linux-only".into())
    }
}

#[tauri::command]
pub fn mpv_stop(state: State<MpvState>) {
    mpv_stop_inner(&state);
}

pub fn mpv_stop_inner(state: &MpvState) {
    if let Some(mut proc) = state.0.lock().unwrap().take() {
        // Polite quit first (flushes mpv's own state), then the hammer.
        #[cfg(unix)]
        {
            let _ = proc
                .sock
                .write_all(b"{\"command\":[\"quit\"]}\n");
        }
        std::thread::sleep(Duration::from_millis(150));
        let _ = proc.child.kill();
        let _ = proc.child.wait();
        let _ = std::fs::remove_file(&proc.sock_path);
    }
}
