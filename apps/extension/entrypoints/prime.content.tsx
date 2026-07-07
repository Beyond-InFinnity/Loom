import ReactDOM from "react-dom/client";

import { logDev } from "@/lib/env";
import { LoomApp } from "@/components/loom-app";
import {
  PRIME_PLAYER_ROOT,
  ensureAnchorPositioned,
  resolvePrimePlayerSurface,
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

// The overlay anchors to the SAME surface the playhead binds to
// (resolvePrimePlayerSurface, shared in prime-player-anchor.ts) — so they
// can't diverge onto different <video> elements.  See that helper's header.
const resolvePrimeAnchor = resolvePrimePlayerSurface;

export default defineContentScript({
  // All of primevideo.com — the player is embedded on the detail page and
  // Prime is an SPA (navigating title→title is history.pushState, no
  // reload), so load site-wide; WXT autoMount owns the overlay lifecycle
  // and re-mounts if Prime rebuilds the player subtree (next episode).
  matches: ["*://*.primevideo.com/*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    // Unconditional (console.info, NOT logDev) so we can tell "ISO script
    // never ran" from "ran but hung/failed later".  Past diagnostics all
    // sat AFTER the createShadowRootUi await, so a failure at/before it was
    // invisible.  This is the ground-truth entry marker.
    console.info("[Loom PRIME ISO] main ENTER —", location.href);
    injectHostPositioningStyle();
    probePlayerDomOnce();

    console.info("[Loom PRIME ISO] creating shadow UI…");
    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      // Function anchor: mount into the LARGEST sized surface with a video
      // (the real player), never the 0x0 preview.  ui.mount() re-invokes
      // this, so the reconciler below can (re)mount onto whichever surface
      // is real at that instant.
      anchor: () => resolvePrimeAnchor(),
      inheritStyles: true,
      onMount: (uiContainer) => {
        const anchor = resolvePrimeAnchor();
        if (anchor) ensureAnchorPositioned(anchor);
        uiContainer.style.position = "absolute";
        uiContainer.style.inset = "0";
        const root = ReactDOM.createRoot(uiContainer);
        root.render(<LoomApp />);
        const rect = anchor?.getBoundingClientRect();
        logDev(
          "[Loom] Prime overlay MOUNTED — anchor size:",
          rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : "?",
        );
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
        logDev("[Loom] Prime overlay UNMOUNTED (surface removed / not yet sized)");
      },
    });
    console.info("[Loom PRIME ISO] shadow UI ready — reconciler starting");

    // STATE-BASED mount reconciliation (replaces ui.autoMount) — same pattern
    // as WeTV, but gated on a SIZED surface.  Prime's 0x0→full-size player
    // transition happens via layout (NOT a DOM mutation), so autoMount's
    // mutation-only observer never re-fires — the overlay stays stuck on the
    // 0x0 preview (invisible pill, dead playhead; "only shows after refresh").
    // Reconciling to the resolved anchor on mutations + a 1s backstop (which
    // catches the pure-resize transition) fixes it.  Idempotent; always
    // remove() a stale mount before re-mounting (no duplicate React root).
    let mountedTo: HTMLElement | null = null;
    const ensureMount = () => {
      // Resolve the REAL content surface (longest-duration video — the
      // episode, never the ~30s autoplay preview Prime shows on an equally
      // large surface while buffering; see resolvePrimePlayerSurface).
      const target = resolvePrimeAnchor();

      // Already correctly mounted on the resolved target?  Nothing to do.
      // The gate is IDENTITY (mountedTo === target), not mere connectedness:
      // the previous "keep while connected" rule clung to the paused,
      // hidden preview-trailer surface forever once the real episode spun
      // up on a DIFFERENT surface, so the pill+subs never appeared on the
      // episode ("worked on the trailer, dead on the show").  Migrating on
      // identity change is safe from thrash because duration is stable —
      // the episode surface stays the longest-duration one, so once we land
      // on it target stops changing.
      if (
        target &&
        mountedTo === target &&
        mountedTo.isConnected &&
        ui.shadowHost?.isConnected &&
        mountedTo.contains(ui.shadowHost)
      ) {
        return;
      }

      if (!target) {
        if (mountedTo) {
          logDev("[Loom] Prime reconcile: no content surface — unmounting");
          try {
            ui.remove();
          } catch {
            /* tolerate a half-torn-down state */
          }
          mountedTo = null;
        }
        return;
      }

      // First mount, OR migrate off a stale surface (preview→episode swap,
      // or the mounted surface was torn down and rebuilt).
      if (mountedTo) {
        logDev("[Loom] Prime reconcile: migrating overlay to the content surface");
        try {
          ui.remove();
        } catch {
          /* tolerate a half-torn-down state */
        }
        mountedTo = null;
      }
      ui.mount();
      mountedTo = target;
      const r = target.getBoundingClientRect();
      const v = target.querySelector("video");
      console.info(
        "[Loom PRIME ISO] MOUNTED on surface",
        `${Math.round(r.width)}x${Math.round(r.height)}`,
        "dur=",
        v && Number.isFinite((v as HTMLVideoElement).duration)
          ? Math.round((v as HTMLVideoElement).duration)
          : "NaN",
      );
    };

    // GROUND-TRUTH HEARTBEAT (unconditional).  Every ~2s report the exact
    // DOM state the reconciler sees: whether we're mounted, every
    // `.atvwebplayersdk-video-surface` with its size + whether it holds a
    // <video> (readyState + duration), and the TOTAL <video> count on the
    // page.  This is the diagnostic that was missing — it distinguishes
    // "no player surface exists (Amazon didn't load one)" from "surface
    // exists but we're not mounting" from "video present but not loaded".
    let hbTick = 0;
    const heartbeat = () => {
      hbTick += 1;
      if (hbTick % 2 !== 0) return; // ~every 2s (backstop is 1s)
      const surfaces = Array.from(
        document.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR),
      ).map((el) => {
        const r = el.getBoundingClientRect();
        const v = el.querySelector("video");
        const vinfo = v
          ? `+video(rs${(v as HTMLVideoElement).readyState},dur${Number.isFinite((v as HTMLVideoElement).duration) ? Math.round((v as HTMLVideoElement).duration) : "NaN"},${(v as HTMLVideoElement).paused ? "paused" : "playing"})`
          : "-novideo";
        return `${Math.round(r.width)}x${Math.round(r.height)}${vinfo}`;
      });
      const totalVideos = document.querySelectorAll("video").length;
      console.info(
        "[Loom PRIME ISO] hb — mounted:",
        !!mountedTo,
        "| surfaces:",
        surfaces.length ? surfaces.join(" ; ") : "(none)",
        "| totalVideos:",
        totalVideos,
      );
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
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const backstop = setInterval(() => {
      ensureMount();
      heartbeat();
    }, 1000); // catches the resize→sized transition + emits the heartbeat
    ensureMount();
    ctx.onInvalidated(() => {
      observer.disconnect();
      clearInterval(backstop);
      if (raf) cancelAnimationFrame(raf);
    });
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
