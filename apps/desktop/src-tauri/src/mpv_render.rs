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
use std::os::raw::{c_char, c_int, c_ulong};
use std::ptr;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use gtk::prelude::*;
use gtk::{gdk, glib};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::mpv_ffi::*;

const GL_FRAMEBUFFER_BINDING: u32 = 0x8CA6;

/// Wraps the raw mpv handle so it can cross threads (the client API is
/// thread-safe; the render context is NOT and never leaves the GTK thread).
struct MpvHandle(*mut mpv_handle);
unsafe impl Send for MpvHandle {}

/// One attach generation: the mpv handle + THIS generation's pump flag.  The
/// flag is per-generation (not shared on RenderEngine) so tearing down one
/// window's engine can't accidentally kill — or be revived by — a freshly
/// reopened one: teardown flips the taken generation's flag, and a reopen
/// mints a brand-new flag.  Without this, a fast close→reopen could flip the
/// shared flag false→true and leave the OLD pump looping on a handle the
/// destroyer is about to free (use-after-free).
struct Engine {
    mpv: MpvHandle,
    running: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct RenderEngine {
    inner: Mutex<Option<Engine>>,
}

// The render context lives on the GTK main thread only.
thread_local! {
    static RENDER_CTX: std::cell::Cell<*mut mpv_render_context> =
        std::cell::Cell::new(ptr::null_mut());
}

// ---- EGL direct-present path (LOOM_RENDER_EGL=1) --------------------------
//
// GtkGLArea renders to an OFFSCREEN FBO that GTK blits every frame
// (gdk_cairo_draw_from_gl) — a full-frame readback that caps 4K at ~8-15fps
// AND forces mpv onto a RAM-copy hwdec (GLX/Intel context can't zero-copy).
// This path instead gives the video its own GtkDrawingArea with a hand-rolled
// EGL context, renders mpv straight into that window's default framebuffer
// (fbo 0), and presents with eglSwapBuffers — no offscreen FBO.  An EGL context
// is what unlocks zero-copy VAAPI decode (EGL-dmabuf interop: the decoded VA
// surface is imported directly as a GL texture, never copied to RAM).  Proven
// in spike/mpv-render (run_direct_egl) and standalone mpv v0.41: Godzilla 2160p
// HDR at 23.976fps / 0 drops on this Intel iGPU.  Gated + default-off so the
// shipped GtkGLArea path is unchanged until verified; needs a modern libmpv
// (LOOM_MPV_PREFIX) — jammy's 0.34.1 aborts the VA probe.  The transparent
// webview still composites on top via the same GtkOverlay (Mutter composites
// the overlay window over the video window — spike-verified).
const EGL_OPENGL_API: u32 = 0x30A2;
const EGL_NONE: c_int = 0x3038;
const EGL_SURFACE_TYPE: c_int = 0x3033;
const EGL_WINDOW_BIT: c_int = 0x0004;
const EGL_RENDERABLE_TYPE: c_int = 0x3040;
const EGL_OPENGL_BIT: c_int = 0x0008;
const EGL_RED_SIZE: c_int = 0x3024;
const EGL_GREEN_SIZE: c_int = 0x3023;
const EGL_BLUE_SIZE: c_int = 0x3022;
const EGL_ALPHA_SIZE: c_int = 0x3021;
const EGL_NATIVE_VISUAL_ID: c_int = 0x302E;

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
    fn eglDestroySurface(dpy: *mut c_void, surface: *mut c_void) -> u32;
    fn eglDestroyContext(dpy: *mut c_void, ctx: *mut c_void) -> u32;
    fn eglGetError() -> c_int;
    fn eglGetProcAddress(procname: *const c_char) -> *mut c_void;
}

// gdk-3 X11 backend accessors (libgdk-3 is already linked via gtk) + the
// double-buffer toggle removed from safe gtk-rs 0.18 (so GTK doesn't fight our
// eglSwapBuffers on the video window).
extern "C" {
    fn gdk_x11_display_get_xdisplay(display: *mut c_void) -> *mut c_void;
    fn gdk_x11_window_get_xid(window: *mut c_void) -> c_ulong;
    fn gdk_x11_screen_lookup_visual(screen: *mut c_void, xvisualid: c_ulong) -> *mut c_void;
    fn gtk_widget_set_double_buffered(widget: *mut c_void, double_buffered: c_int);
}

// WebKitGTK: force the webview's own background transparent even when the Tauri
// TOPLEVEL is opaque.  VLC keeps an OPAQUE toplevel (so its video subwindow's
// direct present composites), and its controls sit in sibling windows over the
// video.  To mimic that we make the toplevel opaque AND keep the webview
// transparent (so it reveals the video subwindow below).  Tauri only sets the
// webview transparent when the WINDOW is transparent, so with an opaque window
// we set it ourselves.  (libwebkit2gtk is already linked by wry/tauri.)
#[repr(C)]
struct GdkRGBA {
    red: f64,
    green: f64,
    blue: f64,
    alpha: f64,
}
extern "C" {
    fn webkit_web_view_set_background_color(web_view: *mut c_void, rgba: *const GdkRGBA);
}

// ── DOM snapshot capture (webkit's own rasterization; MOBILE_ROADMAP.md §5a) ──
// webkit_web_view_get_snapshot renders the page to a cairo image surface
// INTERNALLY — independent of window visibility or accelerated-compositing mode.
// This is the capture that works WITHOUT WEBKIT_DISABLE_COMPOSITING_MODE (which
// stalled + double-rendered the real frontend): the webview stays in its normal
// AC path (page runs live) and we still get its transparent pixels.  Every
// OS-window read (cairo surface / gdk_pixbuf / XComposite+XGetImage) is blank
// for a webkit-AC window because the GL front buffer isn't in the X 2D pixmap;
// get_snapshot sidesteps that.  Async (~3–5 ms), fired off the per-frame path.
const WEBKIT_SNAPSHOT_REGION_VISIBLE: c_int = 0;
const WEBKIT_SNAPSHOT_OPTIONS_TRANSPARENT_BACKGROUND: c_int = 1 << 1;
type GAsyncReadyCallback = extern "C" fn(*mut c_void, *mut c_void, *mut c_void);
extern "C" {
    fn webkit_web_view_get_snapshot(
        web_view: *mut c_void,
        region: c_int,
        options: c_int,
        cancellable: *mut c_void,
        callback: GAsyncReadyCallback,
        user_data: *mut c_void,
    );
    fn webkit_web_view_get_snapshot_finish(
        web_view: *mut c_void,
        result: *mut c_void,
        error: *mut *mut c_void,
    ) -> *mut c_void; // cairo_surface_t* (transfer full)
    // libcairo (already linked via gtk/cairo-rs) — read the returned image surface.
    fn cairo_surface_flush(surface: *mut c_void);
    fn cairo_surface_destroy(surface: *mut c_void);
    fn cairo_image_surface_get_data(surface: *mut c_void) -> *mut u8;
    fn cairo_image_surface_get_width(surface: *mut c_void) -> c_int;
    fn cairo_image_surface_get_height(surface: *mut c_void) -> c_int;
    fn cairo_image_surface_get_stride(surface: *mut c_void) -> c_int;
    // glib (already linked) — free a GError from the async finish.
    fn g_error_free(error: *mut c_void);
}

// ── Input forwarding to the offscreen webview (MOBILE_ROADMAP.md §5a stage 2) ──
// The webview lives offscreen, so GTK never delivers real pointer events to it.
// We capture events on the visible video DrawingArea, COPY each (gdk_event_copy
// preserves device/axes/state/coords), RETARGET the copy's window field to the
// webview's GdkWindow, and re-dispatch via gtk_main_do_event — GTK routes by
// event->window's owning widget, so webkit's WebKitWebViewBase input handlers
// fire.  Coords are 1:1 (offscreen webview sized to the video area at origin 0,0).
const GDK_EVENT_WINDOW_OFFSET: usize = 8; // GdkEventAny { int type; GdkWindow* window; … }
extern "C" {
    fn gdk_event_copy(event: *const c_void) -> *mut c_void;
    fn gdk_event_free(event: *mut c_void);
    fn gtk_main_do_event(event: *mut c_void);
    fn g_object_ref(object: *mut c_void) -> *mut c_void;
    fn g_object_unref(object: *mut c_void);
}

