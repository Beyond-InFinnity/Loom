// Loom Player render-API spike (MOBILE_ROADMAP.md §5a).
//
// GtkOverlay { GtkGLArea(video via libmpv render API) + a caption label }.
// Proves the hand-written FFI drives libmpv's OpenGL render context into a
// GtkGLArea — the core of the single-window Player.  A screenshot after a
// seek+pause confirms real video pixels land in the GL area with the
// overlay label composited on top.

mod mpv_ffi;
use mpv_ffi::*;

use std::ffi::{c_void, CStr, CString};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gdk, glib};

const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

thread_local! {
    static RENDER_CTX: std::cell::Cell<*mut mpv_render_context> =
        std::cell::Cell::new(ptr::null_mut());
}

extern "C" fn get_proc_address(_ctx: *mut c_void, name: *const std::os::raw::c_char) -> *mut c_void {
    let n = unsafe { CStr::from_ptr(name) };
    epoxy::get_proc_addr(n.to_str().unwrap_or("")) as *mut c_void
}

// mpv update callback (called from mpv's render thread) → wake the GL area
// on the MAIN thread via a glib idle source scheduled on a captured
// MainContext channel.  We stash a Sender in a Box and pass its ptr as the
// callback ctx.
struct UpdateBridge {
    tx: glib::Sender<()>,
}
extern "C" fn on_mpv_update(ctx: *mut c_void) {
    let bridge = unsafe { &*(ctx as *const UpdateBridge) };
    let _ = bridge.tx.send(());
}

