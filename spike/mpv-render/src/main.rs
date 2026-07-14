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
use std::os::raw::{c_int, c_ulong};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use gtk::prelude::*;
use gtk::{gdk, glib};

const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

// ---- Direct-present (LOOM_SPIKE_DIRECT=1) --------------------------------
// GtkGLArea is ALWAYS offscreen in GTK3: it renders to an FBO that GTK blits
// via gdk_cairo_draw_from_gl — a full-frame readback that caps 4K at ~15fps
// (measured).  This mode instead renders mpv straight into a native GdkWindow's
// default framebuffer (fbo 0) via a hand-made GLX context and presents with
// glXSwapBuffers — no offscreen FBO, no readback.  This is the exact approach
// the Player will use (GtkDrawingArea + manual GLX), so proving it here yields
// transplantable code.

#[repr(C)]
struct XVisualInfo {
    visual: *mut c_void,
    visualid: c_ulong,
    screen: c_int,
    depth: c_int,
    class: c_int,
    red_mask: c_ulong,
    green_mask: c_ulong,
    blue_mask: c_ulong,
    colormap_size: c_int,
    bits_per_rgb: c_int,
}

// GLX enums (from GL/glx.h).
const GLX_X_RENDERABLE: c_int = 0x8012;
const GLX_DRAWABLE_TYPE: c_int = 0x8010;
const GLX_WINDOW_BIT: c_int = 0x0001;
const GLX_RENDER_TYPE: c_int = 0x8011;
const GLX_RGBA_BIT: c_int = 0x0001;
const GLX_X_VISUAL_TYPE: c_int = 0x22;
const GLX_TRUE_COLOR: c_int = 0x8002;
const GLX_RED_SIZE: c_int = 8;
const GLX_GREEN_SIZE: c_int = 9;
const GLX_BLUE_SIZE: c_int = 10;
const GLX_DOUBLEBUFFER: c_int = 5;
const GLX_RGBA_TYPE: c_int = 0x8014;

#[link(name = "GL")]
extern "C" {
    fn glXChooseFBConfig(dpy: *mut c_void, screen: c_int, attrib_list: *const c_int, nelements: *mut c_int) -> *mut *mut c_void;
    fn glXGetVisualFromFBConfig(dpy: *mut c_void, config: *mut c_void) -> *mut XVisualInfo;
    fn glXCreateNewContext(dpy: *mut c_void, config: *mut c_void, render_type: c_int, share: *mut c_void, direct: c_int) -> *mut c_void;
    fn glXMakeCurrent(dpy: *mut c_void, drawable: c_ulong, ctx: *mut c_void) -> c_int;
    fn glXSwapBuffers(dpy: *mut c_void, drawable: c_ulong);
    fn glXSwapIntervalEXT(dpy: *mut c_void, drawable: c_ulong, interval: c_int);
}

// gdk-3 X11 backend accessors (libgdk-3 is already linked via gtk).
extern "C" {
    fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut c_void;
    fn gdk_x11_window_get_xid(window: *mut c_void) -> c_ulong;
    fn gdk_x11_screen_lookup_visual(screen: *mut c_void, xvisualid: c_ulong) -> *mut c_void;
    fn gdk_x11_screen_get_screen_number(screen: *mut c_void) -> c_int;
    // Removed from the safe gtk-rs 0.18 API; still needed so GTK's own
    // double-buffer doesn't fight our glXSwapBuffers on the native window.
    fn gtk_widget_set_double_buffered(widget: *mut c_void, double_buffered: c_int);
}

// ---- GL overlay for the single-window composite proof (LOOM_SPIKE_OVERLAY) --
// After mpv renders the video into the EGL default framebuffer, we blend a
// captured-DOM texture (premultiplied BGRA from spike/webview-texture) OVER it,
// then swap.  ONE window, ONE GL surface — exactly the composite the Player's
// DOM-in-GL (option B) path needs, with none of the sibling-X-window
// compositing that broke the GtkDrawingArea-subwindow approach.  Fixed-function
// immediate-mode draw (the EGL context we create is a desktop-GL compat ctx).
const GLO_TEXTURE_2D: u32 = 0x0DE1;
const GLO_TEXTURE_MIN_FILTER: u32 = 0x2801;
const GLO_TEXTURE_MAG_FILTER: u32 = 0x2800;
const GLO_LINEAR: c_int = 0x2601;
const GLO_TEXTURE_WRAP_S: u32 = 0x2802;
const GLO_TEXTURE_WRAP_T: u32 = 0x2803;
const GLO_CLAMP_TO_EDGE: c_int = 0x812F;
const GLO_RGBA: c_int = 0x1908;
const GLO_BGRA: u32 = 0x80E1;
const GLO_UNSIGNED_BYTE: u32 = 0x1401;
const GLO_BLEND: u32 = 0x0BE2;
const GLO_ONE: u32 = 1;
const GLO_ONE_MINUS_SRC_ALPHA: u32 = 0x0303;
const GLO_QUADS: u32 = 0x0007;
const GLO_FRAMEBUFFER: u32 = 0x8D40;
const GLO_SCISSOR_TEST: u32 = 0x0C11;
const GLO_DEPTH_TEST: u32 = 0x0B71;