/// mpv proc-address resolver for the EGL context — resolves BOTH core GL and
/// the EGL extension entry points (eglCreateImageKHR, glEGLImageTargetTexture2DOES)
/// the vaapi-egl interop needs.  Mesa's eglGetProcAddress returns them all; fall
/// back to epoxy/dlsym for anything it misses.
extern "C" fn get_proc_address_egl(_ctx: *mut c_void, name: *const c_char) -> *mut c_void {
    let p = unsafe { eglGetProcAddress(name) };
    if !p.is_null() {
        return p;
    }
    let n = unsafe { CStr::from_ptr(name) };
    epoxy::get_proc_addr(n.to_str().unwrap_or("")) as *mut c_void
}

// ===== DOM-in-GL composite (LOOM_RENDER_EGL path, MOBILE_ROADMAP.md §5a) =====
// The webview lives in a GtkOffscreenWindow (NOT composited by X over the
// video); we capture its rendered pixels to a GL texture on change and blend
// that texture over mpv's zero-copy video frame ourselves, in the same EGL
// framebuffer, before the single swap.  This is the single-window composite the
// GtkDrawingArea-sub-window approach could not do (proven in spike/webview-
// texture + spike/mpv-render `LOOM_SPIKE_OVERLAY`).  The DOM changes only
// per-cue / on-hover, so the ~3 ms capture is off the per-frame path.
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

#[link(name = "GL")]
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

/// Latest captured webview pixels (BGRA premultiplied, tight `w*4` rows).
struct DomCapture {
    bytes: Vec<u8>,
    w: c_int,
    h: c_int,
    dirty: bool,
}
/// The captured DOM pixels, shared GTK-main (producer: on_dom_snapshot) →
/// render thread (consumer: composite_dom_overlay uploads them to a GL texture).
/// A global Mutex (not a thread-local) precisely because those are now two
/// different threads; the render side `try_lock`s so a frame never stalls on the
/// snapshot writer (a busy lock just reuses the last uploaded texture).
static DOM_SHARED: Mutex<Option<DomCapture>> = Mutex::new(None);
thread_local! {
    static DOM_TEX: std::cell::Cell<u32> = std::cell::Cell::new(0);
    static DOM_UP_DIMS: std::cell::Cell<(c_int, c_int)> = std::cell::Cell::new((0, 0));
    static DOM_OFFSCREEN: std::cell::RefCell<Option<gtk::Window>> =
        std::cell::RefCell::new(None);
    static DOM_DIAG: std::cell::Cell<u64> = std::cell::Cell::new(0);
    static DOM_DREW: std::cell::Cell<bool> = std::cell::Cell::new(false);
    static DOM_ERR: std::cell::Cell<bool> = std::cell::Cell::new(false);
    // The WebKitWebView* to snapshot, and an in-flight guard so the poll never
    // queues multiple async snapshots.  GTK-main-thread only (raw ptr, non-Send).
    static DOM_WEBVIEW: std::cell::Cell<*mut c_void> = std::cell::Cell::new(std::ptr::null_mut());
    static DOM_SNAP_PENDING: std::cell::Cell<bool> = std::cell::Cell::new(false);
    // The webview's GdkWindow (input-forwarding target) + a first-event diag latch.
    static DOM_WV_WINDOW: std::cell::Cell<*mut c_void> = std::cell::Cell::new(std::ptr::null_mut());
    static DOM_INPUT_DIAG: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

// Damage-driven DOM capture (replaces an unconditional 20 Hz snapshot poll that
// saturated the GTK main thread at 4K — starving Tauri IPC during load and
// juddering fullscreen playback).  `DOM_DIRTY_SEQ` is bumped whenever the
// overlay needs re-capturing (frontend `player_dom_dirty` command; a pause-state
// change); the snapshot timer bursts briefly after each bump, else idles.  While
// PAUSED the timer captures every tick (no video frames to stall → no judder),
// so hover-glow / definition-card interactions stay live.  Global (not
// thread-local): written from the pump thread + the command, read on the GTK
// main thread.
static DOM_DIRTY_SEQ: AtomicU64 = AtomicU64::new(0);
static DOM_PAUSED: AtomicBool = AtomicBool::new(false);

// ── Off-main-thread EGL render (root-cause fix for main-thread starvation) ──
// The EGL path's render+composite+eglSwapBuffers loop moved OFF the GTK main
// thread onto a dedicated render thread (spawn_egl_render_thread).  The
// vsync-blocked swap therefore no longer monopolizes the main thread, so Tauri
// `invoke` (readDir on load, seek, pause, settings) and GTK events run free.
// Two tiny values cross the thread boundary:
//   RENDER_DIMS  — the video-area size in device px, packed (w<<32)|h.  GTK main
//                  publishes it (realize + size_allocate, where widget metrics
//                  are legal to read); the render thread reads it each frame for
//                  the mpv FBO dims.  The EGL surface auto-tracks the X window
//                  size, so this only feeds mpv's render rectangle.
//   EGL_PRODUCED — mpv "new frame" pings, bumped from mpv's update callback; the
//                  render thread drains it for the LOOM_RENDER_STATS produced-fps.
static RENDER_DIMS: AtomicU64 = AtomicU64::new(0);
static EGL_PRODUCED: AtomicU32 = AtomicU32::new(0);

/// GTK-main-owned handle to the render thread (spawned at realize, joined at
/// teardown).  Lives in a thread-local like RENDER_CTX — both realize and
/// player_teardown run on the GTK main thread, so no locking is needed.
struct RenderThread {
    running: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}
thread_local! {
    static RENDER_THREAD: std::cell::RefCell<Option<RenderThread>> =
        std::cell::RefCell::new(None);
}

/// mpv render-context update callback for the EGL threaded path: mpv signals a
/// new frame is available.  We render at DISPLAY rate on the render thread (mpv
/// picks the frame), so this only feeds the produced-fps stat — bump an atomic
/// (called from mpv's internal thread; must stay lock-free).
extern "C" fn on_mpv_update_egl(_ctx: *mut c_void) {
    EGL_PRODUCED.fetch_add(1, Ordering::Relaxed);
}

/// GAsyncReadyCallback for webkit_web_view_get_snapshot — copies the returned
/// cairo image surface (BGRA premultiplied) into DOM_CAPTURE, marking it dirty
/// only when the pixels actually change (an idle DOM never re-uploads the GL
/// texture).  Fires on the GTK main thread, same as the render loop.
extern "C" fn on_dom_snapshot(source: *mut c_void, res: *mut c_void, _ud: *mut c_void) {
    DOM_SNAP_PENDING.with(|p| p.set(false));
    let mut err: *mut c_void = std::ptr::null_mut();
    let surf = unsafe { webkit_web_view_get_snapshot_finish(source, res, &mut err) };
    if surf.is_null() {
        if !err.is_null() {
            unsafe { g_error_free(err) };
        }
        return;
    }
    let diag = std::env::var_os("LOOM_RENDER_STATS").is_some()
        && DOM_DIAG.with(|d| {
            let n = d.get() + 1;
            d.set(n);
            n % 40 == 1 // ~every 2s at the 50ms poll
        });
    unsafe {
        cairo_surface_flush(surf);
        let w = cairo_image_surface_get_width(surf);
        let h = cairo_image_surface_get_height(surf);
        let stride = cairo_image_surface_get_stride(surf) as usize;
        let data_ptr = cairo_image_surface_get_data(surf);
        let row = (w * 4) as usize;
        if w > 0 && h > 0 && !data_ptr.is_null() && stride >= row {
            let src = std::slice::from_raw_parts(data_ptr, stride * h as usize);
            let mut bytes = vec![0u8; row * h as usize];
            for y in 0..h as usize {
                let s = y * stride;
                bytes[y * row..(y + 1) * row].copy_from_slice(&src[s..s + row]);
            }
            if diag {
                let mut opaque = 0usize;
                let mut n = 0usize;
                let mut i = 3usize;
                while i < bytes.len() {
                    if bytes[i] > 10 {
                        opaque += 1;
                    }
                    n += 1;
                    i += 64;
                }
                eprintln!(
                    "[Loom DOM] snapshot {w}x{h} — {:.1}% non-transparent",
                    100.0 * opaque as f64 / n.max(1) as f64
                );
            }
            if let Ok(mut slot) = DOM_SHARED.lock() {
                let changed = match slot.as_ref() {
                    Some(prev) => prev.w != w || prev.h != h || prev.bytes != bytes,
                    None => true,
                };
                if changed {
                    *slot = Some(DomCapture { bytes, w, h, dirty: true });
                }
            }
        }
        cairo_surface_destroy(surf);
    }
}

/// Fire an async webview snapshot (webkit rasterizes the page to a cairo surface
/// itself — works in normal AC mode, no software-render stall).  No-op if the
/// webview isn't set yet or a snapshot is already in flight.  GTK-main only.
fn request_dom_snapshot() {
    let wv = DOM_WEBVIEW.with(|w| w.get());
    if wv.is_null() {
        return;
    }
    if DOM_SNAP_PENDING.with(|p| p.get()) {
        return; // don't queue multiple; the poll catches the next
    }
    DOM_SNAP_PENDING.with(|p| p.set(true));
    unsafe {
        webkit_web_view_get_snapshot(
            wv,
            WEBKIT_SNAPSHOT_REGION_VISIBLE,
            WEBKIT_SNAPSHOT_OPTIONS_TRANSPARENT_BACKGROUND,
            std::ptr::null_mut(),
            on_dom_snapshot,
            std::ptr::null_mut(),
        );
    }
}

/// Retarget a video-area pointer event to the offscreen webview and re-dispatch
/// it (copy → swap window field → gtk_main_do_event).  GTK-main-thread only.
fn forward_event_to_webview(ev: &gdk::Event) {
    use glib::translate::ToGlibPtr;
    let win = DOM_WV_WINDOW.with(|w| w.get());
    if win.is_null() {
        return;
    }
    if std::env::var_os("LOOM_RENDER_STATS").is_some() {
        use gdk::EventType::*;
        let et = ev.event_type();
        if matches!(et, ButtonPress | ButtonRelease | Scroll) {
            let (x, y) = ev.coords().unwrap_or((-1.0, -1.0));
            eprintln!("[Loom DOM] input fwd: {et:?} at ({x:.0},{y:.0}) → webview");
        }
    }
    let raw: *mut gdk::ffi::GdkEvent = ev.to_glib_none().0;
    if raw.is_null() {
        return;
    }
    unsafe {
        let copy = gdk_event_copy(raw as *const c_void);
        if copy.is_null() {
            return;
        }
        // Swap the event's window (2nd field) to the webview's; keep refcounts sane.
        let win_field = (copy as *mut u8).add(GDK_EVENT_WINDOW_OFFSET) as *mut *mut c_void;
        let old = *win_field;
        g_object_ref(win);
        *win_field = win;
        if !old.is_null() {
            g_object_unref(old);
        }
        gtk_main_do_event(copy);
        gdk_event_free(copy);
    }
    DOM_INPUT_DIAG.with(|d| {
        if !d.get() && std::env::var_os("LOOM_RENDER_STATS").is_some() {
            d.set(true);
            eprintln!("[Loom DOM] input: first event forwarded to the offscreen webview");
        }
    });
}

/// Upload the latest capture to the DOM texture (only when dirty) and blend it
/// over mpv's frame.  Called from the render loop with the EGL context current.
fn composite_dom_overlay(vw: c_int, vh: c_int) {
    // Upload the latest capture IF a fresh one is ready.  try_lock (never block):
    // if GTK main is mid-write, we simply reuse the last uploaded texture this
    // frame — the video frame is never held up by the snapshot writer.
    if let Ok(mut slot) = DOM_SHARED.try_lock() {
        if let Some(cap) = slot.as_mut() {
            if cap.dirty {
                let tex = DOM_TEX.with(|t| {
                    let mut id = t.get();
                    if id == 0 {
                        unsafe { glGenTextures(1, &mut id) };
                        t.set(id);
                    }
                    id
                });
                unsafe {
                    glBindTexture(GLO_TEXTURE_2D, tex);
                    glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_MIN_FILTER, GLO_LINEAR);
                    glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_MAG_FILTER, GLO_LINEAR);
                    glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_WRAP_S, GLO_CLAMP_TO_EDGE);
                    glTexParameteri(GLO_TEXTURE_2D, GLO_TEXTURE_WRAP_T, GLO_CLAMP_TO_EDGE);
                    glTexImage2D(
                        GLO_TEXTURE_2D, 0, GLO_RGBA, cap.w, cap.h, 0,
                        GLO_BGRA, GLO_UNSIGNED_BYTE, cap.bytes.as_ptr() as *const c_void,
                    );
                }
                cap.dirty = false;
                DOM_UP_DIMS.with(|d| d.set((cap.w, cap.h)));
            }
        }
    }
    let tex = DOM_TEX.with(|t| t.get());
    if tex == 0 {
        return; // nothing captured/uploaded yet
    }
    unsafe {
        glBindFramebuffer(GLO_FRAMEBUFFER, 0); // on-screen buffer
        let uploaded = Some(DOM_UP_DIMS.with(|d| d.get()));
        DOM_DREW.with(|d| {
            if !d.get() && std::env::var_os("LOOM_RENDER_STATS").is_some() {
                d.set(true);
                eprintln!(
                    "[Loom DOM] composite: first draw tex={tex} cap={uploaded:?} viewport={vw}x{vh}"
                );
            }
        });
        glUseProgram(0); // fixed-function (mpv may leave a program bound)
        glViewport(0, 0, vw, vh);
        glDisable(GLO_SCISSOR_TEST);
        glDisable(GLO_DEPTH_TEST);
        glBindTexture(GLO_TEXTURE_2D, tex);
        glEnable(GLO_TEXTURE_2D);
        glEnable(GLO_BLEND);
        glBlendFunc(GLO_ONE, GLO_ONE_MINUS_SRC_ALPHA); // cairo data is PREMULTIPLIED
        glColor4f(1.0, 1.0, 1.0, 1.0);
        glBegin(GLO_QUADS);
        // full-screen NDC quad; V flipped so the DOM's top maps to screen top
        glTexCoord2f(0.0, 1.0); glVertex2f(-1.0, -1.0);
        glTexCoord2f(1.0, 1.0); glVertex2f(1.0, -1.0);
        glTexCoord2f(1.0, 0.0); glVertex2f(1.0, 1.0);
        glTexCoord2f(0.0, 0.0); glVertex2f(-1.0, 1.0);
        glEnd();
        glDisable(GLO_TEXTURE_2D);
        // DIAG (LOOM_DOM_TESTQUAD): solid opaque green square, top-left, NO
        // texture — isolates the raw draw path (viewport/state) from the texture.
        if std::env::var_os("LOOM_DOM_TESTQUAD").is_some() {
            glColor4f(0.0, 1.0, 0.0, 1.0);
            glBegin(GLO_QUADS);
            glVertex2f(-0.9, 0.9);
            glVertex2f(-0.5, 0.9);
            glVertex2f(-0.5, 0.5);
            glVertex2f(-0.9, 0.5);
            glEnd();
        }
        glDisable(GLO_BLEND);
        DOM_ERR.with(|d| {
            if !d.get() && std::env::var_os("LOOM_RENDER_STATS").is_some() {
                d.set(true);
                eprintln!("[Loom DOM] composite: first draw glGetError=0x{:x}", glGetError());
            }
        });
    }
}

