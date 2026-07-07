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

/** One-shot live-recon aid (dev builds only): when Prime's player chrome
    has mounted, dump the STABLE `atvwebplayersdk-*` skeleton so the real
    anchor / video / native-caption selectors are confirmable from the
    console in one session.  Waits until a controls/overlay element (not
    just the video) is present, since the video surface mounts before the
    chrome.  Remove once selectors are verified. */
function probePlayerDomOnce(): void {
  let done = false;
  const stableTokens = (el: Element): string =>
    (typeof el.className === "string" ? el.className : "")
      .trim()
      .split(/\s+/)
      .filter((c) => c.startsWith("atvwebplayersdk-"))
      .join(".");

  const tryProbe = (force = false): void => {
    if (done) return;
    const sdkEls = Array.from(
      document.querySelectorAll('[class*="atvwebplayersdk-"]'),
    );
    // Fire once the skeleton is substantially mounted (≥3 sdk elements =
    // more than the bare video surface).  A timed fallback (below) dumps
    // whatever exists even if the chrome never enriches, so we always get
    // output.
    if (!force && sdkEls.length < 3) return;
    if (sdkEls.length === 0) return;
    done = true;
    obs.disconnect();

    // Every distinct atvwebplayersdk-* token present = the stable hooks.
    const tokens = new Set<string>();
    for (const el of sdkEls)
      for (const c of stableTokens(el).split("."))
        if (c) tokens.add(c);
    logDev(
      "[Loom PRIME probe] atvwebplayersdk tokens present:",
      [...tokens].sort().join("  "),
    );

    // The video's ancestor chain, stable tokens only (per level) so the
    // real anchor (the LCA of video + chrome) is visible.
    const chain: string[] = [];
    let el: Element | null = document.querySelector("video");
    for (let i = 0; el && i < 14; i++) {
      const t = stableTokens(el);
      chain.push(`${el.tagName.toLowerCase()}${t ? "." + t : ""}`);
      el = el.parentElement;
    }
    logDev("[Loom PRIME probe] video ancestors (stable tokens):", chain.join("  <  "));

    // Hunt the native-caption element (only present while a native cue is
    // showing) so the suppression CSS can be finalized.  Watches for any
    // element whose class mentions caption/subtitle/timedtext.
    const capEls = Array.from(
      document.querySelectorAll(
        '[class*="caption" i],[class*="subtitle" i],[class*="timedtext" i]',
      ),
    )
      .map((e) => (typeof e.className === "string" ? e.className : ""))
      .filter((c) => c.length > 0);
    logDev(
      "[Loom PRIME probe] caption-ish classes present:",
      capEls.length > 0 ? capEls.join(" | ") : "(none showing — turn a native sub ON to reveal)",
    );
  };

  const obs = new MutationObserver(() => tryProbe());
  obs.observe(document.documentElement, { childList: true, subtree: true });
  tryProbe();
  // Fallback: after 8s, dump whatever atvwebplayersdk-* elements exist even
  // if the chrome never reached the ≥3 threshold, so we always get output.
  setTimeout(() => tryProbe(true), 8000);
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
