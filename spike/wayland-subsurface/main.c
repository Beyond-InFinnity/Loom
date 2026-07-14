// Wayland subsurface spike for the Loom Player 4K present problem.
//
// WHY THIS EXISTS
// ---------------
// On X11/Mutter, the Player's video (EGL-rendered into a child GtkDrawingArea
// inside a transparent ARGB Tauri toplevel) costs ~76 ms/frame to present at
// 4K — a redirect+readback tax Mutter applies to our window regardless of
// ARGB/opaque/bypass-compositor (all measured 2026-07-14). Plain mpv, which
// owns its toplevel, does 4K@24fps on the same box. The fix hypothesis: on
// Wayland the video is handed to the compositor as its OWN surface (dmabuf),
// composited on the GPU / scanned out on a hardware plane — no readback — while
// a transparent overlay subsurface carries the DOM, blended for free.
//
// This program builds exactly that, minimally:
//   * one xdg-toplevel whose surface IS the video (EGL + libmpv render API)
//   * one transparent wl_shm overlay SUBSURFACE on top (a stand-in "caption")
// and prints split render/swap timing. The number that matters: eglSwapBuffers
// cost at 4K. If it's a few ms (not ~76), and the on-screen rate holds ~video
// fps with no drops, the Wayland architecture is proven and we port it.
//
// The overlay is a static shm buffer here (not a real webview) — the spike's
// job is the COMPOSITING PATH, not the DOM. Input/webview come in the app port.

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <stdbool.h>
#include <errno.h>
#include <unistd.h>
#include <time.h>
#include <signal.h>
#include <sys/mman.h>

#include <wayland-client.h>
#include <wayland-egl.h>
#include "xdg-shell-client-protocol.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_gl.h>

// ---- globals (a spike; one window, no context struct) ----------------------
static struct wl_display    *display;
static struct wl_registry   *registry;
static struct wl_compositor *compositor;
static struct wl_subcompositor *subcompositor;
static struct xdg_wm_base   *wm_base;
static struct wl_shm        *shm;

static struct wl_surface    *video_surface;    // == the xdg-toplevel surface
static struct xdg_surface   *xdg_surface;
static struct xdg_toplevel  *xdg_toplevel;
static struct wl_surface    *overlay_surface;  // transparent DOM stand-in
static struct wl_subsurface *overlay_subsurface;
static struct wl_egl_window *egl_window;

static EGLDisplay egl_display;
static EGLContext egl_context;
static EGLSurface egl_surface;
static EGLConfig  egl_config;

static mpv_handle         *mpv;
static mpv_render_context *mpv_ctx;

static int  win_w = 3840, win_h = 2160;  // updated by the toplevel configure
static bool configured = false;
static volatile sig_atomic_t running = 1;

static void on_sigint(int s) { (void)s; running = 0; }

static double now_ms(void) {
    struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000.0 + ts.tv_nsec / 1.0e6;
}

static void *get_proc_address(void *ctx, const char *name) {
    (void)ctx;
    return (void *)eglGetProcAddress(name);
}

// ---- wl_shm buffer for the overlay -----------------------------------------
static int create_shm_file(size_t size) {
    int fd = memfd_create("loom-overlay", MFD_CLOEXEC);
    if (fd < 0) return -1;
    if (ftruncate(fd, (off_t)size) < 0) { close(fd); return -1; }
    return fd;
}

// A recognizable, part-transparent overlay so a screenshot proves alpha
// compositing over the video: fully transparent everywhere EXCEPT a
// semi-transparent dark band across the lower third with an opaque bright
// "caption" bar inside it. ARGB8888 is straight (non-premultiplied) alpha.
static struct wl_buffer *make_overlay_buffer(int w, int h) {
    int stride = w * 4;
    size_t size = (size_t)stride * h;
    int fd = create_shm_file(size);
    if (fd < 0) { perror("shm"); return NULL; }
    uint32_t *px = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (px == MAP_FAILED) { perror("mmap"); close(fd); return NULL; }