// Optional render/composite instrumentation, enabled with LOOM_RENDER_STATS=1.
// Both the mpv "new frame available" signal (queue_render, ~video fps) and the
// GTK render signal (connect_render, actual on-screen fps) fire on THIS thread,
// so a thread-local counter measures both without locking.  The key reading:
// on-screen fps well below produced fps means we're dropping frames at the GTK
// composite / transparent-webview-overlay stage — which happens AFTER our
// render callback returns, so a SMALL render-call time alongside a low
// on-screen fps is the signature of "the compositing path, not mpv's GL render,
// is the bottleneck."  Silent + effectively free when the env var is unset.
thread_local! {
    static FRAME_STATS: std::cell::RefCell<FrameStats> =
        std::cell::RefCell::new(FrameStats::new());
}

struct FrameStats {
    enabled: bool,
    start: std::time::Instant,
    produced: u32,
    rendered: u32,
    render_ns_sum: u128,
    render_ns_max: u128,
    w: i32,
    h: i32,
}

impl FrameStats {
    fn new() -> Self {
        Self {
            enabled: std::env::var_os("LOOM_RENDER_STATS").is_some(),
            start: std::time::Instant::now(),
            produced: 0,
            rendered: 0,
            render_ns_sum: 0,
            render_ns_max: 0,
            w: 0,
            h: 0,
        }
    }

    fn flush_if_due(&mut self) {
        let elapsed = self.start.elapsed();
        if elapsed.as_secs_f64() < 1.0 {
            return;
        }
        let secs = elapsed.as_secs_f64();
        let avg_ms = if self.rendered > 0 {
            (self.render_ns_sum as f64 / self.rendered as f64) / 1.0e6
        } else {
            0.0
        };
        eprintln!(
            "[Loom render] {:.1} fps on-screen · mpv produced {:.1} · render-call avg {:.2}ms max {:.2}ms · fbo {}x{}",
            self.rendered as f64 / secs,
            self.produced as f64 / secs,
            avg_ms,
            self.render_ns_max as f64 / 1.0e6,
            self.w,
            self.h,
        );
        self.start = std::time::Instant::now();
        self.produced = 0;
        self.rendered = 0;
        self.render_ns_sum = 0;
        self.render_ns_max = 0;
    }
}