extern "C" {
    fn glGenTextures(n: c_int, textures: *mut u32);
    fn glBindTexture(target: u32, texture: u32);
    fn glTexImage2D(
        target: u32, level: c_int, internalformat: c_int, width: c_int, height: c_int,
        border: c_int, format: u32, type_: u32, pixels: *const c_void,
    );
    fn glTexParameteri(target: u32, pname: u32, param: c_int);
    fn glEnable(cap: u32);
    fn glDisable(cap: u32);
    fn glBlendFunc(sfactor: u32, dfactor: u32);
    fn glViewport(x: c_int, y: c_int, w: c_int, h: c_int);
    fn glBegin(mode: u32);
    fn glEnd();
    fn glTexCoord2f(s: f32, t: f32);
    fn glVertex2f(x: f32, y: f32);
    fn glColor4f(r: f32, g: f32, b: f32, a: f32);
    fn glUseProgram(program: u32);
    fn glBindFramebuffer(target: u32, framebuffer: u32);
    fn glGetError() -> u32;
}

thread_local! {
    static OVERLAY_TEX: std::cell::Cell<u32> = std::cell::Cell::new(0);
    static OVERLAY_ERR_LOGGED: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

fn load_overlay_texture(path: &str, w: c_int, h: c_int) -> u32 {
    let data = std::fs::read(path).expect("read overlay bgra");
    assert_eq!(data.len(), (w * h * 4) as usize, "overlay size mismatch");
    let mut tex: u32 = 0;
    unsafe {
        glGenTextures(1, &mut tex);
        glBindTexture(GLO_TEXTURE_2D, tex);
        glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_MIN_FILTER, GLO_LINEAR);
        glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_MAG_FILTER, GLO_LINEAR);
        glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_WRAP_S, GLO_CLAMP_TO_EDGE);
        glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_WRAP_T, GLO_CLAMP_TO_EDGE);
        glTexImage2D(
            GLO_TEXTURE_2D, 0, GLO_RGBA, w, h, 0,
            GLO_BGRA, GLO_UNSIGNED_BYTE, data.as_ptr() as *const c_void,
        );
    }
    eprintln!("[spike-egl] overlay texture {tex} loaded ({w}x{h}) from {path}");
    tex
}

fn draw_overlay(tex: u32, vw: c_int, vh: c_int) {
    unsafe {
        glBindFramebuffer(GLO_FRAMEBUFFER, 0); // draw into the on-screen buffer
        glUseProgram(0); // fixed-function pipeline (mpv may leave a program bound)
        glViewport(0, 0, vw, vh);
        glDisable(GLO_SCISSOR_TEST);
        glDisable(GLO_DEPTH_TEST);
        glBindTexture(GLO_TEXTURE_2D, tex);
        glEnable(GLO_TEXTURE_2D);
        glEnable(GLO_BLEND);
        glBlendFunc(GLO_ONE, GLO_ONE_MINUS_SRC_ALPHA); // cairo data is PREMULTIPLIED
        glColor4f(1.0, 1.0, 1.0, 1.0);
        glBegin(GLO_QUADS);
        // full-screen NDC quad; V flipped so the image's top maps to screen top
        glTexCoord2f(0.0, 1.0); glVertex2f(-1.0, -1.0);
        glTexCoord2f(1.0, 1.0); glVertex2f(1.0, -1.0);
        glTexCoord2f(1.0, 0.0); glVertex2f(1.0, 1.0);
        glTexCoord2f(0.0, 0.0); glVertex2f(-1.0, 1.0);
        glEnd();
        glDisable(GLO_BLEND);
        glDisable(GLO_TEXTURE_2D);
        let e = glGetError();
        OVERLAY_ERR_LOGGED.with(|l| {
            if !l.get() {
                l.set(true);
                eprintln!("[spike-egl] first overlay draw glGetError=0x{e:x} (0=OK)");
            }
        });
    }
}

// ---- EGL (LOOM_SPIKE_EGL=1) ----------------------------------------------
// The GLX direct path (above) proved native-window present kills the readback,
// but zero-copy VAAPI decode needs an EGL context (EGL-dmabuf interop — the
// exact thing VLC does and modern mpv logs as "Using EGL dmabuf interop via
// GL_EXT_EGL_image_storage").  This path is run_direct with GLX swapped for EGL:
// eglGetDisplay(Xdisplay) → eglChooseConfig → derive the GdkVisual from
// EGL_NATIVE_VISUAL_ID → eglCreateWindowSurface(xid) → eglSwapBuffers, plus
// hwdec=vaapi and MPV_RENDER_PARAM_X11_DISPLAY so mpv opens the x11 VA display.
// Requires a modern libmpv (jammy's 0.34.1 aborts the VA probe); link against
// vendor/mpv-prefix (scripts/build-libmpv.sh) to test the zero-copy path.
const EGL_OPENGL_API: u32 = 0x30A2;
const EGL_NONE: i32 = 0x3038;
const EGL_SURFACE_TYPE: i32 = 0x3033;
const EGL_WINDOW_BIT: i32 = 0x0004;
const EGL_RENDERABLE_TYPE: i32 = 0x3040;
const EGL_OPENGL_BIT: i32 = 0x0008;
const EGL_RED_SIZE: i32 = 0x3024;
const EGL_GREEN_SIZE: i32 = 0x3023;
const EGL_BLUE_SIZE: i32 = 0x3022;
const EGL_ALPHA_SIZE: i32 = 0x3021;
const EGL_NATIVE_VISUAL_ID: i32 = 0x302E;

