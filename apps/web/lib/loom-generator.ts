// Step 4d-5 — single façade over the 4d-1..4d-4 pipeline.
//
// LoomGenerator binds (native, target, styles) once and exposes the two
// outputs the user actually wants:
//   - generateAss()  → 4-layer .ass bytes (4d-2 path, fast / synchronous-ish)
//   - generateSup()  → PGS .sup bytes (rasterize → SupWriter, slow / async)
//
// Both methods produce raw bytes; filename construction stays in the caller
// because filename rules differ between desktop / web / extension surfaces
// and the consumer always knows the source media name.

import { SSAFile } from "./subs/ssa";
import { generateAssFile } from "./subs/generate-ass";
import type { StyleConfig } from "./subs/style-config";
import { rasterizeFrames } from "./raster/rasterizer";
import { SupWriter, type SupWriterStats } from "./raster/sup-writer";

export interface LoomGeneratorOptions {
  /** Native (user's-language) subs.  Bottom layer source. */
  native: SSAFile;
  /** Target (foreign/media) subs.  Top + Romanized layer source. */
  target: SSAFile;
  /** Live style config — same shape the desktop UI feeds into the API. */
  styles: StyleConfig;
  /** Output PlayRes / canvas resolution.  Defaults to (1920, 1080).
      Applied to BOTH .ass PlayResX/Y and PGS canvas — keeping them in
      sync is what makes the two outputs renderable at the same scale. */
  resolution?: [number, number];
  /** Optional pre-romanization hook.  When provided, the .ass output
      includes a Romanized layer with romanize(target_text) per event;
      otherwise the layer is skipped.  Wire the real romanizer (4e). */
  romanize?: (text: string) => string;
}

export interface SupGenerateOptions {
  /** Caps the pipeline at the first N frames.  Diagnostic — leave
      undefined for full-episode output. */
  max_frames?: number;
  /** Per-frame progress.  `done` and `total` come from the rasterizer's
      union timeline; `stats` reflects the SupWriter at that moment. */
  on_progress?: (done: number, total: number, stats: SupWriterStats) => void;
  /** Abort the encode at the next frame boundary.  The frame currently
      mid-rasterize will still finish (html2canvas isn't interruptible),
      but no subsequent frame is started. */
  signal?: AbortSignal;
}

export interface SupGenerateResult {
  bytes: Uint8Array;
  /** Number of frames passed to SupWriter.write().  Includes clears. */
  frames: number;
  stats: SupWriterStats;
}

export class LoomGenerator {
  #opts: LoomGeneratorOptions;

  constructor(opts: LoomGeneratorOptions) {
    this.#opts = opts;
  }

  /** Build the stitched .ass and return UTF-8 bytes.  Synchronous —
      no rasterization, just SSAFile manipulation + serialization. */
  generateAss(): Uint8Array {
    const text = generateAssFile({
      native: this.#opts.native,
      target: this.#opts.target,
      styles: this.#opts.styles,
      output_play_res: this.#opts.resolution,
      romanize: this.#opts.romanize,
    });
    return new TextEncoder().encode(text);
  }

  /** Drive the rasterizer → SupWriter pipeline to completion and return
      the .sup byte stream. */
  async generateSup(options: SupGenerateOptions = {}): Promise<SupGenerateResult> {
    const [width, height] = this.#opts.resolution ?? [1920, 1080];
    const writer = new SupWriter(width, height);
    let frames = 0;

    for await (const frame of rasterizeFrames({
      native: this.#opts.native,
      target: this.#opts.target,
      styles: this.#opts.styles,
      resolution: this.#opts.resolution,
      onProgress: (done, total) => {
        options.on_progress?.(done, total, writer.stats);
      },
    })) {
      if (options.signal?.aborted) {
        throw new DOMException("LoomGenerator.generateSup aborted", "AbortError");
      }
      writer.write({
        start_ms: frame.start_ms,
        end_ms: frame.end_ms,
        rgba: frame.rgba,
        width: frame.width,
        height: frame.height,
        top_text: frame.top_text,
        bottom_text: frame.bottom_text,
      });
      frames += 1;
      if (options.max_frames !== undefined && frames >= options.max_frames) break;
    }

    const bytes = writer.close();
    return { bytes, frames, stats: writer.stats };
  }
}
