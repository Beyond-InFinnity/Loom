import ReactDOM from "react-dom/client";

import { logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  PRIME_PLAYER_ROOT,
  ensureAnchorPositioned,
} from "@/lib/overlay/prime-player-anchor";

// ISOLATED-world content script for Amazon Prime Video pages.
//
// The Prime counterpart to entrypoints/netflix.content.tsx.  Identical
// overlay stack — LoomApp (dormant pill → CaptionStreamProvider +
// CaptionOverlay) in a WXT shadow root — anchored to Prime's player root
// instead of Netflix's `div[data-uia="player"]`.  The MAIN-world hook
// (entrypoints/prime-main.content.ts) feeds discover.ts via the same
// loom-main/tracklist postMessage the ISO side already consumes.
//
// ⚠️ PRIME_PLAYER_ROOT is a best-guess selector (see prime-player-anchor.ts)
// — first-run probe below logs the player subtree so the real anchor is a
// quick live confirmation.  See content.tsx for the inheritStyles + host
// translateZ perf rationale (applies identically).

const ANCHOR_SELECTOR = PRIME_PLAYER_ROOT;
const HOST_STYLE_ID = "loom-host-positioning";

export default defineContentScript({
  // All of primevideo.com — the player is embedded on the detail page and
  // Prime is an SPA (navigating title→title is history.pushState, no
  // reload), so load site-wide; WXT autoMount owns the overlay lifecycle
  // and re-mounts if Prime rebuilds the player subtree (next episode).
  matches: ["*://*.primevideo.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    injectHostPositioningStyle();
    probePlayerDomOnce();

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
        logDev("[Loom] Prime overlay mounted inside", ANCHOR_SELECTOR);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom] Prime overlay unmounted");
      },
    });
    ui.autoMount();
  },
});

/** One-shot live-recon aid: when a Prime player <video> appears, log its
    ancestor chain + the classes on each level, so the real anchor / video /
    native-caption selectors can be confirmed from the dev console in one
    session (dev builds only).  Remove once selectors are verified. */
function probePlayerDomOnce(): void {
  let done = false;
  const obs = new MutationObserver(() => {
    if (done) return;
    const video = document.querySelector("video");
    if (!video) return;
    done = true;
    obs.disconnect();
    const chain: string[] = [];
    let el: HTMLElement | null = video as HTMLElement;
    for (let i = 0; el && i < 12; i++) {
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
      chain.push(`${el.tagName.toLowerCase()}${cls}`);
      el = el.parentElement;
    }
    logDev("[Loom PRIME probe] <video> ancestor chain:", chain.join("  <  "));
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
  // Give up after 60s so the observer doesn't linger for the tab's life.
  setTimeout(() => {
    if (!done) obs.disconnect();
  }, 60000);
}

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