#[link(name = "EGL")]
extern "C" {
    fn eglGetDisplay(display_id: *mut c_void) -> *mut c_void;
    fn eglInitialize(dpy: *mut c_void, major: *mut c_int, minor: *mut c_int) -> u32;
    fn eglBindAPI(api: u32) -> u32;
    fn eglChooseConfig(dpy: *mut c_void, attrib_list: *const c_int, configs: *mut *mut c_void, config_size: c_int, num_config: *mut c_int) -> u32;
    fn eglGetConfigAttrib(dpy: *mut c_void, config: *mut c_void, attribute: c_int, value: *mut c_int) -> u32;
    fn eglCreateContext(dpy: *mut c_void, config: *mut c_void, share_context: *mut c_void, attrib_list: *const c_int) -> *mut c_void;
    fn eglCreateWindowSurface(dpy: *mut c_void, config: *mut c_void, win: c_ulong, attrib_list: *const c_int) -> *mut c_void;
    fn eglMakeCurrent(dpy: *mut c_void, draw: *mut c_void, read: *mut c_void, ctx: *mut c_void) -> u32;
    fn eglSwapBuffers(dpy: *mut c_void, surface: *mut c_void) -> u32;
    fn eglSwapInterval(dpy: *mut c_void, interval: c_int) -> u32;
    fn eglGetError() -> c_int;
    fn eglGetProcAddress(procname: *const std::os::raw::c_char) -> *mut c_void;
}

// EGL GL/EGL-extension resolver for mpv.  mpv's get_proc_address must resolve
// BOTH core GL (glClear…) AND EGL extension entry points (eglCreateImageKHR,
// glEGLImageTargetTexture2DOES) used by the vaapi-egl interop.  Mesa's
// eglGetProcAddress (EGL_KHR_get_all_proc_addresses) returns all of them; fall
// back to epoxy/dlsym for anything it doesn't.
extern "C" fn get_proc_address_egl(_ctx: *mut c_void, name: *const std::os::raw::c_char) -> *mut c_void {
    let p = unsafe { eglGetProcAddress(name) };
    if !p.is_null() {
        return p;
    }
    let n = unsafe { CStr::from_ptr(name) };
    epoxy::get_proc_addr(n.to_str().unwrap_or("")) as *mut c_void
}

// EGL direct-present state, main-thread only.
#[derive(Clone, Copy)]
struct DirectEgl {
    dpy: *mut c_void,
    surf: *mut c_void,
    ctx: *mut c_void,
}
thread_local! {
    static DIRECT_EGL: std::cell::Cell<Option<DirectEgl>> = std::cell::Cell::new(None);
}

// Direct-present GL state, main-thread only.
#[derive(Clone, Copy)]
struct DirectGl {
    xdisplay: *mut c_void,
    xid: c_ulong,
    glx: *mut c_void,
}
thread_local! {
    static DIRECT: std::cell::Cell<Option<DirectGl>> = std::cell::Cell::new(None);
}

thread_local! {
    static RENDER_CTX: std::cell::Cell<*mut mpv_render_context> =
        std::cell::Cell::new(ptr::null_mut());
}

