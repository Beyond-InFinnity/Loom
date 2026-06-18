import ReactDOM from "react-dom/client";

import { logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  NETFLIX_PLAYER_ROOT,
  ensureAnchorPositioned,
} from "@/lib/overlay/netflix-player-anchor";

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
const ANCHOR_WAIT_TIMEOUT_MS = 30_000;
const HOST_STYLE_ID = "loom-host-positioning";

export default defineContentScript({
  matches: ["*://*.netflix.com/watch/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    injectHostPositioningStyle();

    // Netflix's player root appears only after the SPA loads the watch
    // view + the player initializes — later than YouTube's #movie_player,
    // hence the longer timeout.
    const anchor = await waitForElement(
      ANCHOR_SELECTOR,
      ANCHOR_WAIT_TIMEOUT_MS,
    );
    if (!anchor) {
      console.warn(
        "[Loom] Netflix player root",
        ANCHOR_SELECTOR,
        "never appeared within",
        ANCHOR_WAIT_TIMEOUT_MS,
        "ms — overlay not mounted",
      );
      return;
    }

    // The canvas may be position:static; promote it so the absolute host
    // anchors to it rather than escaping to a positioned ancestor.
    ensureAnchorPositioned(anchor as HTMLElement);

    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: ANCHOR_SELECTOR,
      inheritStyles: true,
      onMount: (uiContainer) => {
        uiContainer.style.position = "absolute";
        uiContainer.style.inset = "0";
        const root = ReactDOM.createRoot(uiContainer);
        root.render(<LoomApp />);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();
    logDev("[Loom] Netflix overlay mounted inside", ANCHOR_SELECTOR);
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

/** Wait for an element matching `selector` to exist.  Returns the
    element, or null on timeout.  (Duplicated from content.tsx rather than
    shared, to keep the YouTube entrypoint byte-for-byte untouched.) */
function waitForElement(
  selector: string,
  timeoutMs: number,
): Promise<Element | null> {
  const existing = document.querySelector(selector);
  if (existing) return Promise.resolve(existing);

  return new Promise<Element | null>((resolve) => {
    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) {
        observer.disconnect();
        clearTimeout(timeoutId);
        resolve(found);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    const timeoutId = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
  });
}
