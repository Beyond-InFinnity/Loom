import ReactDOM from "react-dom/client";

import { ISO_SOURCE, logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  NETFLIX_PLAYER_ROOT,
  ensureAnchorPositioned,
} from "@/lib/overlay/netflix-player-anchor";
import { installCaptionPauseProbe } from "@/lib/overlay/caption-probe";

// ISOLATED-world content script for Netflix watch pages (5h-3).
//
// The Netflix counterpart to entrypoints/content.tsx.  Identical overlay
// stack — LoomApp (dormant pill → CaptionStreamProvider + CaptionOverlay)
// inside a WXT shadow root — anchored to Netflix's player root
// (`div[data-uia="video-canvas"]`) instead of YouTube's `#movie_player`.
// Everything below LoomApp is platform-agnostic; the only Netflix-specific
// bits are the anchor selector + ensureAnchorPositioned (the canvas can be
// `position: static`, which would let our absolute host escape).
//
// The MAIN-world manifest hook (entrypoints/netflix-main.content.ts) feeds
// discover.ts via the same loom-main/tracklist postMessage the ISO side
// already consumes, so discovery + fetch + the overlay all reuse the
// YouTube pipeline unchanged.
//
// See content.tsx's header for the `inheritStyles: true` rationale (it
// defeats WXT's :host{all:initial!important} reset) and the
// translateZ-promotion perf note — both apply identically here.

const ANCHOR_SELECTOR = NETFLIX_PLAYER_ROOT;
const HOST_STYLE_ID = "loom-host-positioning";

/** Numeric Netflix title id for a /watch/<id> URL, else null. */
function watchIdOf(url: string | URL): string | null {
  try {
    const m = new URL(url).pathname.match(/\/watch\/(\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export default defineContentScript({
  // ALL of netflix.com, not just /watch/* (no-refresh fix): Netflix routes
  // home→title and autoplay/advance episode→episode via history.pushState
  // with NO document reload, so a /watch/-only content script never injects
  // on those navigations — Loom was absent until F5.  We load on the first
  // Netflix page; WXT's autoMount then owns the overlay lifecycle and the
  // wxt:locationchange handler tells MAIN which episode is now playing.
  matches: ["*://*.netflix.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    injectHostPositioningStyle();
    // Passive caption-position probe (dev only) — pause / Ctrl+Shift+L to
    // log where Netflix renders each cue (top vs bottom), keyed by
    // currentTime.  Independent of activation.  See caption-probe.ts.
    installCaptionPauseProbe(ctx, () =>
      document.querySelector<HTMLElement>(NETFLIX_PLAYER_ROOT),
    );

    // WXT autoMount owns the overlay lifecycle.  It watches ANCHOR_SELECTOR
    // and mounts when the Netflix player appears, unmounts when it's removed,
    // and — crucially — RE-mounts when Netflix tears down + rebuilds the
    // player subtree.  That rebuild is exactly what a MANUAL "next episode"
    // does (autoplay reuses the player); a one-shot mount() left our shadow
    // host orphaned in the detached old subtree → pill + subs invisible.
    // Cost is a single MutationObserver watching for one selector — far below
    // the per-frame / paint costs the perf tripwires actually guard against.
    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: ANCHOR_SELECTOR,
      inheritStyles: true,
      onMount: (uiContainer) => {
        // The player root can be position:static; promote it so our absolute
        // host anchors to it instead of escaping to a positioned ancestor.
        const anchor = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
        if (anchor) ensureAnchorPositioned(anchor);
        uiContainer.style.position = "absolute";
        uiContainer.style.inset = "0";
        const root = ReactDOM.createRoot(uiContainer);
        root.render(<LoomApp />);
        logDev(
          "[Loom NFLX ISO] overlay MOUNTED inside",
          ANCHOR_SELECTOR,
          "— href =",
          location.href,
        );
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom NFLX ISO] overlay UNMOUNTED — href =", location.href);
      },
    });
    ui.autoMount();

    // Episode-swap signal for MAIN.  Netflix MSE playback fires NO <video>
    // loadstart/emptied on episode change (the element is reused + fed via
    // SourceBuffer), so MAIN's media-swap watcher can't see swaps — the URL
    // change is the reliable signal.  Tell MAIN which title is now playing so
    // it adopts that manifest; the overlay itself is handled by autoMount.
    let currentWatchId = watchIdOf(location.href);
    logDev(
      "[Loom NFLX ISO] script loaded — href =",
      location.href,
      "watchId =",
      currentWatchId ?? "(none)",
    );
    ctx.addEventListener(window, "wxt:locationchange", ({ newUrl }) => {
      const newId = watchIdOf(newUrl);
      // Log EVERY location change — including same-id ones we don't
      // forward — so a console capture shows whether Chrome's SPA nav
      // fired this at all, and what we decided.
      logDev(
        "[Loom NFLX ISO] locationchange →",
        String(newUrl),
        "| watchId",
        currentWatchId ?? "(none)",
        "→",
        newId ?? "(none)",
        newId === currentWatchId
          ? "(same id — not posting)"
          : newId
            ? "(posting watch-changed)"
            : "(posting watch-left)",
      );
      if (newId === currentWatchId) return;
      currentWatchId = newId;
      if (newId) {
        window.postMessage(
          { source: ISO_SOURCE, type: "watch-changed", videoId: newId },
          location.origin,
        );
      } else {
        // Left /watch/ (back button → browse / detail page).  Tell MAIN so
        // it clears the committed title + cached tracklist — a stale
        // `active` here is what let the previous episode's subs get served
        // to the NEXT title (the back-nav stale-subs bug).
        window.postMessage(
          { source: ISO_SOURCE, type: "watch-left" },
          location.origin,
        );
      }
    });
  },
});

/** Inject (once) the document-level stylesheet that positions the WXT
    shadow host.  Identical rule + perf rationale as content.tsx's — the
    translateZ promotion isolates our shadow tree onto its own compositor
    layer so Netflix's player repaints don't cascade through it. */
function injectHostPositioningStyle(): void {
  if (document.getElementById(HOST_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = HOST_STYLE_ID;
  style.textContent = `
loom-overlay-root {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  display: block !important;
  pointer-events: none !important;
  z-index: 2147483647 !important;
  transform: translateZ(0) !important;
  will-change: transform !important;
  contain: layout paint style !important;
}
`;
  (document.head ?? document.documentElement).appendChild(style);
}
