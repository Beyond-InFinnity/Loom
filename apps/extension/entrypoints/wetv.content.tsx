import ReactDOM from "react-dom/client";

import { ISO_SOURCE, logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  WETV_PLAYER_ROOT,
  ensureAnchorPositioned,
} from "@/lib/overlay/wetv-player-anchor";

// ISOLATED-world content script for WeTV (wetv.vip) play pages.
//
// The WeTV counterpart to entrypoints/netflix.content.tsx.  Identical overlay
// stack — LoomApp inside a WXT shadow root — anchored to WeTV's player root.
// The MAIN-world getvinfo hook (entrypoints/wetv-main.content.ts) feeds
// discover.ts via the same loom-main/tracklist postMessage the ISO side
// already consumes.
//
// ⚠️ LIVE-VERIFY: player is inline (no iframe) per recon, but the anchor
// selector + the runtime-injected <video> are unconfirmed — see
// lib/overlay/wetv-player-anchor.ts.  WeTV play URL:
// /[locale]/play/<cid>/<vid>-<slug>.
//
// See content.tsx's header for the inheritStyles + translateZ rationale.

const ANCHOR_SELECTOR = WETV_PLAYER_ROOT;
const HOST_STYLE_ID = "loom-host-positioning";

/** WeTV play id (the <vid>) for a /play/<cid>/<vid>(-slug) URL, else null. */
function watchIdOf(url: string | URL): string | null {
  try {
    const m = new URL(url).pathname.match(/\/play\/[^/]+\/([^/?#-]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export default defineContentScript({
  matches: ["*://*.wetv.vip/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    injectHostPositioningStyle();

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
        logDev("[Loom] WeTV overlay mounted inside", ANCHOR_SELECTOR);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom] WeTV overlay unmounted");
      },
    });
    // Manual, STATE-BASED mount management (replaces ui.autoMount).
    // WeTV's player REBUILDS its subtree on resume — it removes and re-adds
    // #player-wrapper inside-out within one tick.  WXT's autoMount is
    // edge-triggered (wait-for-removed, then re-arm wait-for-added), so the
    // same-tick re-add slips between the two waits and it never remounts,
    // leaving the overlay (pill + subs) permanently gone even though the
    // anchor is back.  Instead we reconcile to the ACTUAL DOM state on every
    // mutation (rAF-throttled) plus a 1s backstop: this is race-proof and
    // idempotent.  ui.mount/remove aren't double-call-guarded, so we always
    // remove() a stale mount before re-mounting (avoids a duplicate React root).
    let mounted = false;
    const ensureMount = () => {
      const anchor = document.querySelector(ANCHOR_SELECTOR);
      if (!anchor) {
        if (mounted) {
          ui.remove();
          mounted = false;
        }
        return;
      }
      const ok =
        mounted && ui.shadowHost.isConnected && anchor.contains(ui.shadowHost);
      if (ok) return;
      if (mounted) {
        try {
          ui.remove();
        } catch {
          /* tolerate a half-torn-down state */
        }
        mounted = false;
      }
      ui.mount();
      mounted = true;
    };

    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        ensureMount();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
    const backstop = setInterval(ensureMount, 1000); // catch any missed mutation
    ensureMount();
    ctx.onInvalidated(() => {
      observer.disconnect();
      clearInterval(backstop);
      if (raf) cancelAnimationFrame(raf);
    });

    // On episode change, nudge MAIN to re-emit its latest tracklist for the
    // late-mount case.  WeTV fires a fresh getvinfo per episode anyway.
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
