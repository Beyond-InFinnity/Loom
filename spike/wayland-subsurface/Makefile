# Wayland subsurface spike — proves that a single Wayland toplevel with a
# video surface (zero-copy libmpv/VAAPI via EGL) + a transparent DOM-overlay
# subsurface presents 4K cheaply, unlike the X11 ARGB-redirect path (~76 ms/frame).
#
# Build:  make            (links the vendored modern libmpv by default)
# Run:    ./wl-spike <media.mkv>     (needs a running Wayland compositor —
#         GNOME-Wayland for the real perf proof, or `weston` for a nested check)

MPV_PREFIX ?= /home/connor/Documents/projects/Loom/vendor/mpv-prefix
WL_PROTO   := /usr/share/wayland-protocols/stable/xdg-shell/xdg-shell.xml

PKGS   := wayland-client wayland-egl egl gl
CFLAGS := -O2 -g -Wall -Wextra $(shell pkg-config --cflags $(PKGS)) -I$(MPV_PREFIX)/include -I.
LIBS   := $(shell pkg-config --libs $(PKGS)) \
          -L$(MPV_PREFIX)/lib/x86_64-linux-gnu -Wl,-rpath,$(MPV_PREFIX)/lib/x86_64-linux-gnu \
          -lmpv -lm

all: wl-spike

# Generated xdg-shell client glue (wayland-scanner ships with libwayland-dev)
xdg-shell-client-protocol.h:
	wayland-scanner client-header $(WL_PROTO) $@
xdg-shell-protocol.c:
	wayland-scanner private-code $(WL_PROTO) $@

wl-spike: main.c xdg-shell-protocol.c xdg-shell-client-protocol.h
	$(CC) $(CFLAGS) -o $@ main.c xdg-shell-protocol.c $(LIBS)

clean:
	rm -f wl-spike xdg-shell-client-protocol.h xdg-shell-protocol.c

.PHONY: all clean
