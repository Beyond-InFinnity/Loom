// 4d-3 — html2canvas-driven bitmap rasterization.  Validates the 4b
// spike's architectural choice: html2canvas walks the DOM and draws
// text/shapes via Canvas2D primitives, producing un-tainted canvases
// that getImageData can read.  Spike showed ~0.6% pixel divergence vs
// the desktop's Playwright reference — visual equivalence, not
// byte-identical (CLAUDE.md "Spike: PGS-in-browser" verdict).
//
// Output: an async iterator yielding one RasterizedFrame per non-empty
// timeline interval.  Lazy by design — full episode rasterization can
// produce gigabytes of RGBA in aggregate; consumers (4d-4 PGS writer)
// process one frame, free, request next.

import html2canvas from "html2canvas";
import type { StyleConfig } from "../subs/style-config";
import type { SSAFile } from "../subs/ssa";
import { buildSubtitleHtml } from "./build-html";
import { buildPgsTimeline } from "./timeline";

export interface RasterizedFrame {
  /** Inclusive ms.  Maps to PGS Display Set presentation timestamp. */
  start_ms: number;
  /** Exclusive ms — frame is visible until this timestamp. */
  end_ms: number;
  /** Full-frame RGBA, length = canvas_width * canvas_height * 4.
      Null indicates a "clear" frame (no subs visible). */
  rgba: Uint8ClampedArray | null;
  /** Width/height of the rgba buffer (matches canvas resolution). */
  width: number;
  height: number;
  /** Source plain text for the upper subtitle layer (target/foreign).
      Empty string when the layer is absent for this interval.  Carries
      through so 4d-4's SupWriter can derive per-region content keys
      for epoch-state Skip/Normal optimization. */
  top_text: string;
  /** Source plain text for the lower subtitle layer (native).  Same
      purpose as top_text. */
  bottom_text: string;
}

export interface RasterizeOptions {
  native: SSAFile;
  target: SSAFile;
  styles: StyleConfig;
  /** Output canvas resolution.  Defaults to 1920×1080. */
  resolution?: [number, number];
  /** Optional progress hook — called after each rasterized frame. */
  onProgress?: (done: number, total: number) => void;
  /** Optional per-frame timeout (ms).  Default 60s — html2canvas can
      hang if fonts never load.  Required by feedback_async_hang_prevention.md.
      Bumped from 30s after first prod test hit a JP frame stall: 60s leaves
      headroom for a slow font fetch + glyph measurement on cold-start
      devices, while still surfacing genuine hangs in finite time. */
  per_frame_timeout_ms?: number;
}

/** Font families build-html.ts emits in the rasterizer's font-family
    stack.  Browser only fetches a Google Font when something on the page
    references it, so we kick off the loads explicitly via
    document.fonts.load() at rasterizer setup — otherwise the FIRST frame
    that needs a CJK glyph would block waiting for the font (or worse,
    silently fall back to a system font that hangs html2canvas's text
    measurement, which is exactly what bit the first prod test). */
const PRELOAD_FONT_SPECS: ReadonlyArray<string> = [
  // Latin core
  '48px "Noto Sans"',
  // CJK
  '48px "Noto Sans JP"',
  '48px "Noto Sans SC"',
  '48px "Noto Sans TC"',
  '48px "Noto Sans KR"',
  // Thai
  '48px "Noto Sans Thai"',
];

/** Wrap a promise so a never-settling render surfaces as labeled
    rejection.  Mirrors the helper in lib/ffmpeg/client.ts — every
    third-party promise gets one of these. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms waiting for: ${label}`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(handle); resolve(v); },
      (e) => { clearTimeout(handle); reject(e); },
    );
  });
}

/** Async iterator yielding one frame per timeline interval.  The DOM
    container + canvas are reused across iterations to avoid layout
    thrash.  The container is positioned offscreen via absolute + huge
    negative left so it doesn't interfere with the host page. */
