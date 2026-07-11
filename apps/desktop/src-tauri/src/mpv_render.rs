// Loom Player single-window render engine (MOBILE_ROADMAP.md §5a).
//
// Replaces the IPC-to-system-mpv engine (mpv.rs) for the Player: links
// libmpv directly and drives its OpenGL render API into a GtkGLArea that
// sits BEHIND the Tauri window's (transparent) webview in a GtkOverlay —
// one integrated window, video + DOM caption stack + controls, like VLC.
//
// Proven end-to-end by the standalone spike (spike/mpv-render); this is
// that spike wired into Tauri's own GTK window (webview reparented via
// gtk_window()/default_vbox()).
//
// Thread model: the mpv client handle is thread-safe (commands + the event
// pump run off the GTK thread); the render context is touched ONLY on the
// GTK main thread (the GL thread — GtkGLArea render signal).  Property
// changes are re-emitted as the SAME "mpv-prop" Tauri event the IPC engine
// used, so the frontend PlayheadSource (src/player/mpv.ts) is unchanged.
//
// X11/Linux for now (Wayland + Windows are separate embed tracks).

use std::ffi::{c_void, CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use gtk::prelude::*;
use gtk::glib;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mpv_ffi::*;

const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

/// Wraps the raw mpv handle so it can cross threads (the client API is
/// thread-safe; the render context is NOT and never leaves the GTK thread).
struct MpvHandle(*mut mpv_handle);
unsafe impl Send for MpvHandle {}

#[derive(Default)]
pub struct RenderEngine {
    inner: Mutex<Option<MpvHandle>>,
    running: Arc<AtomicBool>,
}

// The render context lives on the GTK main thread only.
thread_local! {
    static RENDER_CTX: std::cell::Cell<*mut mpv_render_context> =
        std::cell::Cell::new(ptr::null_mut());
}

extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let n = unsafe { CStr::from_ptr(name) };
    epoxy::get_proc_addr(n.to_str().unwrap_or("")) as *mut c_void
}

struct UpdateBridge {
    tx: glib::Sender<()>,
}
extern "C" fn on_mpv_update(ctx: *mut c_void) {
    let bridge = unsafe { &*(ctx as *const UpdateBridge) };
    let _ = bridge.tx.send(());
}

fn set_opt(mpv: *mut mpv_handle, name: &str, val: &str) {
    let n = CString::new(name).unwrap();
    let v = CString::new(val).unwrap();
    unsafe { mpv_set_option_string(mpv, n.as_ptr(), v.as_ptr()) };
}

/// One-time epoxy load so GL symbols resolve for both mpv and our FBO query.
fn ensure_epoxy() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let lib =
            unsafe { libloading::Library::new("libepoxy.so.0").expect("libepoxy.so.0") };
        epoxy::load_with(|name| unsafe {
            lib.get::<*const c_void>(name.as_bytes())
                .map(|s| *s)
                .unwrap_or(ptr::null())
        });
        std::mem::forget(lib);
    });
}