fn main() {
    let media = std::env::args().nth(1).unwrap_or_else(|| {
        "/home/connor/Downloads/Shingeki no Kyojin S2 - 06.mkv".to_string()
    });
    let seek = std::env::args().nth(2).unwrap_or_else(|| "297".into());
    let shot = std::env::args().nth(3);

    gtk::init().expect("gtk init");

    // Load epoxy so both our glGetIntegerv and mpv's get_proc_address
    // resolve GL symbols.
    {
        let lib = unsafe {
            libloading::Library::new("libepoxy.so.0").expect("libepoxy.so.0")
        };
        epoxy::load_with(|name| unsafe {
            lib.get::<*const c_void>(name.as_bytes())
                .map(|s| *s)
                .unwrap_or(ptr::null())
        });
        // Leak the handle so the symbols stay valid for the process life.
        std::mem::forget(lib);
    }
    let gl_get_integerv: extern "C" fn(u32, *mut i32) =
        unsafe { std::mem::transmute(epoxy::get_proc_addr("glGetIntegerv")) };

    // ---- window / overlay / GL area -------------------------------------
    let win = gtk::Window::new(gtk::WindowType::Toplevel);
    win.set_title("Loom render-API spike");
    win.set_default_size(960, 540);
    if let Some(vis) = WidgetExt::screen(&win).and_then(|s| s.rgba_visual()) {
        win.set_visual(Some(&vis));
    }
    let overlay = gtk::Overlay::new();
    win.add(&overlay);

    let glarea = gtk::GLArea::new();
    glarea.set_has_alpha(false);
    glarea.set_use_es(false);
    glarea.set_auto_render(false); // we drive renders off mpv updates
    overlay.add(&glarea);

    let label = gtk::Label::new(None);
    label.set_markup(
        "<span foreground=\"white\" font=\"26\"><i>libmpv render API → GtkGLArea</i>\n\
         自分の命も顧みない行動が</span>",
    );
    label.set_justify(gtk::Justification::Center);
    label.set_valign(gtk::Align::Start);
    label.set_margin_top(28);
    overlay.add_overlay(&label);

    // ---- mpv core -------------------------------------------------------
    // libmpv requires a C numeric locale; GTK's init set the user locale,
    // so reset LC_NUMERIC just before mpv_create.
    unsafe {
        let c = CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, c.as_ptr());
    }
    let mpv = unsafe { mpv_create() };
    assert!(!mpv.is_null(), "mpv_create");
    let set_opt = |name: &str, val: &str| {
        let n = CString::new(name).unwrap();
        let v = CString::new(val).unwrap();
        unsafe { mpv_set_option_string(mpv, n.as_ptr(), v.as_ptr()) };
    };
    set_opt("vo", "libmpv"); // REQUIRED: use the render API, not a window
    set_opt("hwdec", "no");
    set_opt("terminal", "no");
    assert_eq!(unsafe { mpv_initialize(mpv) }, 0, "mpv_initialize");

    // Observe time-pos so we can log that playback advances (the
    // PlayheadSource analog).
    let tp = CString::new("time-pos").unwrap();
    unsafe { mpv_observe_property(mpv, 1, tp.as_ptr(), MPV_FORMAT_DOUBLE) };

    // Update bridge (mpv render thread → main thread redraw).
    let (tx, rx) = glib::MainContext::channel::<()>(glib::Priority::default());
    let bridge = Box::into_raw(Box::new(UpdateBridge { tx }));

    // Render context is created lazily once the GL context is realized (mpv
    // needs a current GL context to init).
    let mpv_ptr = mpv as usize;
    let realized = Arc::new(AtomicBool::new(false));
    {
        let realized = realized.clone();
        glarea.connect_realize(move |area| {
            area.make_current();
            if area.error().is_some() {
                eprintln!("GLArea realize error");
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
                    mpv_ptr as *mut mpv_handle,
                    params.as_mut_ptr(),
                )
            };
            if rc < 0 || rctx.is_null() {
                eprintln!("mpv_render_context_create failed: {rc}");
                return;
            }
            RENDER_CTX.with(|c| c.set(rctx));
            unsafe {
                mpv_render_context_set_update_callback(
                    rctx,
                    on_mpv_update,
                    bridge as *mut c_void,
                );
            }
            realized.store(true, Ordering::SeqCst);
        });
    }

    // Render signal: draw the current mpv frame into GTK's bound FBO.
    glarea.connect_render(move |area, _ctx| {
        let rctx = RENDER_CTX.with(|c| c.get());
        if rctx.is_null() {
            return glib::Propagation::Proceed;
        }
        let scale = area.scale_factor();
        let w = area.allocated_width() * scale;
        let h = area.allocated_height() * scale;
        let mut fbo_id: i32 = 0;
        gl_get_integerv(GL_FRAMEBUFFER_BINDING, &mut fbo_id);
        let mut fbo = mpv_opengl_fbo {
            fbo: fbo_id,
            w,
            h,
            internal_format: 0,
        };
        let mut flip: i32 = 1; // GTK FBO is y-flipped vs mpv
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

    // Redraw when mpv signals a new frame.
    {
        let glarea = glarea.clone();
        rx.attach(None, move |_| {
            glarea.queue_render();
            glib::ControlFlow::Continue
        });
    }

    // Pump mpv events (property-change logging) on a main-loop timeout.
    {
        let mpv_ptr = mpv as usize;
        glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            let mpv = mpv_ptr as *mut mpv_handle;
            loop {
                let ev = unsafe { mpv_wait_event(mpv, 0.0) };
                if ev.is_null() {
                    break;
                }
                let id = unsafe { (*ev).event_id };
                if id == MPV_EVENT_NONE {
                    break;
                }
            }
            glib::ControlFlow::Continue
        });
    }

    win.show_all();

    // Load the file once realized, then seek+pause, then screenshot.
    {
        let mpv_ptr = mpv as usize;
        let media = media.clone();
        let seek = seek.clone();
        let shot = shot.clone();
        let realized = realized.clone();
        let started = Arc::new(AtomicBool::new(false));
        glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
            if !realized.load(Ordering::SeqCst) {
                return glib::ControlFlow::Continue;
            }
            let mpv = mpv_ptr as *mut mpv_handle;
            if !started.swap(true, Ordering::SeqCst) {
                let cmd = CString::new(format!("loadfile \"{}\"", media)).unwrap();
                unsafe { mpv_command_string(mpv, cmd.as_ptr()) };
                let shot2 = shot.clone();
                let seek2 = seek.clone();
                // Give it a couple seconds to decode, then seek+pause+shot.
                glib::timeout_add_local_once(std::time::Duration::from_secs(3), move || {
                    let mpv = mpv_ptr as *mut mpv_handle;
                    let s = CString::new(format!("seek {} absolute", seek2)).unwrap();
                    unsafe { mpv_command_string(mpv, s.as_ptr()) };
                    let p = CString::new("pause").unwrap();
                    let yes = CString::new("yes").unwrap();
                    unsafe { mpv_set_property_string(mpv, p.as_ptr(), yes.as_ptr()) };
                    if let Some(path) = shot2 {
                        glib::timeout_add_local_once(
                            std::time::Duration::from_millis(1500),
                            move || {
                                let _ = std::process::Command::new("ffmpeg")
                                    .args([
                                        "-y", "-loglevel", "error", "-f", "x11grab",
                                        "-video_size", "980x560", "-i", ":1.0+50,50",
                                        "-frames:v", "1", &path,
                                    ])
                                    .status();
                                println!("SHOT_DONE {path}");
                                gtk::main_quit();
                            },
                        );
                    }
                });
            }
            glib::ControlFlow::Break
        });
    }

    win.move_(50, 50);
    win.connect_delete_event(|_, _| {
        gtk::main_quit();
        glib::Propagation::Proceed
    });

    // Safety valve.
    glib::timeout_add_seconds_local(20, || {
        gtk::main_quit();
        glib::ControlFlow::Break
    });

    gtk::main();
    let _ = gdk::Display::default();
}
