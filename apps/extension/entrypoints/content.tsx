import ReactDOM from "react-dom/client";

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
const ANCHOR_WAIT_TIMEOUT_MS = 15_000;
const HOST_STYLE_ID = "loom-host-positioning";

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    // Per-tab activation (5d-perf): we no longer eagerly install the
    // caption-discovery message listener here.  LoomApp starts dormant
    // by default; when the user activates Loom for this tab, the
    // CaptionStreamProvider's useEffect calls subscribeToCaptions
    // which installs the listener AND posts request-tracklist to
    // MAIN.  MAIN caches its latest tracklist in latestPayload and
    // re-emits on request, so the late-subscribe race from 5c is
    // already handled at the MAIN side — no eager install needed.

    // Inject the host-positioning rule BEFORE the host is appended
    // to the DOM.  Whenever WXT inserts <loom-overlay-root>, the
    // browser applies these styles on first computed-style resolution.
    injectHostPositioningStyle();

    const anchor = await waitForElement(ANCHOR_SELECTOR, ANCHOR_WAIT_TIMEOUT_MS);
    if (!anchor) {
      console.warn(
        "[Loom] #movie_player never appeared within",
        ANCHOR_WAIT_TIMEOUT_MS,
        "ms — overlay not mounted",
      );
      return;
    }

    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: ANCHOR_SELECTOR,
      // Opt out of the :host{all:initial!important} reset — see
      // file header comment for why this is the load-bearing line.
      inheritStyles: true,
      onMount: (uiContainer) => {
        // uiContainer is inside the shadow root.  Stretch it so the
        // inner React tree's `position: absolute; inset: 0` children
        // get a sized containing block.
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

    // Verify the host actually picked up our positioning after mount.
    // Keep this log through 5c shakedown; remove once we've confirmed
    // captions render across paused + playing + fullscreen states.
    const host = ui.shadowHost;
    requestAnimationFrame(() => {
      const cs = getComputedStyle(host);
      const r = host.getBoundingClientRect();
      console.log(
        "[Loom 5c-verify] host computed style — tag=", host.tagName.toLowerCase(),
        "position=", cs.position,
        "display=", cs.display,
        "z-index=", cs.zIndex,
        "rect=", Math.round(r.width), "x", Math.round(r.height),
        "top=", Math.round(r.top),
      );
    });

    console.log("[Loom] overlay mounted inside", ANCHOR_SELECTOR);
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

/** Wait for an element matching `selector` to exist in the DOM.
    Returns the element, or null on timeout.  Mirrors the shape of
    `CaptionStream.#waitForVideo` in lib/captions/stream.ts. */
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