/// Count an mpv "new frame" signal (called just before queue_render).
fn stats_note_produced() {
    FRAME_STATS.with(|s| {
        let mut s = s.borrow_mut();
        if !s.enabled {
            return;
        }
        s.produced += 1;
        s.flush_if_due();
    });
}

/// Count an actual GTK render + the time mpv's GL render took inside it.
fn stats_note_render(dur: std::time::Duration, w: i32, h: i32) {
    FRAME_STATS.with(|s| {
        let mut s = s.borrow_mut();
        if !s.enabled {
            return;
        }
        s.rendered += 1;
        let ns = dur.as_nanos();
        s.render_ns_sum += ns;
        s.render_ns_max = s.render_ns_max.max(ns);
        s.w = w;
        s.h = h;
        s.flush_if_due();
    });
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

// Audio defaults ON.  The engine is created WITHOUT a mute option (mpv's
// default is unmuted), so the old "always start muted" floor is gone; the mute
// button (player_set_mute) is now a plain in-session toggle, and volume is
// persisted on the frontend.

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

/// Route pointer input to the transparent webview that sits over the video.
///
/// GtkGLArea is a WINDOWLESS widget: on realize it creates an invisible
/// `GDK_INPUT_ONLY` "event window" as a sibling of the webview's overlay
/// window, and GtkOverlay never restacks the main child's windows — so that
/// event window ends up stacked ABOVE the webview and silently swallows every
/// pointer event (the "renders fine but no buttons work" bug).  The GL pixels
/// paint into the toplevel content window, not the event window, so it's
/// invisible; only INPUT is affected.
///
/// The window to raise is the webview's *parent* GdkWindow — the overlay-
/// created child window, which is the real sibling of the event window.
/// Raising the webview's OWN window only reorders within its subtree and does
/// nothing.  Idempotent; touches GdkWindow stacking only, so the widget tree
/// (and Tauri's edge-resize `parent().parent() == Window` assumption) is
/// untouched.  Must be re-applied whenever the GLArea re-shows/moves its event
/// window (map / size-allocate), which re-raises it above the webview again.
fn raise_overlay_input(webview: &gtk::Widget) {
    if let Some(v) = webview.window() {
        if let Some(o) = v.parent() {
            o.raise(); // overlay child window above the GLArea event window
        }
        v.raise();
    }
}

/// The dedicated EGL render thread (root-cause fix for GTK-main starvation).
///
/// Owns the EGL context + mpv render context for its whole life: makes the
/// context current ONCE here (never on the GTK main thread), then renders +
/// composites the DOM overlay + swaps at display rate.  The vsync-blocked
/// eglSwapBuffers paces THIS thread to the monitor without ever touching the GTK
/// main thread — which is now free for Tauri `invoke` (readDir on load, seek,
/// pause, settings) and GTK events.  Stops when `running` clears (teardown) and
/// frees the render context then the EGL objects on the way out; teardown joins
/// this thread before destroying the mpv handle, so the required
/// mpv_render_context_free-before-mpv_terminate_destroy order holds.
///
/// All handles cross the thread boundary as `usize` (the same Send-avoidance
/// pattern the pump thread uses for the mpv handle).
fn spawn_egl_render_thread(
    egl_dpy: usize,
    egl_surf: usize,
    egl_ctx: usize,
    xdisplay: usize,
    mpv_addr: usize,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let dpy = egl_dpy as *mut c_void;
        let surf = egl_surf as *mut c_void;
        let ctx = egl_ctx as *mut c_void;
        if unsafe { eglMakeCurrent(dpy, surf, surf, ctx) } == 0 {
            eprintln!("[Loom mpv] EGL render thread: eglMakeCurrent failed: 0x{:x}", unsafe {
                eglGetError()
            });
            return;
        }
        // vsync interval — paces this thread.  LOOM_SWAP_INTERVAL=0 disables vsync
        // (diagnostic: isolates raw eglSwapBuffers cost from compositor vblank-wait).
        let swap_interval: i32 = std::env::var("LOOM_SWAP_INTERVAL")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1);
        unsafe { eglSwapInterval(dpy, swap_interval) };
        if std::env::var_os("LOOM_RENDER_STATS").is_some() {
            eprintln!("[Loom render] eglSwapInterval({swap_interval})");
        }

        // Create the mpv render context ON THIS THREAD (the GL context lives here
        // now).  X11_DISPLAY lets mpv open the VA display for zero-copy dmabuf
        // interop, exactly as the old GTK-main realize did.
        let mut init = mpv_opengl_init_params {
            get_proc_address: Some(get_proc_address_egl),
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
                type_: MPV_RENDER_PARAM_X11_DISPLAY,
                data: xdisplay as *mut c_void,
            },
            mpv_render_param {
                type_: MPV_RENDER_PARAM_INVALID,
                data: ptr::null_mut(),
            },
        ];
        let mut rctx: *mut mpv_render_context = ptr::null_mut();
        let rc = unsafe {
            mpv_render_context_create(&mut rctx, mpv_addr as *mut mpv_handle, params.as_mut_ptr())
        };
        if rc < 0 || rctx.is_null() {
            eprintln!("[Loom mpv] EGL render thread: render_context_create failed: {rc}");
            unsafe { eglMakeCurrent(dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut()) };
            return;
        }
        unsafe {
            mpv_render_context_set_update_callback(rctx, on_mpv_update_egl, ptr::null_mut());
        }
        if std::env::var_os("LOOM_RENDER_STATS").is_some() {
            eprintln!("[Loom render] EGL render thread up — render context off the GTK main thread");
        }

        // Display-rate loop: render + composite + swap; the vsync-blocked swap
        // paces us.  mpv picks the right frame each pass (rendering only on mpv's
        // "new frame" ping throttled 4K to ~15fps — the display-rate loop is the
        // proven-smooth path, now simply on its own thread).
        let stats_on = std::env::var_os("LOOM_RENDER_STATS").is_some();
        let mut s_start = std::time::Instant::now();
        let (mut rendered, mut ns_sum, mut ns_max) = (0u32, 0u128, 0u128);
        // Separate accounting for the two post-render stages, to pinpoint the 4K
        // present cost (composite = DOM texture upload+quad; swap = eglSwapBuffers,
        // i.e. the compositor's present of our window).
        let (mut comp_sum, mut comp_max, mut swap_sum, mut swap_max) =
            (0u128, 0u128, 0u128, 0u128);
        while running.load(Ordering::Relaxed) {
            let packed = RENDER_DIMS.load(Ordering::Relaxed);
            let w = (packed >> 32) as i32;
            let h = (packed & 0xffff_ffff) as i32;
            if w <= 0 || h <= 0 {
                std::thread::sleep(std::time::Duration::from_millis(8)); // await first size
                continue;
            }
            let mut fbo = mpv_opengl_fbo { fbo: 0, w, h, internal_format: 0 };
            let mut flip: i32 = 1;
            let mut rparams = [
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
            unsafe { mpv_render_context_render(rctx, rparams.as_mut_ptr()) };
            let dur = t0.elapsed();
            // Blend the captured DOM (offscreen webview) over the video in the
            // SAME framebuffer, before the single swap — DOM-in-GL.
            let t1 = std::time::Instant::now();
            composite_dom_overlay(w, h);
            let comp = t1.elapsed();
            let t2 = std::time::Instant::now();
            unsafe { eglSwapBuffers(dpy, surf) };
            let swap = t2.elapsed();
            unsafe { mpv_render_context_report_swap(rctx) };
            if stats_on {
                rendered += 1;
                let ns = dur.as_nanos();
                ns_sum += ns;
                ns_max = ns_max.max(ns);
                comp_sum += comp.as_nanos();
                comp_max = comp_max.max(comp.as_nanos());
                swap_sum += swap.as_nanos();
                swap_max = swap_max.max(swap.as_nanos());
                let el = s_start.elapsed().as_secs_f64();
                if el >= 1.0 {
                    let produced = EGL_PRODUCED.swap(0, Ordering::Relaxed);
                    let n = rendered.max(1) as f64;
                    eprintln!(
                        "[Loom render] {:.1} fps on-screen · produced {:.1} · render {:.2}ms · composite {:.2}ms · swap {:.2}ms(max {:.1}) · fbo {}x{}",
                        rendered as f64 / el,
                        produced as f64 / el,
                        (ns_sum as f64 / n) / 1.0e6,
                        (comp_sum as f64 / n) / 1.0e6,
                        (swap_sum as f64 / n) / 1.0e6,
                        swap_max as f64 / 1.0e6,
                        w,
                        h,
                    );
                    s_start = std::time::Instant::now();
                    rendered = 0;
                    ns_sum = 0;
                    ns_max = 0;
                    comp_sum = 0;
                    comp_max = 0;
                    swap_sum = 0;
                    swap_max = 0;
                }
            }
        }

        // Teardown (running cleared by player_teardown, which then joins us): free
        // the render context, then the EGL objects — the order mpv requires before
        // its handle is destroyed (still alive here, since teardown joins first).
        unsafe {
            mpv_render_context_free(rctx);
            eglMakeCurrent(dpy, ptr::null_mut(), ptr::null_mut(), ptr::null_mut());
            eglDestroySurface(dpy, surf);
            eglDestroyContext(dpy, ctx);
        }
        if std::env::var_os("LOOM_RENDER_STATS").is_some() {
            eprintln!("[Loom render] EGL render thread exited cleanly");
        }
    })
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

    // The direct-EGL zero-copy render path (default off — the shipped GtkGLArea
    // path is unchanged until this is verified).  Enable with LOOM_RENDER_EGL=1.
    let use_egl = std::env::var_os("LOOM_RENDER_EGL").is_some();

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
    // Hardware decode path.  The 4K bottleneck was NOT present/compositing —
    // it's the decode-frame path: on this Optimus box the GL context sits on
    // the Intel iGPU, so CUDA can't interop and mpv was forced onto a *-copy
    // hwdec (per-frame 4K GPU→RAM→GPU roundtrip, ~15fps cap).  When PRIME
    // offload put our GL context on NVIDIA (`enable_gpu_offload` in lib.rs,
    // signalled by LOOM_PRIME_ACTIVE), `cuda-nvdec` ZERO-COPY interop works —
    // so default to `auto` (picks the zero-copy path).  Without a working
    // NVIDIA context, `auto-copy` is the portable fallback (always renders,
    // just from RAM frames).  LOOM_HWDEC overrides either way (A/B a box).
    let hwdec = std::env::var("LOOM_HWDEC").unwrap_or_else(|_| {
        if use_egl {
            // EGL context → zero-copy VAAPI dmabuf interop (Intel/AMD).  Proven
            // path on this box; mpv imports the VA surface straight to a GL
            // texture, no RAM roundtrip.  (Shipping should auto-detect per GPU:
            // vaapi on Intel/AMD, nvdec/vdpau-egl on NVIDIA — vaapi is explicit
            // here for the verified Linux/Intel case.)
            "vaapi".to_string()
        } else if std::env::var_os("LOOM_PRIME_ACTIVE").is_some() {
            "auto".to_string()
        } else {
            "auto-copy".to_string()
        }
    });
    if std::env::var_os("LOOM_RENDER_STATS").is_some() {
        eprintln!("[Loom render] hwdec requested: {hwdec}");
    }
    set_opt(mpv, "hwdec", &hwdec);
    set_opt(mpv, "terminal", "no");
    // Diagnostic: LOOM_MPV_LOG=1 turns on mpv's own terminal logging (file load,
    // vo reconfig, decode, frame timing) — the direct window into what mpv is
    // doing.  Off by default.
    if std::env::var_os("LOOM_MPV_LOG").is_some() {
        set_opt(mpv, "terminal", "yes");
        set_opt(mpv, "msg-level", "all=v");
    }
    set_opt(mpv, "sid", "no"); // captions are Loom's DOM overlay, not libass
    // Give the player its OWN PulseAudio identity ("Loom") instead of the
    // generic "mpv".  PulseAudio's stream-restore DB remembers per-application
    // mute/volume across launches; a stale "mpv → muted" entry (e.g. from once
    // muting the stream in the system mixer) silently re-mutes our audio at the
    // OS level on EVERY launch, and NO in-app mute/volume change can override
    // it (mpv's mute is a different layer).  A distinct client name gets a
    // fresh, unmuted stream-restore entry.  (Was the "why is it always muted"
    // bug — the silence was in PulseAudio, not the code.)
    set_opt(mpv, "audio-client-name", "Loom");
    // NOTE: no mute option — the engine starts UNMUTED (mpv default).  Audio
    // plays on load; the mute button is a session toggle (player_set_mute).
    // Perf-test only: route audio to the null output so an automated render
    // measurement (LOOM_OPEN auto-launch) doesn't blast sound.  The null AO
    // can't be overridden by the frontend's volume/mute path, so it stays quiet
    // for the whole run.  Never set in normal use.
    if std::env::var_os("LOOM_TEST_SILENT").is_some() {
        set_opt(mpv, "ao", "null");
    }
    if unsafe { mpv_initialize(mpv) } < 0 {
        unsafe { mpv_terminate_destroy(mpv) };
        return Err("mpv_initialize failed".into());
    }

    // Observe the properties the frontend transport UI lives off (+ dwidth/
    // dheight = the video's display size, for picture-relative caption scaling).
    for (id, name) in [
        (1u64, "time-pos"),
        (2, "pause"),
        (3, "duration"),
        (4, "eof-reached"),
        (5, "speed"),
        (6, "dwidth"),
        (7, "dheight"),
        (8, "hwdec-current"), // diagnostic: which decoder actually engaged
    ] {
        let cname = CString::new(name).unwrap();
        let fmt = match name {
            "pause" | "eof-reached" => MPV_FORMAT_FLAG,
            "hwdec-current" => MPV_FORMAT_STRING,
            _ => MPV_FORMAT_DOUBLE,
        };
        unsafe { mpv_observe_property(mpv, id, cname.as_ptr(), fmt) };
    }

    // ---- GTK surgery: gtk_window → GtkOverlay { <video base>, webview } ----
    //
    // Tauri's Linux edge-resize handler hardcodes `webview.parent().parent()
    // == gtk::Window` (undecorated_resizing.rs) — the default tree is
    // Window → vbox → webview (2 levels).  So we must keep the webview
    // EXACTLY 2 levels below the window: pull the webview out of Tauri's
    // vbox and make the GtkOverlay the window's direct child holding
    // [video base, webview (overlay)].  Inserting the overlay ABOVE the
    // vbox (3 levels) makes that downcast get the GtkOverlay and panic.
    // The video base is a GtkGLArea (shipped) or, with LOOM_RENDER_EGL, a
    // GtkDrawingArea with a hand-rolled EGL context (zero-copy VAAPI).
    let webview_widget = vbox
        .children()
        .into_iter()
        .next()
        .ok_or("Tauri vbox has no webview child")?;
    gtk_window.remove(&vbox);
    vbox.remove(&webview_widget);
    // The webview is the interactive surface; make its overlay window cover the
    // FULL area, else clicks in any uncovered margin fall through to the base
    // widget's window / input-only event window (see raise_overlay_input).
    webview_widget.set_halign(gtk::Align::Fill);
    webview_widget.set_valign(gtk::Align::Fill);
    webview_widget.set_hexpand(true);
    webview_widget.set_vexpand(true);

    // VLC-style single window: OPAQUE toplevel (so the direct-present video
    // subwindow composites) + a TRANSPARENT webview over it (so its empty
    // regions reveal the video).  Tauri only makes the webview transparent when
    // the WINDOW is transparent; with an opaque window we must set the webview's
    // WebKit background transparent ourselves, or it paints white over the video.
    if use_egl {
        use glib::translate::ToGlibPtr;
        let wv_ptr: *mut c_void = {
            let p: *mut gtk::ffi::GtkWidget = webview_widget.to_glib_none().0;
            p as *mut c_void
        };
        let transparent = GdkRGBA { red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0 };
        unsafe { webkit_web_view_set_background_color(wv_ptr, &transparent) };
        eprintln!("[Loom mpv] EGL: forced webview WebKit background transparent (opaque toplevel)");
    }

    let overlay = gtk::Overlay::new();
    let mpv_addr = mpv as usize;

    if use_egl {
        // ===== Direct-EGL video surface (zero-copy VAAPI) =====
        use glib::translate::{from_glib_none, ToGlibPtr};
        let display = gdk::Display::default().ok_or("no gdk display")?;
        let screen = display.default_screen();
        let display_ptr: *mut gdk::ffi::GdkDisplay = display.to_glib_none().0;
        let screen_glib: *mut gdk::ffi::GdkScreen = screen.to_glib_none().0;
        let xdisplay = unsafe { gdk_x11_display_get_xdisplay(display_ptr as *mut c_void) };
        let screen_ptr = screen_glib as *mut c_void;

        let egl_dpy = unsafe { eglGetDisplay(xdisplay) };
        if egl_dpy.is_null() {
            unsafe { mpv_terminate_destroy(mpv) };
            return Err("eglGetDisplay returned null".into());
        }
        let (mut maj, mut min): (c_int, c_int) = (0, 0);
        if unsafe { eglInitialize(egl_dpy, &mut maj, &mut min) } == 0 {
            let e = unsafe { eglGetError() };
            unsafe { mpv_terminate_destroy(mpv) };
            return Err(format!("eglInitialize failed: 0x{e:x}"));
        }
        unsafe { eglBindAPI(EGL_OPENGL_API) };
        // KNOWN LIMITATION (2026-07-14): this single-window direct-EGL path does
        // NOT composite with the webview.  The Tauri toplevel is ARGB
        // (transparent, for the webview), so the compositor (Mutter) REDIRECTS it
        // to an offscreen pixmap — but a direct eglSwapBuffers to the child video
        // window writes its real front buffer, bypassing the redirection pixmap,
        // so the video never reaches the composited output (opaque config → video
        // invisible behind the webview; alpha config → the window shows the
        // desktop straight through).  The spike worked only because its toplevel
        // was opaque (unredirected).  The fix is architectural (video in its OWN
        // toplevel where direct scanout works, i.e. dual-window) — see notes.
        // ALPHA_SIZE 0 = opaque video surface (correct for a video toplevel).
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
        if unsafe { eglChooseConfig(egl_dpy, cfg_attribs.as_ptr(), &mut config, 1, &mut num) } == 0
            || num == 0
        {
            unsafe { mpv_terminate_destroy(mpv) };
            return Err("eglChooseConfig found no config".into());
        }
        let mut visid: c_int = 0;
        unsafe { eglGetConfigAttrib(egl_dpy, config, EGL_NATIVE_VISUAL_ID, &mut visid) };
        let gvisual_ptr = unsafe { gdk_x11_screen_lookup_visual(screen_ptr, visid as c_ulong) };
        if gvisual_ptr.is_null() {
            unsafe { mpv_terminate_destroy(mpv) };
            return Err(format!("gdk visual lookup null for 0x{visid:x}"));
        }
        let gvisual: gdk::Visual = unsafe { from_glib_none(gvisual_ptr as *mut gdk::ffi::GdkVisual) };
        let egl_ctx = unsafe { eglCreateContext(egl_dpy, config, ptr::null_mut(), ptr::null()) };
        if egl_ctx.is_null() {
            let e = unsafe { eglGetError() };
            unsafe { mpv_terminate_destroy(mpv) };
            return Err(format!("eglCreateContext failed: 0x{e:x}"));
        }
        if std::env::var_os("LOOM_RENDER_STATS").is_some() {
            eprintln!(
                "[Loom render] EGL {maj}.{min}, visual 0x{visid:x} — direct present + VAAPI zero-copy"
            );
        }

        // Native-window DrawingArea matching the EGL config's visual.  We own
        // the buffer swap (eglSwapBuffers), so stop GTK double-buffering it.
        let area = gtk::DrawingArea::new();
        area.set_visual(Some(&gvisual));
        area.set_app_paintable(true);
        let area_ptr: *mut gtk::ffi::GtkDrawingArea = area.to_glib_none().0;
        unsafe { gtk_widget_set_double_buffered(area_ptr as *mut c_void, 0) };
        overlay.add(&area);

        // Forward pointer/scroll input from the visible video area to the
        // offscreen webview (spike — see forward_event_to_webview).  The area
        // owns a native GdkWindow, so it can receive these once masked.
        area.add_events(
            gdk::EventMask::BUTTON_PRESS_MASK
                | gdk::EventMask::BUTTON_RELEASE_MASK
                | gdk::EventMask::POINTER_MOTION_MASK
                | gdk::EventMask::SCROLL_MASK
                | gdk::EventMask::ENTER_NOTIFY_MASK
                | gdk::EventMask::LEAVE_NOTIFY_MASK,
        );
        area.connect_event(|_, ev| {
            use gdk::EventType::*;
            if matches!(
                ev.event_type(),
                ButtonPress | ButtonRelease | MotionNotify | Scroll | EnterNotify | LeaveNotify
            ) {
                forward_event_to_webview(ev);
            }
            glib::Propagation::Proceed
        });

        // Realize → create the EGL window surface, publish the initial size, and
        // hand the surface to the DEDICATED render thread, which owns the mpv
        // render context from here on.  NOTHING GL touches the GTK main thread
        // after this — that's the whole point (the vsync-blocked swap no longer
        // starves Tauri IPC / GTK events).
        let egl_dpy_addr = egl_dpy as usize;
        let egl_ctx_addr = egl_ctx as usize;
        let config_addr = config as usize;
        let xdisplay_addr = xdisplay as usize;
        area.connect_realize(move |a| {
            let gdkwin = match a.window() {
                Some(w) => w,
                None => {
                    eprintln!("[Loom mpv] EGL: drawing area has no GdkWindow");
                    return;
                }
            };
            let win_ptr: *mut gdk::ffi::GdkWindow = gdkwin.to_glib_none().0;
            let xid = unsafe { gdk_x11_window_get_xid(win_ptr as *mut c_void) };
            let egl_dpy = egl_dpy_addr as *mut c_void;
            let config = config_addr as *mut c_void;
            let surf = unsafe { eglCreateWindowSurface(egl_dpy, config, xid, ptr::null()) };
            if surf.is_null() {
                eprintln!("[Loom mpv] EGL: eglCreateWindowSurface failed: 0x{:x}", unsafe {
                    eglGetError()
                });
                return;
            }
            // Publish the initial video-area size so the render thread has valid
            // FBO dims for its first frame (device px = logical × scale factor).
            let scale = a.scale_factor();
            let w = (a.allocated_width() * scale).max(1) as u32;
            let h = (a.allocated_height() * scale).max(1) as u32;
            RENDER_DIMS.store(((w as u64) << 32) | h as u64, Ordering::Relaxed);
            // Spawn once — guard a second realize (unmap/remap) from starting a
            // duplicate render thread on the same surface.
            if RENDER_THREAD.with(|r| r.borrow().is_some()) {
                return;
            }
            let running = Arc::new(AtomicBool::new(true));
            let handle = spawn_egl_render_thread(
                egl_dpy_addr,
                surf as usize,
                egl_ctx_addr,
                xdisplay_addr,
                mpv_addr,
                running.clone(),
            );
            RENDER_THREAD.with(|r| *r.borrow_mut() = Some(RenderThread { running, handle }));
        });

        // Keep the offscreen webview sized to the video picture (so the DOM lays
        // out at the on-screen size) AND publish the new size to the render
        // thread; re-capture after a resize settles.
        {
            area.connect_size_allocate(move |a, alloc| {
                let w = alloc.width().max(1);
                let h = alloc.height().max(1);
                DOM_OFFSCREEN.with(|o| {
                    if let Some(ow) = o.borrow().as_ref() {
                        ow.resize(w, h);
                    }
                });
                let scale = a.scale_factor();
                let dw = (alloc.width() * scale).max(1) as u32;
                let dh = (alloc.height() * scale).max(1) as u32;
                RENDER_DIMS.store(((dw as u64) << 32) | dh as u64, Ordering::Relaxed);
                request_dom_snapshot();
            });
        }
    } else {
        // ===== GtkGLArea video surface (shipped path — unchanged) =====
        let glarea = gtk::GLArea::new();
        glarea.set_has_alpha(false);
        // Let GTK pick the context type (GLES/desktop) that matches the
        // system/webkit stack — forcing desktop GL segfaults libmpv when the
        // realized context is GLES.
        glarea.set_auto_render(false);
        overlay.add(&glarea);

        // The mpv "new frame" ping wakes the GTK main loop to queue_render — this
        // path renders on the GTK thread via the GLArea render signal (the
        // shipped default, unchanged).  The EGL path renders off-thread instead
        // and doesn't use this channel.
        let (tx, rx) = glib::MainContext::channel::<()>(glib::Priority::default());
        let bridge = Box::into_raw(Box::new(UpdateBridge { tx }));

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
            let t0 = std::time::Instant::now();
            unsafe { mpv_render_context_render(rctx, params.as_mut_ptr()) };
            stats_note_render(t0.elapsed(), fbo.w, fbo.h);
            glib::Propagation::Proceed
        });

        {
            let glarea = glarea.clone();
            rx.attach(None, move |_| {
                stats_note_produced();
                glarea.queue_render();
                glib::ControlFlow::Continue
            });
        }

        // Keep the webview's overlay window above the GLArea's input-only event
        // window across the events that re-raise it (map when the window is
        // shown, size-allocate on move/resize).  See raise_overlay_input.
        {
            let wv = webview_widget.clone();
            glarea.connect_map(move |_| raise_overlay_input(&wv));
        }
        {
            let wv = webview_widget.clone();
            glarea.connect_size_allocate(move |_, _| raise_overlay_input(&wv));
        }
    }

    if use_egl {
        // ===== DOM-in-GL: the webview renders OFFSCREEN; the render loop blends
        // its captured texture over the video (no X-composited sibling). =====
        gtk_window.add(&overlay); // visible window = the video area only

        // A REAL, mapped GtkWindow (not GtkOffscreenWindow): webkit only processes
        // input on a NATIVE X11 window — an offscreen window's client-side GdkWindow
        // makes webkit ignore forwarded events ("drawable is not a native X11
        // window").  get_snapshot captures it regardless of position, so we map it
        // OFF-SCREEN (invisible to the user → still one visible window) and forward
        // input to it.  Decoration/taskbar/pager hints keep it out of the WM UI.
        // A managed Toplevel (NOT a Popup): webkit only processes input on a
        // WM-managed native window — an override-redirect Popup breaks input just
        // like an offscreen window did.  We keep it invisible with opacity 0 (the
        // compositor renders it fully transparent) — get_snapshot still captures
        // the DOM (webkit-internal, opacity-independent) — plus decoration/taskbar
        // hints and an off-screen move so it never shows in the WM UI.
        let offscreen = gtk::Window::new(gtk::WindowType::Toplevel);
        offscreen.set_decorated(false);
        offscreen.set_skip_taskbar_hint(true);
        offscreen.set_skip_pager_hint(true);
        offscreen.set_type_hint(gdk::WindowTypeHint::Utility);
        offscreen.set_opacity(0.0);
        // RGBA visual so the DOM's transparent background survives the capture.
        if let Some(rgba) = gtk::prelude::WidgetExt::screen(&gtk_window).and_then(|s| s.rgba_visual()) {
            offscreen.set_visual(Some(&rgba));
        }
        offscreen.set_app_paintable(true);
        offscreen.set_default_size(1280, 720); // resized to the video on size_allocate
        offscreen.add(&webview_widget);
        offscreen.show_all(); // realize + MAP (native X11 window; keeps webkit live + input-capable)
        offscreen.move_(30000, 30000); // shove far off any monitor — user never sees it
        overlay.show_all(); // show the on-screen video area

        DOM_OFFSCREEN.with(|o| *o.borrow_mut() = Some(offscreen.clone()));
        // Record the webview so the snapshot poll can rasterize it.  The pointer
        // is the WebKitWebView* (same one set_background_color used above).
        {
            use glib::translate::ToGlibPtr;
            let p: *mut gtk::ffi::GtkWidget = webview_widget.to_glib_none().0;
            DOM_WEBVIEW.with(|w| w.set(p as *mut c_void));
            // The webview's GdkWindow is the input-forwarding target (realized by
            // offscreen.show_all() above).
            let wvwin: *mut c_void = webview_widget
                .window()
                .map(|w| {
                    let p: *mut gdk::ffi::GdkWindow = w.to_glib_none().0;
                    p as *mut c_void
                })
                .unwrap_or(std::ptr::null_mut());
            DOM_WV_WINDOW.with(|w| w.set(wvwin));
            if wvwin.is_null() {
                eprintln!("[Loom mpv] DOM-in-GL: WARN webview has no GdkWindow yet (input off)");
            }
        }

        // Damage-driven DOM capture (see DOM_DIRTY_SEQ above).  The old code
        // snapshotted unconditionally at 20 Hz; on the EGL path that runs on the
        // GTK main thread and, at 4K, each snapshot's webkit rasterize + ~33 MB
        // copy/compare stalled the render loop AND starved Tauri IPC (readDir
        // during load never returned → media stuck → start screen stuck over the
        // video).  Now: PAUSED → capture every tick (no video frames to stall, so
        // hover-glow / definition-card stay responsive); PLAYING → capture only
        // for a short BURST after a dirty signal (caption change / control fade /
        // OSD / pause edge / media load), then idle so playback + IPC run free.
        const BURST_TICKS: u32 = 10; // ~500 ms at the 50 ms tick — covers CSS fades
        let mut last_seq = DOM_DIRTY_SEQ.load(Ordering::Relaxed);
        let mut burst = BURST_TICKS; // capture the initial UI once attached
        glib::timeout_add_local(std::time::Duration::from_millis(50), move || {
            if DOM_OFFSCREEN.with(|o| o.borrow().is_none()) {
                return glib::ControlFlow::Break;
            }
            let seq = DOM_DIRTY_SEQ.load(Ordering::Relaxed);
            if seq != last_seq {
                last_seq = seq;
                burst = BURST_TICKS;
            }
            if DOM_PAUSED.load(Ordering::Relaxed) {
                request_dom_snapshot();
            } else if burst > 0 {
                burst -= 1;
                request_dom_snapshot();
            }
            glib::ControlFlow::Continue
        });
        eprintln!("[Loom mpv] DOM-in-GL: webview offscreen + get_snapshot composite active");
    } else {
        overlay.add_overlay(&webview_widget); // webview on top, transparent
        gtk_window.add(&overlay);

        overlay.show_all();
        raise_overlay_input(&webview_widget);
        match webview_widget.window().and_then(|v| v.parent()) {
            Some(_) => eprintln!(
                "[Loom mpv] input-fix: raised webview overlay window above GLArea event window"
            ),
            None => eprintln!(
                "[Loom mpv] input-fix: WARNING no overlay-child GdkWindow at show_all — input fix did not apply"
            ),
        }

        // Perf-test only: hide the transparent webview overlay so GTK composites
        // ONLY the GtkGLArea (isolates the readback vs webview-composite cost).
        // Never set in normal use.
        if std::env::var_os("LOOM_HIDE_WEBVIEW").is_some() {
            webview_widget.hide();
            eprintln!("[Loom render] TEST: webview overlay hidden — measuring video-only composite");
        }
    }

    // Tear the engine down when THIS player window closes — on the GTK main
    // thread (where RENDER_CTX lives), so a reopen starts completely fresh.
    // Without this, closing the window leaves inner=Some and RENDER_CTX
    // dangling, so the next player_attach early-returns and the new window
    // never gets its GTK surgery (the "buggy on reopen / won't load" bug).
    {
        let app_for_close = app.clone();
        window.on_window_event(move |ev| {
            if matches!(
                ev,
                tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
            ) {
                player_teardown(&app_for_close);
            }
        });
    }

    // Event pump: a background thread blocks on mpv_wait_event and re-emits
    // property changes as "mpv-prop" (the frontend contract).  It does NOT
    // destroy mpv on exit — teardown owns destruction, so it can free the
    // render context (GTK thread) BEFORE the handle goes away.
    let running = Arc::new(AtomicBool::new(true));
    let pump_running = running.clone();
    *state.inner.lock().unwrap() = Some(Engine {
        mpv: MpvHandle(mpv),
        running,
    });
    let app2 = app.clone();
    let stats_enabled = std::env::var_os("LOOM_RENDER_STATS").is_some();
    std::thread::spawn(move || {
        let mpv = mpv_addr as *mut mpv_handle;
        while pump_running.load(Ordering::SeqCst) {
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
                // Diagnostic-only: report the decoder mpv settled on (the direct
                // "hardware decode fell back to software" check).  Not part of
                // the frontend contract, so it's not re-emitted.
                if name == "hwdec-current" {
                    if stats_enabled {
                        let get = |n: &str| -> String {
                            let cn = CString::new(n).unwrap();
                            let p = unsafe { mpv_get_property_string(mpv, cn.as_ptr()) };
                            if p.is_null() {
                                return "(null)".into();
                            }
                            let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
                            unsafe { mpv_free(p as *mut c_void) };
                            s
                        };
                        eprintln!(
                            "[Loom render] decoder: hwdec-current={} · video-codec={}",
                            get("hwdec-current"),
                            get("video-codec")
                        );
                    }
                    continue;
                }
                let data = unsafe { read_prop(prop) };
                // Drive damage-driven capture: while paused the snapshot timer
                // captures continuously; a play/pause edge also bursts so the
                // OSD + control-pin change composites immediately.
                if name == "pause" {
                    if let Some(paused) = data.as_bool() {
                        DOM_PAUSED.store(paused, Ordering::Relaxed);
                        DOM_DIRTY_SEQ.fetch_add(1, Ordering::Relaxed);
                    }
                }
                let _ = app2.emit("mpv-prop", json!({ "name": name, "data": data }));
            }
        }
    });

    Ok(())
}