// fps instrumentation — both mpv "new frame" (produced) and the GTK render
// signal (on-screen) fire on THIS thread, so a thread-local counter measures
// both.  A low on-screen fps with a SMALL render-call time is the signature of
// the GtkGLArea offscreen readback (gdk_cairo_draw_from_gl) being the cost —
// which is exactly what this spike isolates (no webview overlay at all).
thread_local! {
    static STATS: std::cell::RefCell<Stats> = std::cell::RefCell::new(Stats::new());
}
struct Stats {
    start: std::time::Instant,
    produced: u32,
    rendered: u32,
    ns_sum: u128,
    ns_max: u128,
    w: i32,
    h: i32,
}
impl Stats {
    fn new() -> Self {
        Self { start: std::time::Instant::now(), produced: 0, rendered: 0, ns_sum: 0, ns_max: 0, w: 0, h: 0 }
    }
    fn flush(&mut self) {
        let e = self.start.elapsed().as_secs_f64();
        if e < 1.0 {
            return;
        }
        let avg = if self.rendered > 0 { (self.ns_sum as f64 / self.rendered as f64) / 1e6 } else { 0.0 };
        println!(
            "[spike] {:.1} fps on-screen · produced {:.1} · render-call avg {:.2}ms max {:.2}ms · fbo {}x{}",
            self.rendered as f64 / e,
            self.produced as f64 / e,
            avg,
            self.ns_max as f64 / 1e6,
            self.w,
            self.h,
        );
        self.start = std::time::Instant::now();
        self.produced = 0;
        self.rendered = 0;
        self.ns_sum = 0;
        self.ns_max = 0;
    }
}
fn stats_note_produced() {
    STATS.with(|s| {
        let mut s = s.borrow_mut();
        s.produced += 1;
        s.flush();
    });
}
fn stats_note_render(d: std::time::Duration, w: i32, h: i32) {
    STATS.with(|s| {
        let mut s = s.borrow_mut();
        s.rendered += 1;
        let ns = d.as_nanos();
        s.ns_sum += ns;
        s.ns_max = s.ns_max.max(ns);
        s.w = w;
        s.h = h;
        s.flush();
    });
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

fn load_epoxy() {
    let lib = unsafe { libloading::Library::new("libepoxy.so.0").expect("libepoxy.so.0") };
    epoxy::load_with(|name| unsafe {
        lib.get::<*const c_void>(name.as_bytes()).map(|s| *s).unwrap_or(ptr::null())
    });
    std::mem::forget(lib);
}

fn mpv_set_opt(mpv: *mut mpv_handle, name: &str, val: &str) {
    let n = CString::new(name).unwrap();
    let v = CString::new(val).unwrap();
    unsafe { mpv_set_option_string(mpv, n.as_ptr(), v.as_ptr()) };
}

/// Direct-present path: render mpv straight into a native GdkWindow (fbo 0) via
/// a hand-made GLX context, present with glXSwapBuffers — NO GtkGLArea, NO
/// gdk_cairo_draw_from_gl readback.  This is the transplantable core of the
/// Player's render fix.
fn run_direct(media: String, seek: String) {
    use glib::translate::{from_glib_none, ToGlibPtr};

    gtk::init().expect("gtk init");
    load_epoxy();

    // Choose a double-buffered TrueColor GLX FBConfig, then bind the drawing
    // area to its matching GdkVisual so glXMakeCurrent on its window succeeds.
    let display = gdk::Display::default().expect("gdk display");
    let screen = display.default_screen();
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    let screen_glib: *mut gdk::ffi::GdkScreen = screen.to_glib_none().0;
    let xdisplay = unsafe { gdk_x11_display_get_xdisplay(display_ptr as *mut c_void) };
    let screen_ptr = screen_glib as *mut c_void;
    let screen_num = unsafe { gdk_x11_screen_get_screen_number(screen_ptr) };

    let attribs: [c_int; 17] = [
        GLX_X_RENDERABLE, 1,
        GLX_DRAWABLE_TYPE, GLX_WINDOW_BIT,
        GLX_RENDER_TYPE, GLX_RGBA_BIT,
        GLX_X_VISUAL_TYPE, GLX_TRUE_COLOR,
        GLX_RED_SIZE, 8,
        GLX_GREEN_SIZE, 8,
        GLX_BLUE_SIZE, 8,
        GLX_DOUBLEBUFFER, 1,
        0,
    ];
    let mut n: c_int = 0;
    let fbcs = unsafe { glXChooseFBConfig(xdisplay, screen_num, attribs.as_ptr(), &mut n) };
    if fbcs.is_null() || n == 0 {
        eprintln!("[spike] glXChooseFBConfig found no config");
        return;
    }
    let fbc = unsafe { *fbcs };
    let vi = unsafe { glXGetVisualFromFBConfig(xdisplay, fbc) };
    if vi.is_null() {
        eprintln!("[spike] glXGetVisualFromFBConfig null");
        return;
    }
    let visualid = unsafe { (*vi).visualid };
    let gvisual_ptr = unsafe { gdk_x11_screen_lookup_visual(screen_ptr, visualid) };
    if gvisual_ptr.is_null() {
        eprintln!("[spike] gdk_x11_screen_lookup_visual null for 0x{visualid:x}");
        return;
    }
    let gvisual: gdk::Visual = unsafe { from_glib_none(gvisual_ptr as *mut gdk::ffi::GdkVisual) };
    let glx = unsafe { glXCreateNewContext(xdisplay, fbc, GLX_RGBA_TYPE, ptr::null_mut(), 1) };
    if glx.is_null() {
        eprintln!("[spike] glXCreateNewContext failed");
        return;
    }
    eprintln!("[spike] direct: fbconfig ok, visual 0x{visualid:x}, GLX context created");

    let win = gtk::Window::new(gtk::WindowType::Toplevel);
    win.set_title("Loom direct-present spike");
    win.set_default_size(1280, 720);
    let overlay = gtk::Overlay::new();
    win.add(&overlay);
    let area = gtk::DrawingArea::new();
    area.set_visual(Some(&gvisual)); // MUST match the GLX FBConfig visual
    area.set_app_paintable(true);
    // we own the buffer swap (glXSwapBuffers) — stop GTK double-buffering it
    let area_ptr: *mut gtk::ffi::GtkDrawingArea = area.to_glib_none().0;
    unsafe { gtk_widget_set_double_buffered(area_ptr as *mut c_void, 0) };
    overlay.add(&area);
    let label = gtk::Label::new(None);
    label.set_markup(
        "<span foreground=\"white\" font=\"26\"><i>direct GLX present (fbo 0, no readback)</i></span>",
    );
    label.set_valign(gtk::Align::Start);
    label.set_margin_top(28);
    overlay.add_overlay(&label);

    unsafe {
        let c = CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, c.as_ptr());
    }
    let mpv = unsafe { mpv_create() };
    assert!(!mpv.is_null(), "mpv_create");
    mpv_set_opt(mpv, "vo", "libmpv");
    let hwdec = std::env::var("LOOM_HWDEC").unwrap_or_else(|_| "nvdec-copy".to_string());
    mpv_set_opt(mpv, "hwdec", &hwdec);
    eprintln!("[spike] hwdec={hwdec}");
    mpv_set_opt(mpv, "ao", "null");
    mpv_set_opt(mpv, "terminal", "no");
    assert_eq!(unsafe { mpv_initialize(mpv) }, 0, "mpv_initialize");
    let tp = CString::new("time-pos").unwrap();
    unsafe { mpv_observe_property(mpv, 1, tp.as_ptr(), MPV_FORMAT_DOUBLE) };

    let (tx, rx) = glib::MainContext::channel::<()>(glib::Priority::default());
    let bridge = Box::into_raw(Box::new(UpdateBridge { tx }));
    let mpv_ptr = mpv as usize;
    let xdisplay_addr = xdisplay as usize;
    let glx_addr = glx as usize;

    let realized = Arc::new(AtomicBool::new(false));
    {
        let realized = realized.clone();
        let bridge_addr = bridge as usize;
        area.connect_realize(move |a| {
            let gdkwin = match a.window() {
                Some(w) => w,
                None => {
                    eprintln!("[spike] drawing area has no GdkWindow");
                    return;
                }
            };
            let win_ptr: *mut gdk::ffi::GdkWindow = gdkwin.to_glib_none().0;
            let xid = unsafe { gdk_x11_window_get_xid(win_ptr as *mut c_void) };
            let xdisplay = xdisplay_addr as *mut c_void;
            let glx = glx_addr as *mut c_void;
            if unsafe { glXMakeCurrent(xdisplay, xid, glx) } == 0 {
                eprintln!("[spike] glXMakeCurrent failed on realize");
                return;
            }
            unsafe { glXSwapIntervalEXT(xdisplay, xid, 1) }; // vsync

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
                mpv_render_context_create(&mut rctx, mpv_ptr as *mut mpv_handle, params.as_mut_ptr())
            };
            if rc < 0 || rctx.is_null() {
                eprintln!("[spike] mpv_render_context_create failed: {rc}");
                return;
            }
            RENDER_CTX.with(|c| c.set(rctx));
            DIRECT.with(|d| d.set(Some(DirectGl { xdisplay, xid, glx })));
            unsafe {
                mpv_render_context_set_update_callback(rctx, on_mpv_update, bridge_addr as *mut c_void);
            }
            realized.store(true, Ordering::SeqCst);
            eprintln!("[spike] direct: realized, xid=0x{xid:x}, render context live");
        });
    }

    // The mpv update callback now just COUNTS produced frames — it no longer
    // drives rendering.
    rx.attach(None, move |_| {
        stats_note_produced();
        glib::ControlFlow::Continue
    });

    // DISPLAY-RATE render loop (the mpv-recommended pattern): render at ~vsync
    // regardless of mpv's update ping, and let mpv pick the correct frame for
    // the current time each present.  Rendering only ON the update ping
    // throttled us to mpv's ping rate (~15fps) even though a render is cheap
    // (~5-7ms) — that was the real 4K wall, not decode or the readback.  The
    // vsync-blocked glXSwapBuffers paces the 2ms timeout to the display rate;
    // mpv_render_context_report_swap tells mpv the present timing.
    {
        let area = area.clone();
        glib::timeout_add_local(std::time::Duration::from_millis(2), move || {
            let rctx = RENDER_CTX.with(|c| c.get());
            let dg = DIRECT.with(|d| d.get());
            if let (false, Some(dg)) = (rctx.is_null(), dg) {
                unsafe { glXMakeCurrent(dg.xdisplay, dg.xid, dg.glx) };
                let scale = area.scale_factor();
                let w = area.allocated_width() * scale;
                let h = area.allocated_height() * scale;
                let mut fbo = mpv_opengl_fbo { fbo: 0, w, h, internal_format: 0 };
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
                let t0 = std::time::Instant::now();
                unsafe { mpv_render_context_render(rctx, params.as_mut_ptr()) };
                let dur = t0.elapsed();
                unsafe { glXSwapBuffers(dg.xdisplay, dg.xid) };
                unsafe { mpv_render_context_report_swap(rctx) };
                stats_note_render(dur, w, h);
            }
            glib::ControlFlow::Continue
        });
    }

    // Pump mpv events so the property queue drains.
    {
        let mpv_ptr = mpv as usize;
        glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            let mpv = mpv_ptr as *mut mpv_handle;
            loop {
                let ev = unsafe { mpv_wait_event(mpv, 0.0) };
                if ev.is_null() || unsafe { (*ev).event_id } == MPV_EVENT_NONE {
                    break;
                }
            }
            glib::ControlFlow::Continue
        });
    }

    win.show_all();
    if std::env::var_os("LOOM_SPIKE_WINDOWED").is_none() {
        win.move_(0, 0);
        win.fullscreen();
    }

    // Load once realized, seek into content, keep playing.
    {
        let mpv_ptr = mpv as usize;
        let started = Arc::new(AtomicBool::new(false));
        glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
            if !realized.load(Ordering::SeqCst) {
                return glib::ControlFlow::Continue;
            }
            if !started.swap(true, Ordering::SeqCst) {
                let mpv = mpv_ptr as *mut mpv_handle;
                let cmd = CString::new(format!("loadfile \"{}\"", media)).unwrap();
                unsafe { mpv_command_string(mpv, cmd.as_ptr()) };
                let seek2 = seek.clone();
                glib::timeout_add_local_once(std::time::Duration::from_secs(3), move || {
                    let mpv = mpv_ptr as *mut mpv_handle;
                    let s = CString::new(format!("seek {} absolute", seek2)).unwrap();
                    unsafe { mpv_command_string(mpv, s.as_ptr()) };
                });
            }
            glib::ControlFlow::Break
        });
    }

    win.connect_delete_event(|_, _| {
        gtk::main_quit();
        glib::Propagation::Proceed
    });
    glib::timeout_add_seconds_local(20, || {
        gtk::main_quit();
        glib::ControlFlow::Break
    });

    gtk::main();
    let _ = gdk::Display::default();
}