export async function* rasterizeFrames(
  opts: RasterizeOptions,
): AsyncGenerator<RasterizedFrame, void, unknown> {
  const [width, height] = opts.resolution ?? [1920, 1080];
  const scale = height / 1080;
  const timeoutMs = opts.per_frame_timeout_ms ?? 60_000;

  const intervals = buildPgsTimeline({
    native: opts.native,
    target: opts.target,
    bottom_enabled: opts.styles.bottom.enabled,
    top_enabled: opts.styles.top.enabled,
  });
  const total = intervals.length;

  // Offscreen mount point.  Positioned far off-screen so it can't
  // catch user clicks or affect layout.  Kept in DOM (not detached)
  // because html2canvas needs computed styles.
  const container = document.createElement("div");
  container.id = "loom-raster-host";
  container.style.cssText = `
    position: absolute;
    left: -100000px;
    top: 0;
    width: ${width}px;
    height: ${height}px;
    overflow: hidden;
    background: transparent;
    pointer-events: none;
    contain: strict;
  `;
  // The actual subtitle frame DOM gets re-built per event.  We re-use
  // the container; the inner .frame gets replaced.
  document.body.appendChild(container);

  try {
    // Pre-warm the rasterizer's font set BEFORE the first frame.  Two
    // gates here, in order:
    //
    //   1) document.fonts.load(spec)  — explicitly request each Google
    //      Font we might emit.  Without this, the font isn't fetched
    //      until first reference, and the first JP frame would race
    //      against the network (caught a 30s hang in prod; 60s timeout
    //      now but we'd rather not hit it at all).
    //
    //   2) document.fonts.ready  — wait until ALL pending fonts have
    //      resolved (loaded or failed).  Failures are silent here on
    //      purpose: a missing CJK font is a degraded-render condition,
    //      not a hard fail — html2canvas falls back to the next family
    //      in the stack and the result is still usable.
    //
    // Each individual load gets its own timeout so one stalled font
    // doesn't block the whole pipeline.
    await Promise.all(
      PRELOAD_FONT_SPECS.map((spec) =>
        withTimeout(document.fonts.load(spec), timeoutMs, `font preload: ${spec}`).catch(
          (err) => {
            // Best effort — log + continue.  Real users on flaky networks
            // shouldn't get a hard fail when a Google Font CDN hiccups.
            console.warn("[loom rasterizer] font preload failed:", spec, err);
          },
        ),
      ),
    );
    await withTimeout(document.fonts.ready, timeoutMs, "document.fonts.ready");

    let done = 0;
    for (const iv of intervals) {
      // Build per-event HTML.  Empty top/bottom = layer skipped.
      // The output is a self-contained `<style>...</style><div class="frame">...</div>`
      // pair — every CSS rule scoped to #loom-raster-host so the styles
      // can't leak to the host page (an earlier version emitted a global
      // `*` reset + `html, body` rules and visibly trashed the marketing
      // chrome during long generates).
      const html = buildSubtitleHtml({
        styles: opts.styles,
        top_text: iv.top?.plain_text ?? "",
        bottom_text: iv.bottom?.plain_text ?? "",
        canvas_width: width,
        canvas_height: height,
        scale,
      });
      container.innerHTML = html;

      // Force layout flush before html2canvas reads computed styles.
      void container.offsetHeight;

      // html2canvas options:
      //   backgroundColor: null → transparent (matches Playwright omit_background)
      //   width/height: explicit so html2canvas doesn't add fractional padding
      //   scale: 1 → 1:1 pixel mapping (no devicePixelRatio scaling)
      //   logging: false — suppresses html2canvas's noisy console output
      //   removeContainer: true → html2canvas's internal cloned DOM is
      //     auto-cleaned (default in 1.4.x but explicit beats inferred)
      const canvas = await withTimeout(
        html2canvas(container, {
          backgroundColor: null,
          width, height,
          scale: 1,
          logging: false,
          removeContainer: true,
        }),
        timeoutMs,
        `html2canvas frame ${done + 1}/${total}`,
      );

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("rasterizer: canvas context unavailable");
      const img = ctx.getImageData(0, 0, width, height);

      // Detect "all transparent" — if every alpha byte is 0, treat as clear.
      // Cheap pass; saves the consumer from having to detect it.
      let nonTransparent = false;
      for (let i = 3; i < img.data.length; i += 4) {
        if (img.data[i] !== 0) { nonTransparent = true; break; }
      }

      yield {
        start_ms: iv.start_ms,
        end_ms: iv.end_ms,
        rgba: nonTransparent ? img.data : null,
        width, height,
        top_text: iv.top?.plain_text ?? "",
        bottom_text: iv.bottom?.plain_text ?? "",
      };

      // Dispose the per-frame canvas html2canvas allocated.  Setting
      // width/height to 0 releases the underlying GPU + CPU buffers
      // (~16MB each at 1920x1080 RGBA).  Without this, ~1437 frames
      // hold ~23 GB of pinned canvas memory and the browser hits a
      // GC-thrashing perf cliff around frame 1200, where individual
      // html2canvas calls start exceeding 60s.
      canvas.width = 0;
      canvas.height = 0;

      done += 1;
      opts.onProgress?.(done, total);

      // Yield to the event loop.  Lets the browser interleave GC, paint,
      // and the consumer's pending work — without this we'd hold the JS
      // thread for thousands of synchronous turns and the browser tab
      // visibly degrades.  setTimeout(0) is a coarser yield than
      // requestAnimationFrame but doesn't depend on the page being
      // visible (rAF stalls when the tab is backgrounded, which is
      // exactly when the user wants to walk away from a long generate).
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    container.remove();
  }
}