/// Full teardown of the render engine.  MUST run on the GTK main thread (the
/// window-close handler + the app exit/close handlers all do) — that's where
/// RENDER_CTX was created and is current-able.  Idempotent: a second call
/// (e.g. CloseRequested then Destroyed) finds inner=None and returns.
pub fn player_teardown(app: &AppHandle) {
    let state: State<RenderEngine> = app.state();
    let taken = state.inner.lock().unwrap().take();
    let Some(engine) = taken else {
        return; // already torn down
    };
    // Stop THIS generation's pump; it leaves wait_event within one 0.1s tick.
    engine.running.store(false, Ordering::SeqCst);
    // Stop + JOIN the EGL render thread (LOOM_RENDER_EGL path).  It frees the mpv
    // render context AND the EGL objects on ITSELF before returning, so once
    // join() completes the render context is gone — the required
    // free-before-terminate order holds against the deferred mpv destroy below.
    // No-op on the GLArea path (RENDER_THREAD is None there).  join() blocks the
    // GTK main thread for at most one frame (~a swap) — fine at window close.
    RENDER_THREAD.with(|r| {
        if let Some(rt) = r.borrow_mut().take() {
            rt.running.store(false, Ordering::SeqCst);
            let _ = rt.handle.join();
        }
    });
    // Free the GLArea path's render context here (GTK thread) BEFORE destroying
    // mpv — mpv requires that order, and the GL deinit needs this thread's
    // context.  No-op on the EGL path (RENDER_CTX is null there; the render
    // thread owns and already freed its own context in the join above).
    RENDER_CTX.with(|c| {
        let rctx = c.get();
        if !rctx.is_null() {
            unsafe { mpv_render_context_free(rctx) };
            c.set(ptr::null_mut());
        }
    });
    // DOM-in-GL overlay state: clearing DOM_OFFSCREEN stops the capture poll
    // (it Breaks when the slot is None); the GL texture was freed with the render
    // thread's EGL context in the join above.  (TODO reopen: the webview stays
    // parented in the offscreen window, so a second player_attach won't find it
    // in Tauri's vbox — re-home it here before shipping the EGL path as default.)
    DOM_OFFSCREEN.with(|o| *o.borrow_mut() = None);
    if let Ok(mut slot) = DOM_SHARED.lock() {
        *slot = None;
    }
    DOM_TEX.with(|t| t.set(0));
    DOM_WEBVIEW.with(|w| w.set(std::ptr::null_mut()));
    DOM_SNAP_PENDING.with(|p| p.set(false));
    // Destroy mpv shortly after, off-thread, so the pump has surely exited
    // wait_event (≤100ms) before the handle it blocks on is freed.  The render
    // context is already gone, so the required free→destroy order holds.
    let addr = engine.mpv.0 as usize;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        unsafe { mpv_terminate_destroy(addr as *mut mpv_handle) };
    });
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
    let e = guard.as_ref().ok_or("player not attached")?;
    Ok(f(e.mpv.0))
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