    // DEBUG overlay: an UNMISTAKABLE opaque red band across the middle (proves
    // the subsurface composites at all), plus the semi-transparent caption band.
    int red_top  = (int)(h * 0.44), red_bot  = (int)(h * 0.56);   // opaque red
    int band_top = (int)(h * 0.78), band_bot = (int)(h * 0.92);   // 69% dark
    int cap_top  = (int)(h * 0.82), cap_bot  = (int)(h * 0.88);
    int cap_l    = (int)(w * 0.30), cap_r    = (int)(w * 0.70);
    for (int y = 0; y < h; y++) {
        for (int x = 0; x < w; x++) {
            uint32_t c = 0x00000000;                         // transparent
            if (y >= red_top && y < red_bot) c = 0xFFFF0000; // OPAQUE RED (debug)
            if (y >= band_top && y < band_bot) c = 0xB0101018;
            if (y >= cap_top && y < cap_bot && x >= cap_l && x < cap_r)
                c = 0xFFF5C542;                              // opaque amber "caption"
            px[y * w + x] = c;
        }
    }
    munmap(px, size);

    struct wl_shm_pool *pool = wl_shm_create_pool(shm, fd, (int32_t)size);
    struct wl_buffer *buf = wl_shm_pool_create_buffer(pool, 0, w, h, stride,
                                                      WL_SHM_FORMAT_ARGB8888);
    wl_shm_pool_destroy(pool);
    close(fd);
    return buf;
}

// ---- listeners -------------------------------------------------------------
static void wm_base_ping(void *d, struct xdg_wm_base *b, uint32_t serial) {
    (void)d; xdg_wm_base_pong(b, serial);
}
static const struct xdg_wm_base_listener wm_base_listener = { wm_base_ping };

static void xdg_surface_configure(void *d, struct xdg_surface *s, uint32_t serial) {
    (void)d;
    xdg_surface_ack_configure(s, serial);
    configured = true;
}
static const struct xdg_surface_listener xdg_surface_listener = { xdg_surface_configure };

static void toplevel_configure(void *d, struct xdg_toplevel *t,
                               int32_t w, int32_t h, struct wl_array *states) {
    (void)d; (void)t; (void)states;
    if (w > 0 && h > 0) { win_w = w; win_h = h; }
}
static void toplevel_close(void *d, struct xdg_toplevel *t) {
    (void)d; (void)t; running = 0;
}
// xdg-shell v4 adds configure_bounds; harmless no-op. (wm_capabilities is v5+,
// which this installed protocol build doesn't generate — don't add a 4th slot.)
static void toplevel_configure_bounds(void *d, struct xdg_toplevel *t, int32_t w, int32_t h) {
    (void)d; (void)t; (void)w; (void)h;
}
static const struct xdg_toplevel_listener toplevel_listener = {
    toplevel_configure, toplevel_close, toplevel_configure_bounds
};

// Track outputs so we can fullscreen on the 4K TV, not the laptop panel.
#define MAX_OUTPUTS 8
static struct { struct wl_output *out; int w, h; } outputs[MAX_OUTPUTS];
static int n_outputs = 0;

static void output_geometry(void *d, struct wl_output *o, int32_t x, int32_t y,
                            int32_t pw, int32_t ph, int32_t sub, const char *make,
                            const char *model, int32_t transform) {
    (void)d;(void)o;(void)x;(void)y;(void)pw;(void)ph;(void)sub;(void)make;(void)model;(void)transform;
}
static void output_mode(void *d, struct wl_output *o, uint32_t flags,
                        int32_t w, int32_t h, int32_t refresh) {
    (void)d; (void)refresh;
    if (!(flags & WL_OUTPUT_MODE_CURRENT)) return;
    for (int i = 0; i < n_outputs; i++)
        if (outputs[i].out == o) { outputs[i].w = w; outputs[i].h = h; }
}
static void output_done(void *d, struct wl_output *o) { (void)d; (void)o; }
static void output_scale(void *d, struct wl_output *o, int32_t s) { (void)d;(void)o;(void)s; }
static const struct wl_output_listener output_listener = {
    .geometry = output_geometry, .mode = output_mode,
    .done = output_done, .scale = output_scale,
    // name/description (wl_output v4) intentionally unset — we bind at v2.
};