/// EGL direct-present path (LOOM_SPIKE_EGL=1): identical to `run_direct` but the
/// GL context is EGL, not GLX — which is what unlocks zero-copy VAAPI decode
/// (EGL-dmabuf interop).  `hwdec=vaapi` + MPV_RENDER_PARAM_X11_DISPLAY let mpv
/// import the decoded VA surface straight into a GL texture (no RAM roundtrip).
/// Needs a modern libmpv (link against vendor/mpv-prefix; 0.34.1 aborts the VA
/// probe).  This is the transplantable core of the Player's real 4K fix.
fn run_direct_egl(media: String, seek: String) {
    use glib::translate::{from_glib_none, ToGlibPtr};

    gtk::init().expect("gtk init");
    load_epoxy();

    let display = gdk::Display::default().expect("gdk display");
    let screen = display.default_screen();
    let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
    let screen_glib: *mut gdk::ffi::GdkScreen = screen.to_glib_none().0;
    let xdisplay = unsafe { gdk_x11_display_get_xdisplay(display_ptr as *mut c_void) };
    let screen_ptr = screen_glib as *mut c_void;

    // EGL display on the same X connection GDK uses.
    let egl_dpy = unsafe { eglGetDisplay(xdisplay) };
    if egl_dpy.is_null() {
        eprintln!("[spike-egl] eglGetDisplay null");
        return;
    }
    let mut major: c_int = 0;
    let mut minor: c_int = 0;
    if unsafe { eglInitialize(egl_dpy, &mut major, &mut minor) } == 0 {
        eprintln!("[spike-egl] eglInitialize failed: 0x{:x}", unsafe { eglGetError() });
        return;
    }
    if unsafe { eglBindAPI(EGL_OPENGL_API) } == 0 {
        eprintln!("[spike-egl] eglBindAPI(OpenGL) failed");
        return;
    }
    eprintln!("[spike-egl] EGL {major}.{minor}");

    // Opaque RGB8 window config.  The video surface is the BOTTOM layer — the
    // transparent webview composites on top in the app — so no alpha is needed.
    let cfg_attribs: [c_int; 13] = [
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
        EGL_RED_SIZE, 8,
        EGL_GREEN_SIZE, 8,
        EGL_BLUE_SIZE, 8,
        EGL_ALPHA_SIZE, 0,
        EGL_NONE,
    ];
    let mut config: *mut c_void = ptr::null_mut();
    let mut num: c_int = 0;
    if unsafe { eglChooseConfig(egl_dpy, cfg_attribs.as_ptr(), &mut config, 1, &mut num) } == 0 || num == 0 {
        eprintln!("[spike-egl] eglChooseConfig found no config");
        return;
    }
    let mut visid: c_int = 0;
    unsafe { eglGetConfigAttrib(egl_dpy, config, EGL_NATIVE_VISUAL_ID, &mut visid) };
    let gvisual_ptr = unsafe { gdk_x11_screen_lookup_visual(screen_ptr, visid as c_ulong) };
    if gvisual_ptr.is_null() {
        eprintln!("[spike-egl] gdk_x11_screen_lookup_visual null for 0x{visid:x}");
        return;
    }
    let gvisual: gdk::Visual = unsafe { from_glib_none(gvisual_ptr as *mut gdk::ffi::GdkVisual) };
    let egl_ctx = unsafe { eglCreateContext(egl_dpy, config, ptr::null_mut(), ptr::null()) };
    if egl_ctx.is_null() {
        eprintln!("[spike-egl] eglCreateContext failed: 0x{:x}", unsafe { eglGetError() });
        return;
    }
    eprintln!("[spike-egl] config visual 0x{visid:x}, EGL context created");

    let win = gtk::Window::new(gtk::WindowType::Toplevel);
    win.set_title("Loom EGL direct-present spike");
    win.set_default_size(1280, 720);
    let overlay = gtk::Overlay::new();
    win.add(&overlay);
    let area = gtk::DrawingArea::new();
    area.set_visual(Some(&gvisual)); // MUST match the EGL config's native visual
    area.set_app_paintable(true);
    let area_ptr: *mut gtk::ffi::GtkDrawingArea = area.to_glib_none().0;
    unsafe { gtk_widget_set_double_buffered(area_ptr as *mut c_void, 0) };
    overlay.add(&area);
    let label = gtk::Label::new(None);
    label.set_markup(
        "<span foreground=\"white\" font=\"26\"><i>EGL present + VAAPI zero-copy</i></span>",
    );
    label.set_valign(gtk::Align::Start);
    label.set_margin_top(28);
    overlay.add_overlay(&label);

    unsafe {
        let c = CString::new("C").unwrap();
        libc::setlocale(libc::LC_NUMERIC, c.as_ptr());
    }
    let mpv = unsafe { mpv_create() };
    assert!(!mpv.is_null(), "mpv_create");
    mpv_set_opt(mpv, "vo", "libmpv");
    let hwdec = std::env::var("LOOM_HWDEC").unwrap_or_else(|_| "vaapi".to_string());
    mpv_set_opt(mpv, "hwdec", &hwdec);
    eprintln!("[spike-egl] hwdec={hwdec}");
    mpv_set_opt(mpv, "ao", "null");
    // LOOM_SPIKE_MPVLOG=1 surfaces mpv's own vaapi/interop log to stderr so we
    // can confirm "Using EGL dmabuf interop" (zero-copy) engaged in THIS path.
    if std::env::var_os("LOOM_SPIKE_MPVLOG").is_some() {
        mpv_set_opt(mpv, "terminal", "yes");
        mpv_set_opt(mpv, "msg-level", "vo=v");
    } else {
        mpv_set_opt(mpv, "terminal", "no");
    }
    assert_eq!(unsafe { mpv_initialize(mpv) }, 0, "mpv_initialize");
    let tp = CString::new("time-pos").unwrap();
    unsafe { mpv_observe_property(mpv, 1, tp.as_ptr(), MPV_FORMAT_DOUBLE) };

    let (tx, rx) = glib::MainContext::channel::<()>(glib::Priority::default());
    let bridge = Box::into_raw(Box::new(UpdateBridge { tx }));
    let mpv_ptr = mpv as usize;
    let egl_dpy_addr = egl_dpy as usize;
    let egl_ctx_addr = egl_ctx as usize;
    let config_addr = config as usize;
    let xdisplay_addr = xdisplay as usize;

    let realized = Arc::new(AtomicBool::new(false));
    {
        let realized = realized.clone();
        let bridge_addr = bridge as usize;
        area.connect_realize(move |a| {
            let gdkwin = match a.window() {
                Some(w) => w,
                None => {
                    eprintln!("[spike-egl] drawing area has no GdkWindow");
                    return;
                }
            };
            let win_ptr: *mut gdk::ffi::GdkWindow = gdkwin.to_glib_none().0;
            let xid = unsafe { gdk_x11_window_get_xid(win_ptr as *mut c_void) };
            let egl_dpy = egl_dpy_addr as *mut c_void;
            let egl_ctx = egl_ctx_addr as *mut c_void;
            let config = config_addr as *mut c_void;
            let surf = unsafe { eglCreateWindowSurface(egl_dpy, config, xid, ptr::null()) };
            if surf.is_null() {
                eprintln!("[spike-egl] eglCreateWindowSurface failed: 0x{:x}", unsafe { eglGetError() });
                return;
            }
            if unsafe { eglMakeCurrent(egl_dpy, surf, surf, egl_ctx) } == 0 {
                eprintln!("[spike-egl] eglMakeCurrent failed: 0x{:x}", unsafe { eglGetError() });
                return;
            }
            unsafe { eglSwapInterval(egl_dpy, 1) }; // vsync

            // Single-window composite proof: upload the captured DOM caption as
            // a GL texture (context is current here); the render loop blends it
            // over mpv's video before the swap.
            if let Some(path) = std::env::var_os("LOOM_SPIKE_OVERLAY") {
                let tex = load_overlay_texture(&path.to_string_lossy(), 1280, 720);
                OVERLAY_TEX.with(|t| t.set(tex));
            }

            let mut init = mpv_opengl_init_params {
                get_proc_address: Some(get_proc_address_egl),
                get_proc_address_ctx: ptr::null_mut(),
                extra_exts: ptr::null(),
            };
            // MPV_RENDER_PARAM_X11_DISPLAY.data is the Display* itself (not a
            // pointer to it) — lets mpv open the x11 VA display for interop.
            let xdisp = xdisplay_addr as *mut c_void;
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
                    type_: MPV_RENDER_PARAM_X11_DISPLAY,
                    data: xdisp,
                },
                mpv_render_param {
                    type_: MPV_RENDER_PARAM_INVALID,
                    data: ptr::null_mut(),
                },
            ];
            let mut rctx: *mut mpv_render_context = ptr::null_mut();
            let rc = unsafe {
                mpv_render_context_create(&mut rctx, mpv_ptr as *mut mpv_handle, params.as_mut_ptr())
            };
            if rc < 0 || rctx.is_null() {
                eprintln!("[spike-egl] mpv_render_context_create failed: {rc}");
                return;
            }
            RENDER_CTX.with(|c| c.set(rctx));
            DIRECT_EGL.with(|d| d.set(Some(DirectEgl { dpy: egl_dpy, surf, ctx: egl_ctx })));
            unsafe {
                mpv_render_context_set_update_callback(rctx, on_mpv_update, bridge_addr as *mut c_void);
            }
            realized.store(true, Ordering::SeqCst);
            eprintln!("[spike-egl] realized, xid=0x{xid:x}, EGL surface + render context live");
        });
    }

    rx.attach(None, move |_| {
        stats_note_produced();
        glib::ControlFlow::Continue
    });

    // Display-rate render loop (see run_direct for the rationale).
    {
        let area = area.clone();
        glib::timeout_add_local(std::time::Duration::from_millis(2), move || {
            let rctx = RENDER_CTX.with(|c| c.get());
            let dg = DIRECT_EGL.with(|d| d.get());
            if let (false, Some(dg)) = (rctx.is_null(), dg) {
                unsafe { eglMakeCurrent(dg.dpy, dg.surf, dg.surf, dg.ctx) };
                let scale = area.scale_factor();
                let w = area.allocated_width() * scale;
                let h = area.allocated_height() * scale;
                let mut fbo = mpv_opengl_fbo { fbo: 0, w, h, internal_format: 0 };
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
                let t0 = std::time::Instant::now();
                unsafe { mpv_render_context_render(rctx, params.as_mut_ptr()) };
                let dur = t0.elapsed();
                // Blend the captured-DOM texture over mpv's frame, same fbo,
                // before the single swap → the whole point of option B.
                let otex = OVERLAY_TEX.with(|t| t.get());
                if otex != 0 {
                    draw_overlay(otex, w, h);
                }
                unsafe { eglSwapBuffers(dg.dpy, dg.surf) };
                unsafe { mpv_render_context_report_swap(rctx) };
                stats_note_render(dur, w, h);
            }
            glib::ControlFlow::Continue
        });
    }

    // Pump mpv events so the property queue drains.
    {
        let mpv_ptr = mpv as usize;
        glib::timeout_add_local(std::time::Duration::from_millis(100), move || {
            let mpv = mpv_ptr as *mut mpv_handle;
            loop {
                let ev = unsafe { mpv_wait_event(mpv, 0.0) };
                if ev.is_null() || unsafe { (*ev).event_id } == MPV_EVENT_NONE {
                    break;
                }
            }
            glib::ControlFlow::Continue
        });
    }

    win.show_all();
    if std::env::var_os("LOOM_SPIKE_WINDOWED").is_none() {
        win.move_(0, 0);
        win.fullscreen();
    }

    {
        let mpv_ptr = mpv as usize;
        let started = Arc::new(AtomicBool::new(false));
        glib::timeout_add_local(std::time::Duration::from_millis(200), move || {
            if !realized.load(Ordering::SeqCst) {
                return glib::ControlFlow::Continue;
            }
            if !started.swap(true, Ordering::SeqCst) {
                let mpv = mpv_ptr as *mut mpv_handle;
                let cmd = CString::new(format!("loadfile \"{}\"", media)).unwrap();
                unsafe { mpv_command_string(mpv, cmd.as_ptr()) };
                let seek2 = seek.clone();
                glib::timeout_add_local_once(std::time::Duration::from_secs(3), move || {
                    let mpv = mpv_ptr as *mut mpv_handle;
                    let s = CString::new(format!("seek {} absolute", seek2)).unwrap();
                    unsafe { mpv_command_string(mpv, s.as_ptr()) };
                });
            }
            glib::ControlFlow::Break
        });
    }

    win.connect_delete_event(|_, _| {
        gtk::main_quit();
        glib::Propagation::Proceed
    });
    glib::timeout_add_seconds_local(20, || {
        gtk::main_quit();
        glib::ControlFlow::Break
    });

    gtk::main();
    let _ = gdk::Display::default();
}