/// Damage signal from the frontend: the DOM overlay changed (new caption,
/// control fade, OSD, settings, media load, …).  Triggers a short capture burst
/// so the change (and any CSS fade) composites over the video, then the engine
/// idles again.  Cheap — just bumps the atomic the snapshot timer polls.  (Paused
/// interactions need no signal; the timer captures continuously while paused.)
#[tauri::command]
pub fn player_dom_dirty() {
    DOM_DIRTY_SEQ.fetch_add(1, Ordering::Relaxed);
}

/// Monotonic sequence for unique Loom songs-sub temp filenames.
static LOOM_SUB_SEQ: AtomicU64 = AtomicU64::new(0);

/// Write a Loom-generated songs .ass to a temp file, `sub-add` it (selecting
/// it), and return its new sid.  This is how song-line ANIMATION is preserved:
/// the original animated karaoke events go to libass (this track) while Loom's
/// DOM handles dialogue.  The frontend removes the previous Loom track (via the
/// generic `sub-remove` command) before adding a new one on target switch.
#[tauri::command]
pub fn player_add_loom_subs(app: AppHandle, content: String) -> Result<i64, String> {
    let seq = LOOM_SUB_SEQ.fetch_add(1, Ordering::Relaxed);
    let mut path = std::env::temp_dir();
    path.push(format!("loom-songs-{}-{}.ass", std::process::id(), seq));
    std::fs::write(&path, content.as_bytes()).map_err(|e| e.to_string())?;
    let path_str = path.to_string_lossy().into_owned();

    let state: State<RenderEngine> = app.state();
    with_mpv(&state, |mpv| {
        let args = ["sub-add", path_str.as_str(), "select"];
        let cstrings: Vec<CString> =
            args.iter().map(|s| CString::new(*s).unwrap()).collect();
        let mut argv: Vec<*const c_char> = cstrings.iter().map(|c| c.as_ptr()).collect();
        argv.push(ptr::null());
        unsafe { mpv_command(mpv, argv.as_mut_ptr()) };
        // `sub-add ... select` selects the new track — read its id back.
        let name = CString::new("sid").unwrap();
        let sptr = unsafe { mpv_get_property_string(mpv, name.as_ptr()) };
        if sptr.is_null() {
            return -1i64;
        }
        let s = unsafe { CStr::from_ptr(sptr) }.to_string_lossy().into_owned();
        unsafe { mpv_free(sptr as *mut c_void) };
        s.parse::<i64>().unwrap_or(-1)
    })
}

