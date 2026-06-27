import ReactDOM from "react-dom/client";

import { ISO_SOURCE, logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  IQIYI_PLAYER_ROOT,
  ensureAnchorPositioned,
} from "@/lib/overlay/iqiyi-player-anchor";

// ISOLATED-world content script for iQIYI international (iq.com) watch pages.
//
// The iQIYI counterpart to entrypoints/netflix.content.tsx.  Identical overlay
// stack — LoomApp (dormant pill → CaptionStreamProvider + CaptionOverlay)
// inside a WXT shadow root — anchored to iQIYI's player root.  Everything
// below LoomApp is platform-agnostic; the only iQIYI-specific bits are the
// anchor selector + ensureAnchorPositioned.
//
// The MAIN-world /dash hook (entrypoints/iqiyi-main.content.ts) feeds
// discover.ts via the same loom-main/tracklist postMessage the ISO side
// already consumes, so discovery + fetch + the overlay all reuse the shared
// pipeline unchanged.
//
// ⚠️ LIVE-VERIFY: the player is inline (not iframed) per recon, but the exact
// anchor selector is unconfirmed — see lib/overlay/iqiyi-player-anchor.ts.
//
// See content.tsx's header for the `inheritStyles: true` rationale and the
// translateZ-promotion perf note — both apply identically here.

const ANCHOR_SELECTOR = IQIYI_PLAYER_ROOT;
const HOST_STYLE_ID = "loom-host-positioning";

/** iQIYI play id for a /play/<id> URL, else null. */
function watchIdOf(url: string | URL): string | null {
  try {
    const m = new URL(url).pathname.match(/\/play\/([^/?#]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export default defineContentScript({
  // ALL of iq.com (no-refresh fix): iq.com routes browse → /play and episode →
  // episode via history.pushState with no document reload.  We load on the
  // first page; WXT's autoMount owns the overlay lifecycle, and on each /play
  // change we ping MAIN to re-emit its latest tracklist (iQIYI also re-fetches
  // /dash on its own, so this is a belt-and-braces nudge for the late-mount
  // case).
  matches: ["*://*.iq.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    injectHostPositioningStyle();

    // WXT autoMount owns the overlay lifecycle: mounts when the player
    // appears, unmounts when removed, RE-mounts when iQIYI rebuilds the player
    // subtree on navigation (a one-shot mount() would orphan the host).
    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: ANCHOR_SELECTOR,
      inheritStyles: true,
      onMount: (uiContainer) => {
        const anchor = document.querySelector<HTMLElement>(ANCHOR_SELECTOR);
        if (anchor) ensureAnchorPositioned(anchor);
        uiContainer.style.position = "absolute";
        uiContainer.style.inset = "0";
        const root = ReactDOM.createRoot(uiContainer);
        root.render(<LoomApp />);
        logDev("[Loom] iQIYI overlay mounted inside", ANCHOR_SELECTOR);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom] iQIYI overlay unmounted");
      },
    });
    ui.autoMount();

    // On episode change, nudge MAIN to re-emit its latest tracklist for the
    // late-mount case.  iQIYI fires a fresh /dash per episode anyway.
    let currentWatchId = watchIdOf(location.href);
    ctx.addEventListener(window, "wxt:locationchange", ({ newUrl }) => {
      const newId = watchIdOf(newUrl);
      if (newId === currentWatchId) return;
      currentWatchId = newId;
      if (newId) {
        window.postMessage(
          { source: ISO_SOURCE, type: "request-tracklist" },
          location.origin,
        );
      }
    });
  },
});

/** Inject (once) the document-level stylesheet that positions the WXT shadow
    host.  Identical rule + perf rationale as content.tsx's. */
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
