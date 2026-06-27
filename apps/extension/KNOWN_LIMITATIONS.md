# Known limitations

## Picture-in-Picture (PiP) shows no Loom subtitles

When a video is popped out into the **browser's native Picture-in-Picture
window** (Firefox PiP, Chrome PiP, or OS-level PiP), Loom's subtitle overlay
does **not** appear. Windowed and fullscreen playback are fully supported on
all platforms; only native PiP is affected.

**Why (inherent, not a bug):** the PiP window is a privileged browser surface
that displays only the decoded video frame — the browser does not project web
page DOM into it. Loom renders its dual-subtitle overlay as page DOM (a shadow
root over the player), so there is no mechanism for it — or any extension — to
draw into the PiP window. This affects every DOM-overlay dual-subtitle tool
(Language Reactor, Migaku, etc.).

A site's *own* captions can still appear in PiP because the browser has two
built-in caption pathways for PiP — native HTML5 `<track>`/`TextTrack` cues on
the `<video>`, and Mozilla/Chrome's per-site PiP wrapper scripts shipped inside
the browser. Loom is neither.

**Possible future enhancement (not planned):** Loom could inject its combined
text as a native `TextTrack` so the browser's PiP caption feature displays it —
but that collapses to a single plain caption line, losing per-character
annotation (furigana/ruby), the romanization line, and the dual-layer styling
that are Loom's whole point. Only marginally useful for romanization-only
languages; filed as nice-to-have, not scheduled.