/// The file's track list (audio + subtitle + video), read via per-field string
/// properties to avoid parsing mpv's MPV_FORMAT_NODE union.  Returns a JSON
/// array of {type, id, lang, title, selected}.
#[tauri::command]
pub fn player_track_list(app: AppHandle) -> Result<serde_json::Value, String> {
    let state: State<RenderEngine> = app.state();
    with_mpv(&state, |mpv| {
        // Get a string property, or None; frees mpv's malloc'd buffer.
        let get = |name: &str| -> Option<String> {
            let cname = CString::new(name).ok()?;
            let ptr = unsafe { mpv_get_property_string(mpv, cname.as_ptr()) };
            if ptr.is_null() {
                return None;
            }
            let s = unsafe { CStr::from_ptr(ptr) }.to_string_lossy().into_owned();
            unsafe { mpv_free(ptr as *mut c_void) };
            Some(s)
        };
        let count: usize = get("track-list/count")
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let mut tracks = Vec::with_capacity(count);
        for i in 0..count {
            tracks.push(json!({
                "type": get(&format!("track-list/{i}/type")).unwrap_or_default(),
                "id": get(&format!("track-list/{i}/id")).and_then(|s| s.parse::<i64>().ok()),
                "lang": get(&format!("track-list/{i}/lang")),
                "title": get(&format!("track-list/{i}/title")),
                "selected": get(&format!("track-list/{i}/selected"))
                    .map(|s| s == "yes")
                    .unwrap_or(false),
            }));
        }
        json!(tracks)
    })
}

/// Set the mute state on the engine (in-session only — no persistence, audio
/// defaults ON).  The frontend calls this rather than the generic command
/// channel so there is one clear mute path.
#[tauri::command]
pub fn player_set_mute(app: AppHandle, muted: bool) -> Result<(), String> {
    let state: State<RenderEngine> = app.state();
    with_mpv(&state, |mpv| {
        let name = CString::new("mute").unwrap();
        let val = CString::new(if muted { "yes" } else { "no" }).unwrap();
        unsafe { mpv_set_property_string(mpv, name.as_ptr(), val.as_ptr()) };
    })
}

/// Audio defaults ON now (the "always start muted" directive is lifted), so
/// the player is never muted at startup.  Retained for the invoke contract.
#[tauri::command]
pub fn player_is_muted() -> bool {
    false
}

/// Superseded by the window-close teardown (`player_teardown`, run on the GTK
/// main thread).  Retained for the invoke contract but a no-op: destroying mpv
/// from a command thread here would race the render-context free (which can
/// only happen on the GTK thread) and use-after-free.  The window's close
/// event owns teardown now, so the frontend no longer needs to call this.
#[tauri::command]
pub fn player_stop(_app: AppHandle) {}
