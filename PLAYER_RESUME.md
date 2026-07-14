# Loom Player — Session-Restart Prep (Wayland 4K present proof)

> Everything needed to log out of X11, log into GNOME-Wayland, and pick this work
> back up with zero loss. Delete this file once the Wayland decision is made.

---

## TL;DR

1. (Optional) ask me to make a WIP checkpoint commit first — not required (see §5).
2. Log out → login screen **gear icon → "GNOME"** (NOT "GNOME on Xorg") → log in.
3. Open a terminal: `cd ~/Documents/projects/Loom && claude --resume 722351d2-3fbb-4cc1-ae39-3e046fee2910`
4. Tell me you're back on Wayland — I'll build + run the spike on the TV and read one number (`SWAP`).

---

## §1 — Resuming this Claude conversation

**Nothing about the conversation is lost by logging out.** The full transcript is a
58 MB file in your home directory (survives logout/reboot/tmp-clear):

```
~/.claude/projects/-home-connor-Documents-projects-Loom/722351d2-3fbb-4cc1-ae39-3e046fee2910.jsonl
```

Resume it with:

```
cd ~/Documents/projects/Loom
claude --resume 722351d2-3fbb-4cc1-ae39-3e046fee2910
```

I come back with full context. **What logout kills (all trivially restartable, no state):**
a background Vite dev server (only the Tauri app needs it — the Wayland spike does NOT),
the background-session daemon + its `/tmp/cc-daemon-*` sockets (recreated on resume), and
any transient screenshots in `~/.claude/jobs/722351d2/tmp/`.

---

## §2 — Switching to GNOME-Wayland (and back)

- **To Wayland:** log out → at the GDM login screen, click your name, then the **gear
  icon** (bottom-right) → choose **"GNOME"** → log in. ("GNOME" = Wayland; "GNOME on
  Xorg" = the X11 session you're on now.)
- **Verify after login** (I'll run this first thing): `echo $XDG_SESSION_TYPE` → must say
  `wayland`, and `echo $WAYLAND_DISPLAY` → typically `wayland-0`.
- **To go back to X11:** log out → gear icon → "GNOME on Xorg". The shipped Player and all
  prior desktop work are X11 (GtkGLArea path), so we return here after the experiment.

**Why the switch is needed:** X11/Mutter's ~76 ms/frame present of our window is
unfixable (proven: ARGB / opaque / `_NET_WM_BYPASS_COMPOSITOR` / full-monitor coverage
all ~76 ms; not a vblank wait). Wayland composites per-surface with no readback — the fix.

---

## §3 — Running the perf proof

The spike is **already built and mechanically validated** (under nested weston: connects,
plays 4K Godzilla zero-copy VAAPI, 0 drops). On Wayland it also gets the real present cost.

```
cd ~/Documents/projects/Loom/spike/wayland-subsurface
make                                  # rebuilds if needed (needs the vendored libmpv)
LOOM_TEST_SILENT=1 ./wl-spike \
  "/media/connor/Lexar/Media/Sources/Movie/Godzilla.Minus.One.2023.UHD.Bluray.2160p.TrueHD.7.1.Atmos.DV.HEVC.REMUX-GojiraDidNothingWrong.mkv"
```

- It **auto-fullscreens on the largest output** (the 4K TV, not the laptop panel). Force a
  specific one with `LOOM_OUTPUT=<index>` (it logs `output N: WxH` at startup).
- Watch the once-per-second stats line — the figure that decides everything is **`SWAP`**:

```
[wl-spike] N fps · render X.XXms · SWAP Y.YYms (max Z.ZZ) · drops 0 · fbo 3840x2160
```

**Wayland gotchas already handled / to know:**
- `wl_display_connect(NULL)` uses `$WAYLAND_DISPLAY` (or `wayland-0`) — works out of the box.
- **Screenshots differ on Wayland:** `x11grab`/`grim` do NOT work on GNOME (no wlr protocol).
  The perf number is in **stderr, so no screenshot is needed for the result.** For the
  overlay *visual* (secondary), the GNOME Shell D-Bus method captures the full screen:
  `gdbus call --session --dest org.gnome.Shell.Screenshot --object-path /org/gnome/Shell/Screenshot --method org.gnome.Shell.Screenshot.Screenshot true false /tmp/shot.png`
- The spike keeps a **debug opaque-red overlay band** (plus a semi-transparent caption band)
  for an unambiguous "did the subsurface composite" signal — strip to caption-only after it passes.

---

## §4 — Decision criteria (what the number means)

- **`SWAP` ≈ 1–5 ms and the overlay band is visible over the video → THESIS PROVEN.**
  Port the Wayland present path into `apps/desktop/src-tauri/src/mpv_render.rs` as a second
  render backend (the X11/EGL path stays; select per session type).
- **`SWAP` still ≈ 70–80 ms → thesis wrong.** We rethink (capped-resolution present, or
  accept the physics) — but we'll have spent almost nothing finding out.

---

## §5 — State of the code (uncommitted, but safe)

**A logout never touches the git working tree** — all of this stays on disk exactly as is.
Uncommitted right now on branch `monorepo-restructure`:

- `apps/desktop/src-tauri/src/mpv_render.rs` — this session's off-main-thread EGL render
  loop + the gated `LOOM_SWAP_INTERVAL` diagnostic knob (default 1 = vsync).
- `apps/desktop/src-tauri/src/lib.rs` — `XInitThreads()` for the render thread.
- `apps/desktop/src-tauri/tauri.conf.json` — reverted to `transparent: true` (the opaque
  experiment was reverted; no net change from before this session).
- `spike/wayland-subsurface/` — NEW: the Wayland spike (`main.c`, `Makefile`, `.gitignore`).
- `PLAYER_RESUME.md` — this file.
- Plus the larger in-flight Player work from prior sessions (mpv_ffi, build.rs, main.tsx,
  deleted dual-window `mpv.rs`/`video_windows.rs`, etc.).

If you'd like a clean checkpoint before restarting, ask me to make a WIP commit — otherwise
it's all safe as-is.

**Full technical record:** memory `reference_player_4k_render_bottleneck` (decode is NOT the
bottleneck — 72 fps software; the wall is the X11 present; Wayland is the fix).