static void registry_global(void *d, struct wl_registry *r, uint32_t name,
                            const char *iface, uint32_t version) {
    (void)d; (void)version;
    if (!strcmp(iface, wl_compositor_interface.name))
        compositor = wl_registry_bind(r, name, &wl_compositor_interface, 4);
    else if (!strcmp(iface, wl_subcompositor_interface.name))
        subcompositor = wl_registry_bind(r, name, &wl_subcompositor_interface, 1);
    else if (!strcmp(iface, xdg_wm_base_interface.name)) {
        wm_base = wl_registry_bind(r, name, &xdg_wm_base_interface, 1);
        xdg_wm_base_add_listener(wm_base, &wm_base_listener, NULL);
    } else if (!strcmp(iface, wl_shm_interface.name))
        shm = wl_registry_bind(r, name, &wl_shm_interface, 1);
    else if (!strcmp(iface, wl_output_interface.name) && n_outputs < MAX_OUTPUTS) {
        struct wl_output *o = wl_registry_bind(r, name, &wl_output_interface, 2);
        outputs[n_outputs].out = o; outputs[n_outputs].w = outputs[n_outputs].h = 0;
        wl_output_add_listener(o, &output_listener, NULL);
        n_outputs++;
    }
}
static void registry_global_remove(void *d, struct wl_registry *r, uint32_t name) {
    (void)d; (void)r; (void)name;
}
static const struct wl_registry_listener registry_listener = {
    registry_global, registry_global_remove
};

