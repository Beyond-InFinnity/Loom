#!/usr/bin/env python3
"""B-spike probe: can we capture a WebKitGTK view's rendered pixels (with
transparency) from an OFFSCREEN window into a readable buffer?

This is the make-or-break question for the DOM-in-GL single-window path:
if the offscreen cairo surface holds the DOM (text + ruby) AND preserves the
transparent background, then uploading it to a GL texture on damage and
blending it over the zero-copy EGL video is straightforward.

Tests the accelerated-compositing knob both ways (WEBKIT_DISABLE_COMPOSITING_MODE).
"""
import os
import sys
import time

import cairo
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.0")
from gi.repository import Gtk, WebKit2, Gdk, GLib

W, H = 1280, 720
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/webview_capture.png"

HTML = """
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;}
  .wrap{position:absolute;bottom:10%;width:100%;text-align:center;}
  .cap{display:inline-block;background:rgba(0,0,0,0.55);color:#fff;
       font-size:44px;padding:8px 20px;border-radius:8px;
       font-family:sans-serif;}
  ruby rt{font-size:22px;color:#88ffee;}
  .glow{color:#ffd24a;text-shadow:0 0 12px #ffd24a;}
</style></head><body>
  <div class="wrap"><span class="cap">
    <ruby>東京<rt>とうきょう</rt></ruby>へ<span class="glow">行</span>く
  </span></div>
</body></html>
"""


def to_image(surface):
    """Copy a (possibly Xlib/server-side) surface into a client ARGB32 image
    so we can read its pixels — mirrors the on-damage CPU readback path B needs."""
    img = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    cr = cairo.Context(img)
    cr.set_operator(cairo.OPERATOR_SOURCE)  # copy incl. alpha, no blend
    cr.set_source_surface(surface, 0, 0)
    cr.paint()
    img.flush()
    return img


def analyze(surface):
    """Return (w, h, alpha_min, alpha_max, frac_opaque, frac_transparent)."""
    w = surface.get_width()
    h = surface.get_height()
    stride = surface.get_stride()
    data = surface.get_data()  # BGRA premultiplied, cairo ARGB32
    a_min, a_max = 255, 0
    opaque = 0
    transp = 0
    total = 0
    # Sample every 4th pixel for speed
    for y in range(0, h, 4):
        row = y * stride
        for x in range(0, w, 4):
            a = data[row + x * 4 + 3]  # alpha byte
            if a < a_min:
                a_min = a
            if a > a_max:
                a_max = a
            if a >= 250:
                opaque += 1
            if a <= 5:
                transp += 1
            total += 1
    return w, h, a_min, a_max, opaque / total, transp / total


def main():
    mode = os.environ.get("WEBKIT_DISABLE_COMPOSITING_MODE", "<unset>")
    print(f"[probe] WEBKIT_DISABLE_COMPOSITING_MODE={mode}")

    win = Gtk.OffscreenWindow()
    win.set_default_size(W, H)
    win.set_app_paintable(True)
    rgba = win.get_screen().get_rgba_visual()
    if rgba is not None:
        win.set_visual(rgba)
        print("[probe] set RGBA visual on offscreen window (alpha-capable)")
    else:
        print("[probe] NO RGBA visual available — alpha may be lost")

    wv = WebKit2.WebView()
    wv.set_background_color(Gdk.RGBA(0, 0, 0, 0))  # transparent webview bg
    wv.set_size_request(W, H)
    win.add(wv)
    win.show_all()

    captured = {"done": False}

    def do_capture(label):
        t0 = time.perf_counter()
        surf = win.get_surface()
        if surf is None:
            print(f"[{label}] get_surface() -> None (no offscreen surface!)")
            captured["done"] = True
            Gtk.main_quit()
            return
        dt_get = (time.perf_counter() - t0) * 1000
        t1 = time.perf_counter()
        img = to_image(surf)  # the on-damage CPU readback B would do
        dt_copy = (time.perf_counter() - t1) * 1000
        w, h, amin, amax, fo, ft = analyze(img)
        img.write_to_png(OUT)
        print(f"[{label}] surface {w}x{h}  get_surface={dt_get:.1f}ms  copy_to_image={dt_copy:.1f}ms")
        print(f"[{label}] alpha min={amin} max={amax}  "
              f"opaque={fo*100:.1f}%  transparent={ft*100:.1f}%")
        print(f"[{label}] verdict: "
              + ("CAPTURED DOM + kept transparency"
                 if (amax > 200 and ft > 0.30 and amin < 50)
                 else "content present but NO transparency"
                 if amax > 200 and ft < 0.05
                 else "BLANK / no DOM captured"))
        print(f"[{label}] png -> {OUT}")
        captured["done"] = True
        Gtk.main_quit()

    def on_load(view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            # webkit paints async after load; give it a beat then capture.
            def after():
                win.queue_draw()
                # let the offscreen re-render
                GLib.timeout_add(250, lambda: (do_capture("capture"), False)[1])
                return False
            GLib.timeout_add(250, after)

    wv.connect("load-changed", on_load)
    wv.load_html(HTML, "file:///")

    # safety timeout
    GLib.timeout_add(6000, lambda: (Gtk.main_quit(), False)[1] if not captured["done"] else False)
    Gtk.main()


if __name__ == "__main__":
    main()