/// Attach the video surface to the Player window: reparent its webview into
/// a GtkOverlay whose base is a GtkGLArea, create mpv + the render context,
/// and start the property event pump.  Idempotent per process (a second
/// call is a no-op if already attached).
#[tauri::command]
pub fn player_attach(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    let state: State<RenderEngine> = app.state();
    if state.inner.lock().unwrap().is_some() {
        return Ok(()); // already attached
    }

    let gtk_window = window.gtk_window().map_err(|e| format!("gtk_window: {e}"))?;
    let vbox = window.default_vbox().map_err(|e| format!("default_vbox: {e}"))?;

    ensure_epoxy();

    // libmpv needs a C numeric locale; GTK set the user locale at init.
    unsafe {
        let c = CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, c.as_ptr());
    }
    let mpv = unsafe { mpv_create() };
    if mpv.is_null() {
        return Err("mpv_create returned null".into());
    }
    set_opt(mpv, "vo", "libmpv"); // use the render API, not a window
    set_opt(mpv, "hwdec", "no");
    set_opt(mpv, "terminal", "no");
    set_opt(mpv, "sid", "no"); // captions are Loom's DOM overlay, not libass
    if unsafe { mpv_initialize(mpv) } < 0 {
        unsafe { mpv_terminate_destroy(mpv) };
        return Err("mpv_initialize failed".into());
    }

    // Observe the properties the frontend PlayheadSource lives off.
    for (id, name) in [(1u64, "time-pos"), (2, "pause"), (3, "duration"), (4, "eof-reached")] {
        let cname = CString::new(name).unwrap();
        let fmt = if name == "pause" || name == "eof-reached" {
            MPV_FORMAT_FLAG
        } else {
            MPV_FORMAT_DOUBLE
        };
        unsafe { mpv_observe_property(mpv, id, cname.as_ptr(), fmt) };
    }

    // ---- GTK surgery: gtk_window → GtkOverlay { GtkGLArea, webview } -----
    //
    // Tauri's Linux edge-resize handler hardcodes `webview.parent().parent()
    // == gtk::Window` (undecorated_resizing.rs) — the default tree is
    // Window → vbox → webview (2 levels).  So we must keep the webview
    // EXACTLY 2 levels below the window: pull the webview out of Tauri's
    // vbox and make the GtkOverlay the window's direct child holding
    // [GLArea (base), webview (overlay)].  Inserting the overlay ABOVE the
    // vbox (3 levels) makes that downcast get the GtkOverlay and panic.
    let webview_widget = vbox
        .children()
        .into_iter()
        .next()
        .ok_or("Tauri vbox has no webview child")?;
    gtk_window.remove(&vbox);
    vbox.remove(&webview_widget);
    let overlay = gtk::Overlay::new();
    let glarea = gtk::GLArea::new();
    glarea.set_has_alpha(false);
    // Let GTK pick the context type (GLES/desktop) that matches the
    // system/webkit stack — forcing desktop GL segfaults libmpv when the
    // realized context is GLES.
    glarea.set_auto_render(false);
    overlay.add(&glarea);
    overlay.add_overlay(&webview_widget); // webview on top, transparent
    gtk_window.add(&overlay);

    let (tx, rx) = glib::MainContext::channel::<()>(glib::Priority::default());
    let bridge = Box::into_raw(Box::new(UpdateBridge { tx }));
    let mpv_addr = mpv as usize;

    // Create the render context once the GL context is realized.
    {
        let bridge_addr = bridge as usize;
        glarea.connect_realize(move |area| {
            area.make_current();
            if let Some(e) = area.error() {
                eprintln!("[Loom mpv] GLArea realize error: {e}");
                return;
            }
            let mut init = mpv_opengl_init_params {
                get_proc_address: Some(get_proc_address),
                get_proc_address_ctx: ptr::null_mut(),
                extra_exts: ptr::null(),
            };
            let mut params = [
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_API_TYPE,
                    data: MPV_RENDER_API_TYPE_OPENGL.as_ptr() as *mut c_void,
                },
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_OPENGL_INIT_PARAMS,
                    data: &mut init as *mut _ as *mut c_void,
                },
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_INVALID,
                    data: ptr::null_mut(),
                },
            ];
            let mut rctx: *mut mpv_render_context = ptr::null_mut();
            let rc = unsafe {
                mpv_render_context_create(
                    &mut rctx,
                    mpv_addr as *mut mpv_handle,
                    params.as_mut_ptr(),
                )
            };
            if rc < 0 || rctx.is_null() {
                eprintln!("[Loom mpv] render_context_create failed: {rc}");
                return;
            }
            RENDER_CTX.with(|c| c.set(rctx));
            unsafe {
                mpv_render_context_set_update_callback(
                    rctx,
                    on_mpv_update,
                    bridge_addr as *mut c_void,
                );
            }
        });
    }

    // Render signal: draw the current mpv frame into GTK's bound FBO.
    let gl_get_integerv: extern "C" fn(u32, *mut i32) =
        unsafe { std::mem::transmute(epoxy::get_proc_addr("glGetIntegerv")) };
    glarea.connect_render(move |area, _ctx| {
        let rctx = RENDER_CTX.with(|c| c.get());
        if rctx.is_null() {
            return glib::Propagation::Proceed;
        }
        let scale = area.scale_factor();
        let mut fbo_id: i32 = 0;
        gl_get_integerv(GL_FRAMEBUFFER_BINDING, &mut fbo_id);
        let mut fbo = mpv_opengl_fbo {
            fbo: fbo_id,
            w: area.allocated_width() * scale,
            h: area.allocated_height() * scale,
            internal_format: 0,
        };
        let mut flip: i32 = 1;
        let mut params = [
            mpv_render_param {
                type_: MPV_RENDER_PARAM_OPENGL_FBO,
                data: &mut fbo as *mut _ as *mut c_void,
            },
            mpv_render_param {
                type_: MPV_RENDER_PARAM_FLIP_Y,
                data: &mut flip as *mut _ as *mut c_void,
            },
            mpv_render_param {
                type_: MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        unsafe { mpv_render_context_render(rctx, params.as_mut_ptr()) };
        glib::Propagation::Proceed
    });

    {
        let glarea = glarea.clone();
        rx.attach(None, move |_| {
            glarea.queue_render();
            glib::ControlFlow::Continue
        });
    }

    overlay.show_all();

    // Event pump: a background thread blocks on mpv_wait_event and re-emits
    // property changes as "mpv-prop" (the frontend contract).
    let handle = MpvHandle(mpv);
    *state.inner.lock().unwrap() = Some(handle);
    state.running.store(true, Ordering::SeqCst);
    let running = state.running.clone();
    let app2 = app.clone();
    std::thread::spawn(move || {
        let mpv = mpv_addr as *mut mpv_handle;
        while running.load(Ordering::SeqCst) {
            let ev = unsafe { mpv_wait_event(mpv, 0.1) };
            if ev.is_null() {
                continue;
            }
            let id = unsafe { (*ev).event_id };
            if id == MPV_EVENT_SHUTDOWN {
                break;
            }
            if id == MPV_EVENT_PROPERTY_CHANGE {
                let prop = unsafe { &*((*ev).data as *const mpv_event_property) };
                if prop.name.is_null() {
                    continue;
                }
                let name = unsafe { CStr::from_ptr(prop.name) }
                    .to_string_lossy()
                    .into_owned();
                let data = unsafe { read_prop(prop) };
                let _ = app2.emit("mpv-prop", json!({ "name": name, "data": data }));
            }
        }
    });

    Ok(())
}

/// Decode a property-change payload into JSON matching what the IPC engine
/// emitted (numbers for time-pos/duration, bool for pause/eof).
unsafe fn read_prop(prop: &mpv_event_property) -> serde_json::Value {
    if prop.data.is_null() {
        return serde_json::Value::Null;
    }
    match prop.format {
        f if f == MPV_FORMAT_DOUBLE => json!(*(prop.data as *const f64)),
        f if f == MPV_FORMAT_FLAG => json!(*(prop.data as *const i32) != 0),
        f if f == MPV_FORMAT_INT64 => json!(*(prop.data as *const i64)),
        _ => serde_json::Value::Null,
    }
}

fn with_mpv<R>(state: &RenderEngine, f: impl FnOnce(*mut mpv_handle) -> R) -> Result<R, String> {
    let guard = state.inner.lock().unwrap();
    let h = guard.as_ref().ok_or("player not attached")?;
    Ok(f(h.0))
}

#[tauri::command]
pub fn player_load(app: AppHandle, path: String) -> Result<(), String> {
    let state: State<RenderEngine> = app.state();
    with_mpv(&state, |mpv| {
        let cmd = CString::new(format!("loadfile \"{}\"", path)).unwrap();
        unsafe { mpv_command_string(mpv, cmd.as_ptr()) };
    })
}

/// Run one mpv command given as a JSON string array (mirrors the IPC
/// engine's command channel — the frontend sends the same arrays).
#[tauri::command]
pub fn player_command(app: AppHandle, command: Vec<String>) -> Result<(), String> {
    let state: State<RenderEngine> = app.state();
    with_mpv(&state, |mpv| {
        let cstrings: Vec<CString> =
            command.iter().map(|s| CString::new(s.as_str()).unwrap()).collect();
        let mut argv: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
        argv.push(ptr::null());
        unsafe { mpv_command(mpv, argv.as_mut_ptr()) };
    })
}

#[tauri::command]
pub fn player_stop(app: AppHandle) {
    let state: State<RenderEngine> = app.state();
    state.running.store(false, Ordering::SeqCst);
    let taken = state.inner.lock().unwrap().take();
    if let Some(h) = taken {
        // Let the event-pump thread notice `running=false` and leave its
        // mpv_wait_event(0.1) before we destroy the handle it's blocked on.
        std::thread::sleep(std::time::Duration::from_millis(150));
        unsafe { mpv_terminate_destroy(h.0) };
    }
}