// ---- EGL -------------------------------------------------------------------
static bool egl_init(void) {
    PFNEGLGETPLATFORMDISPLAYEXTPROC get_plat =
        (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
    egl_display = get_plat
        ? get_plat(EGL_PLATFORM_WAYLAND_EXT, display, NULL)
        : eglGetDisplay((EGLNativeDisplayType)display);
    if (egl_display == EGL_NO_DISPLAY) { fprintf(stderr, "eglGetDisplay failed\n"); return false; }

    EGLint major, minor;
    if (!eglInitialize(egl_display, &major, &minor)) {
        fprintf(stderr, "eglInitialize failed\n"); return false;
    }
    fprintf(stderr, "[wl-spike] EGL %d.%d — %s\n", major, minor,
            eglQueryString(egl_display, EGL_VENDOR));
    eglBindAPI(EGL_OPENGL_API);   // desktop GL, matches the Player's context

    // Video is opaque → ALPHA_SIZE 0 (the compositor can plane-scanout it).
    const EGLint cfg_attrs[] = {
        EGL_SURFACE_TYPE, EGL_WINDOW_BIT,
        EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
        EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 0,
        EGL_NONE
    };
    EGLint n = 0;
    if (!eglChooseConfig(egl_display, cfg_attrs, &egl_config, 1, &n) || n < 1) {
        fprintf(stderr, "eglChooseConfig failed\n"); return false;
    }
    egl_context = eglCreateContext(egl_display, egl_config, EGL_NO_CONTEXT, NULL);
    if (egl_context == EGL_NO_CONTEXT) { fprintf(stderr, "eglCreateContext failed\n"); return false; }
    return true;
}

int main(int argc, char **argv) {
    const char *media = argc > 1 ? argv[1] : getenv("LOOM_OPEN");
    if (!media) { fprintf(stderr, "usage: %s <media-file>\n", argv[0]); return 2; }

    signal(SIGINT, on_sigint);
    signal(SIGTERM, on_sigint);

    display = wl_display_connect(NULL);
    if (!display) {
        fprintf(stderr, "wl_display_connect failed — is a Wayland compositor running?\n"
                        "(this needs GNOME-Wayland or `weston`; an X11 session has no wl socket)\n");
        return 1;
    }
    registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &registry_listener, NULL);
    wl_display_roundtrip(display);   // bind globals (+ create wl_output proxies)
    wl_display_roundtrip(display);   // 2nd pass: receive each output's mode (w×h)
    if (!compositor || !subcompositor || !wm_base || !shm) {
        fprintf(stderr, "missing globals: compositor=%p subcompositor=%p xdg_wm_base=%p shm=%p\n",
                (void*)compositor, (void*)subcompositor, (void*)wm_base, (void*)shm);
        return 1;
    }

    // Pick the fullscreen output: largest by area (= the 4K TV over the laptop
    // panel), overridable with LOOM_OUTPUT=<index>. NULL → compositor decides.
    struct wl_output *fs_output = NULL;
    int best_i = -1, best_area = -1;
    for (int i = 0; i < n_outputs; i++) {
        fprintf(stderr, "[wl-spike] output %d: %dx%d\n", i, outputs[i].w, outputs[i].h);
        int area = outputs[i].w * outputs[i].h;
        if (area > best_area) { best_area = area; best_i = i; }
    }
    const char *env_out = getenv("LOOM_OUTPUT");
    if (env_out) best_i = atoi(env_out);
    if (best_i >= 0 && best_i < n_outputs) {
        fs_output = outputs[best_i].out;
        fprintf(stderr, "[wl-spike] fullscreen on output %d (%dx%d)\n",
                best_i, outputs[best_i].w, outputs[best_i].h);
    }

    // Video surface == the toplevel.
    video_surface = wl_compositor_create_surface(compositor);
    xdg_surface   = xdg_wm_base_get_xdg_surface(wm_base, video_surface);
    xdg_surface_add_listener(xdg_surface, &xdg_surface_listener, NULL);
    xdg_toplevel  = xdg_surface_get_toplevel(xdg_surface);
    xdg_toplevel_add_listener(xdg_toplevel, &toplevel_listener, NULL);
    xdg_toplevel_set_title(xdg_toplevel, "Loom Wayland Spike");
    xdg_toplevel_set_app_id(xdg_toplevel, "ai.nerv-analytic.loom-spike");
    xdg_toplevel_set_fullscreen(xdg_toplevel, fs_output);   // target the 4K output
    wl_surface_commit(video_surface);

    // Wait for the first configure so we know the real output size.
    while (!configured && running) wl_display_dispatch(display);
    fprintf(stderr, "[wl-spike] configured — surface %dx%d\n", win_w, win_h);

    if (!egl_init()) return 1;
    egl_window  = wl_egl_window_create(video_surface, win_w, win_h);
    egl_surface = eglCreateWindowSurface(egl_display, egl_config,
                                         (EGLNativeWindowType)egl_window, NULL);
    if (egl_surface == EGL_NO_SURFACE) { fprintf(stderr, "eglCreateWindowSurface failed\n"); return 1; }

    // Mark the video surface fully opaque → lets the compositor skip blending
    // behind it and makes it eligible for hardware-plane scanout.
    // (DEBUG: gated off to test whether a full-window opaque region triggers a
    // fullscreen-scanout path in weston that skips the overlay subsurface.)
    if (!getenv("LOOM_NO_OPAQUE")) {
        struct wl_region *opaque = wl_compositor_create_region(compositor);
        wl_region_add(opaque, 0, 0, win_w, win_h);
        wl_surface_set_opaque_region(video_surface, opaque);
        wl_region_destroy(opaque);
    }

    // Transparent DOM-overlay subsurface on top of the video.
    overlay_surface   = wl_compositor_create_surface(compositor);
    overlay_subsurface = wl_subcompositor_get_subsurface(subcompositor, overlay_surface, video_surface);
    wl_subsurface_set_position(overlay_subsurface, 0, 0);
    wl_subsurface_place_above(overlay_subsurface, video_surface);
    // Leave the subsurface in SYNC mode (the default): its committed state is
    // cached and applied ATOMICALLY on the parent's next commit — which is the
    // first eglSwapBuffers, i.e. also when the parent maps. So buffer + position
    // + stacking all latch into the parent's first frame; no map-ordering race.
    // (The app switches to desync after startup to update the DOM independently.)
    struct wl_buffer *ov = make_overlay_buffer(win_w, win_h);
    fprintf(stderr, "[wl-spike] overlay buffer=%p, subsurface=%p (opaque region %s)\n",
            (void *)ov, (void *)overlay_subsurface,
            getenv("LOOM_NO_OPAQUE") ? "OFF" : "on");
    if (ov) {
        wl_surface_attach(overlay_surface, ov, 0, 0);
        wl_surface_damage_buffer(overlay_surface, 0, 0, win_w, win_h);
        wl_surface_commit(overlay_surface);   // cached until the parent commits
    }

    // ---- mpv (render API) --------------------------------------------------
    mpv = mpv_create();
    if (!mpv) { fprintf(stderr, "mpv_create failed\n"); return 1; }
    mpv_set_option_string(mpv, "hwdec", "vaapi");
    if (getenv("LOOM_TEST_SILENT")) mpv_set_option_string(mpv, "ao", "null");
    if (getenv("LOOM_MPV_LOG")) {
        mpv_set_option_string(mpv, "terminal", "yes");
        mpv_set_option_string(mpv, "msg-level", "all=v");
    }
    if (mpv_initialize(mpv) < 0) { fprintf(stderr, "mpv_initialize failed\n"); return 1; }

    eglMakeCurrent(egl_display, egl_surface, egl_surface, egl_context);
    eglSwapInterval(egl_display, 1);   // throttled by the Wayland frame callback

    mpv_opengl_init_params gl_init = { .get_proc_address = get_proc_address,
                                       .get_proc_address_ctx = NULL };
    mpv_render_param cparams[] = {
        { MPV_RENDER_PARAM_API_TYPE, (void *)MPV_RENDER_API_TYPE_OPENGL },
        { MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init },
        { MPV_RENDER_PARAM_WL_DISPLAY, display },   // VAAPI dmabuf interop on Wayland
        { MPV_RENDER_PARAM_INVALID, NULL }
    };
    if (mpv_render_context_create(&mpv_ctx, mpv, cparams) < 0) {
        fprintf(stderr, "mpv_render_context_create failed\n"); return 1;
    }

    const char *cmd[] = { "loadfile", media, NULL };
    mpv_command(mpv, cmd);
    fprintf(stderr, "[wl-spike] loading: %s\n", media);

    // ---- render loop -------------------------------------------------------
    double t_stat = now_ms();
    int frames = 0;
    double r_sum = 0, s_sum = 0, s_max = 0;
    bool logged_hwdec = false;

    while (running) {
        // Drain mpv events (needed so the core makes progress / we see SHUTDOWN).
        while (1) {
            mpv_event *ev = mpv_wait_event(mpv, 0);
            if (ev->event_id == MPV_EVENT_NONE) break;
            if (ev->event_id == MPV_EVENT_SHUTDOWN) running = 0;
        }
        // Process any pending Wayland events (configure/ping/close).
        wl_display_dispatch_pending(display);

        mpv_opengl_fbo fbo = { .fbo = 0, .w = win_w, .h = win_h, .internal_format = 0 };
        int flip = 1;
        mpv_render_param rparams[] = {
            { MPV_RENDER_PARAM_OPENGL_FBO, &fbo },
            { MPV_RENDER_PARAM_FLIP_Y, &flip },
            { MPV_RENDER_PARAM_INVALID, NULL }
        };
        double t0 = now_ms();
        mpv_render_context_render(mpv_ctx, rparams);   // paces to target time
        double t1 = now_ms();
        eglSwapBuffers(egl_display, egl_surface);       // attach+commit video surface
        double t2 = now_ms();
        mpv_render_context_report_swap(mpv_ctx);
        wl_display_flush(display);

        frames++;
        r_sum += (t1 - t0);
        s_sum += (t2 - t1);
        if ((t2 - t1) > s_max) s_max = (t2 - t1);

        if (!logged_hwdec) {
            char *hw = mpv_get_property_string(mpv, "hwdec-current");
            if (hw && hw[0] && strcmp(hw, "no")) {
                fprintf(stderr, "[wl-spike] hwdec-current=%s\n", hw);
                logged_hwdec = true;
            }
            if (hw) mpv_free(hw);
        }
        double elapsed = now_ms() - t_stat;
        if (elapsed >= 1000.0) {
            double drops = 0; mpv_get_property(mpv, "frame-drop-count", MPV_FORMAT_DOUBLE, &drops);
            fprintf(stderr,
                "[wl-spike] %.1f fps · render %.2fms · SWAP %.2fms (max %.2f) · drops %.0f · fbo %dx%d\n",
                frames * 1000.0 / elapsed, r_sum / frames, s_sum / frames, s_max, drops, win_w, win_h);
            t_stat = now_ms(); frames = 0; r_sum = s_sum = s_max = 0;
        }
    }

    // ---- teardown ----------------------------------------------------------
    if (mpv_ctx) mpv_render_context_free(mpv_ctx);
    if (mpv) mpv_terminate_destroy(mpv);
    if (egl_surface != EGL_NO_SURFACE) eglDestroySurface(egl_display, egl_surface);
    if (egl_window) wl_egl_window_destroy(egl_window);
    if (egl_context != EGL_NO_CONTEXT) eglDestroyContext(egl_display, egl_context);
    if (egl_display) eglTerminate(egl_display);
    wl_display_disconnect(display);
    fprintf(stderr, "[wl-spike] clean exit\n");
    return 0;
}
