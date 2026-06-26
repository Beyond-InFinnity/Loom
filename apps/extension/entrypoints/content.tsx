import ReactDOM from "react-dom/client";

import { logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";

// Content script for YouTube watch pages.
//
// 5c host-positioning saga, final form:
//
// WXT's createShadowRootUi by default injects this rule INTO the
// shadow root:
//   :host { all: initial !important; }
// Intent: sandbox the host element from inheriting page CSS.  Side
// effect: custom-element default `display: inline` + `position: static`
// stick, and the host renders as a 0×0 inline box — nothing inside
// can be visible.
//
// We tried three CSS-cascade workarounds, all failed:
//   (1) host.style.setProperty(..., "important") inline writes
//   (2) Bumping z-index + isolation:isolate
//   (3) Document-level stylesheet `loom-overlay-root { ... !important }`
//
// The CSS Scoping spec quietly inverts the !important precedence for
// the SHADOW HOST element: shadow-tree !important beats document-tree
// !important on the host (this is opposite the usual cascade, which
// is why we kept losing).  So no exterior CSS — inline or stylesheet —
// can overpower WXT's reset on the host.
//
// Fix: opt out of WXT's reset via `inheritStyles: true`.  This removes
// the :host{all:initial!important} injection entirely.  After that,
// inline styles on the host (or a document stylesheet) work normally.
// Tradeoff: page CSS can inherit into the shadow tree via inheritable
// properties (color, font, etc.).  Cost is zero here because every
// caption-rendering element sets its visuals via inline React style.

const ANCHOR_SELECTOR = "#movie_player";
const HOST_STYLE_ID = "loom-host-positioning";

export default defineContentScript({
  // ALL of youtube.com, not just /watch* (no-refresh fix): YouTube is an SPA,
  // so navigating home→video (and video→video) is a history navigation with
  // NO document reload — a /watch*-only content script never injects on those,
  // so Loom was absent until F5.  We load on the first YouTube page; WXT's
  // autoMount owns the overlay lifecycle.  Re-discovery on video→video is
  // driven by yt-main's existing yt-navigate-finish handler.
  matches: ["*://*.youtube.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    // Per-tab activation (5d-perf): no eager discovery listener here.  LoomApp
    // starts dormant; on activation the CaptionStreamProvider subscribes +
    // posts request-tracklist, and MAIN re-emits its cached tracklist.

    // Inject the host-positioning rule (idempotent) BEFORE the host is
    // appended, so the browser applies it on first computed-style resolution.
    injectHostPositioningStyle();

    // autoMount owns the overlay lifecycle — see netflix.content.tsx for the
    // full rationale.  #movie_player persists across YouTube's SPA video
    // navigations, so the overlay stays mounted and re-discovery rides on
    // yt-main's yt-navigate-finish; autoMount additionally covers home→watch
    // (anchor appears) and any player rebuild.
    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: ANCHOR_SELECTOR,
      // Opt out of the :host{all:initial!important} reset — see file header.
      inheritStyles: true,
      onMount: (uiContainer) => {
        // uiContainer is inside the shadow root.  Stretch it so the inner
        // React tree's `position: absolute; inset: 0` children get a sized
        // containing block.
        uiContainer.style.position = "absolute";
        uiContainer.style.inset = "0";
        const root = ReactDOM.createRoot(uiContainer);
        root.render(<LoomApp />);
        logDev("[Loom] overlay mounted inside", ANCHOR_SELECTOR);
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom] overlay unmounted");
      },
    });
    ui.autoMount();
  },
});

/** Inject (once) a document-level stylesheet that positions the WXT
    shadow host `<loom-overlay-root>`.  Idempotent.

    PERF LOAD-BEARING: the `transform: translateZ(0)` + `will-change:
    transform` promote the host to its own compositor layer.  Without
    this, every YouTube page repaint (60fps progress bar, auto-hiding
    controls, ad transitions) cascaded through the entire shadow root
    on the main thread — pill + overlay paints had to be rasterized
    alongside YT's own painting work.  Compositor-layer-isolating the
    host means our shadow tree is composited independently and YT's
    repaints don't touch our paint surface.  This was the main fix
    for multi-second input lag observed when the pill was permanently
    mounted. */
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
