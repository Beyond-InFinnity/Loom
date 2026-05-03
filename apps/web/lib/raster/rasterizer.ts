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
}

export interface RasterizeOptions {
  native: SSAFile;
  target: SSAFile;
  styles: StyleConfig;
  /** Output canvas resolution.  Defaults to 1920×1080. */
  resolution?: [number, number];
  /** Optional progress hook — called after each rasterized frame. */
  onProgress?: (done: number, total: number) => void;
  /** Optional per-frame timeout (ms).  Default 30s — html2canvas can
      hang if fonts never load.  Required by feedback_async_hang_prevention.md. */
  per_frame_timeout_ms?: number;
}

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
  const timeoutMs = opts.per_frame_timeout_ms ?? 30_000;

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
    // Wait for all installed fonts to be ready BEFORE the first
    // rasterization — otherwise text falls back to system serif and
    // the first few frames look wrong.
    await withTimeout(document.fonts.ready, timeoutMs, "document.fonts.ready");

    let done = 0;
    for (const iv of intervals) {
      // Build per-event HTML.  Empty top/bottom = layer skipped.
      const html = buildSubtitleHtml({
        styles: opts.styles,
        top_text: iv.top?.plain_text ?? "",
        bottom_text: iv.bottom?.plain_text ?? "",
        canvas_width: width,
        canvas_height: height,
        scale,
      });

      // Mount.  innerHTML rewrite is the cheapest way to swap content
      // — html2canvas needs the computed styles fresh per frame so a
      // textContent-only swap wouldn't work (style block changes too).
      container.innerHTML = extractBody(html);
      const styleBlock = extractStyle(html);
      // Inject the style block as a <style> child of container so it's
      // scoped to this rasterization (doesn't leak to host page styles).
      const styleEl = document.createElement("style");
      styleEl.textContent = styleBlock;
      container.prepend(styleEl);

      // Force layout flush before html2canvas reads computed styles.
      void container.offsetHeight;

      // html2canvas options:
      //   backgroundColor: null → transparent (matches Playwright omit_background)
      //   width/height: explicit so html2canvas doesn't add fractional padding
      //   scale: 1 → 1:1 pixel mapping (no devicePixelRatio scaling)
      //   logging: false — suppresses html2canvas's noisy console output
      const canvas = await withTimeout(
        html2canvas(container, {
          backgroundColor: null,
          width, height,
          scale: 1,
          logging: false,
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
      };

      done += 1;
      opts.onProgress?.(done, total);
    }
  } finally {
    container.remove();
  }
}

/** Extract everything between <body>...</body> from a full HTML doc. */
function extractBody(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  return m ? m[1] : html;
}

/** Extract everything between <style>...</style> in <head>. */
function extractStyle(html: string): string {
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return m ? m[1] : "";
}