fn main() {
    let media = std::env::args().nth(1).unwrap_or_else(|| {
        "/home/connor/Downloads/Shingeki no Kyojin S2 - 06.mkv".to_string()
    });
    let seek = std::env::args().nth(2).unwrap_or_else(|| "297".into());
    let shot = std::env::args().nth(3);

    if std::env::var_os("LOOM_SPIKE_EGL").is_some() {
        run_direct_egl(media, seek);
        return;
    }
    if std::env::var_os("LOOM_SPIKE_DIRECT").is_some() {
        run_direct(media, seek);
        return;
    }

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
    // Hardware-decode so DECODE is not the bottleneck — this spike measures the
    // PRESENT/readback cost, so we want the GPU handling the 4K HEVC.  nvdec-copy
    // is the confirmed-working path on this Optimus box; override via LOOM_HWDEC.
    let hwdec = std::env::var("LOOM_HWDEC").unwrap_or_else(|_| "nvdec-copy".to_string());
    set_opt("hwdec", &hwdec);
    eprintln!("[spike] hwdec={hwdec}");
    set_opt("ao", "null"); // silent — this is an automated perf measurement
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
        let t0 = std::time::Instant::now();
        unsafe { mpv_render_context_render(rctx, params.as_mut_ptr()) };
        stats_note_render(t0.elapsed(), w, h);
        glib::Propagation::Proceed
    });

    // The mpv update ping just counts produced frames now.
    rx.attach(None, move |_| {
        stats_note_produced();
        glib::ControlFlow::Continue
    });
    // Display-rate render: queue a render every vblank (frame clock) rather than
    // only on mpv's update ping — mpv then picks the correct frame per present.
    glarea.add_tick_callback(|area, _clock| {
        area.queue_render();
        glib::ControlFlow::Continue
    });

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
    // Perf spike: park on the 4K monitor (HDMI-1-0 sits at physical origin) and
    // fullscreen, so the GLArea FBO is the full 4K and we measure the real 4K
    // present/readback cost.  LOOM_SPIKE_WINDOWED=1 keeps it at the default size.
    if std::env::var_os("LOOM_SPIKE_WINDOWED").is_none() {
        win.move_(0, 0);
        win.fullscreen();
    }

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
                    // Seek into real content, then KEEP PLAYING (no pause) so
                    // connect_render fires continuously and the fps counter
                    // measures steady-state 4K present cost.
                    let s = CString::new(format!("seek {} absolute", seek2)).unwrap();
                    unsafe { mpv_command_string(mpv, s.as_ptr()) };
                    let _ = shot2; // screenshot path unused in the perf spike
                });
            }
            glib::ControlFlow::Break
        });
    }

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
