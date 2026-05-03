// PGS .sup binary writer — streaming + epoch-aware.
//
// Port of loom_core/rasterize/sup_writer.py (the SupWriter class +
// _build_*_segments + _emit_* + _quantize_for_epoch).  Consumes the
// per-frame RGBA produced by rasterizeFrames() and emits a byte-correct
// PGS stream that ffmpeg + mpv accept as a subtitle track.
//
// Design notes (cribbed from CLAUDE.md):
//   - PGS Display Set = [PCS, WDS, PDS, ODS..., END] segments.
//   - Composition states: Epoch Start (full redraw, seek-safe) /
//     Acquisition Point (full redraw every 12 sets for seek pickup) /
//     Normal (only changed objects re-encoded) / Skip (identical content).
//   - 2-object reserved palette ranges: obj 0 → indices 1..127,
//     obj 1 → 128..254.  Index 255 is left transparent.
//   - PTS=0 anchor at stream start prevents ffmpeg from rebasing
//     timestamps during mux — without it, subtitles drift earlier by
//     the gap between video start and the first subtitle.
//
// Consumer pattern (4d-5 will wrap this):
//   const writer = new SupWriter(1920, 1080);
//   for await (const frame of rasterizeFrames(...)) {
//     writer.write({
//       start_ms: frame.start_ms, end_ms: frame.end_ms,
//       rgba: frame.rgba, width: frame.width, height: frame.height,
//       top_text: ..., bottom_text: ...,
//     });
//   }
//   const bytes = writer.close();

import {
  AP_INTERVAL,
  COMP_ACQUISITION_POINT,
  COMP_EPOCH_START,
  COMP_NORMAL,
  PcsObjectRef,
  PdsEntry,
  SEG_END,
  SEG_PCS,
  SEG_PDS,
  SEG_WDS,
  WdsWindow,
  buildOdsSegments,
  encodeRle,
  makePcs,
  makePds,
  makeSegment,
  makeWds,
} from "./pgs-segments";
import { BoundedBitmap, cropToBBox, splitRegions } from "./pgs-regions";
import { PaletteEntry, quantizeImage } from "./pgs-quantize";

// ── Public input type ────────────────────────────────────────────────

export interface SupWriterFrame {
  /** Inclusive start time in ms.  Becomes PTS = start_ms * 90. */
  start_ms: number;
  /** Exclusive end time in ms.  Becomes the clear PTS (subject to
      monotonicity guard). */
  end_ms: number;
  /** Full-frame RGBA buffer, length = width * height * 4.  null
      indicates a "clear" interval (no subtitle visible) — the writer
      flushes the prior pending DS without emitting a show segment. */
  rgba: Uint8Array | Uint8ClampedArray | null;
  /** Canvas dimensions for this frame (must match writer's canvas). */
  width: number;
  height: number;
  /** Source text for the upper subtitle layer (target/foreign).  Used
      to derive the per-region content key for epoch state optimization.
      Optional; absence falls back to Epoch Start every frame. */
  top_text?: string;
  /** Source text for the lower subtitle layer (native).  Same purpose
      as top_text. */
  bottom_text?: string;
}

// ── Internal types ───────────────────────────────────────────────────

interface CachedObject {
  object_id: number;
  rle_data: Uint8Array;
  width: number;
  height: number;
  x: number;
  y: number;
  palette_entries: PdsEntry[];
  content_key: string;
}

interface EpochState {
  num_objects: number;
  content_keys: string[];
  cached_objects: CachedObject[];
  windows: WdsWindow[];
  ds_in_epoch: number;
  pal_version: number;
}

interface PendingFrame {
  start_ms: number;
  end_ms: number;
  regions: BoundedBitmap[];
  region_keys: string[];
}

interface QuantizedObject {
  rle_data: Uint8Array;
  width: number;
  height: number;
  pal_entries: PdsEntry[];
}

// ── Window computation ───────────────────────────────────────────────

/** PGS window definitions for the regions.  1 region = single window
    matching the bitmap.  2 regions = generous fixed windows (top 45%,
    bottom 25% of canvas) so a Normal update can target the right window
    without redefining geometry. */
function computeWindows(
  regions: BoundedBitmap[],
  canvasWidth: number,
  canvasHeight: number,
): WdsWindow[] {
  if (regions.length === 1) {
    const r = regions[0];
    return [{ window_id: 0, x: r.x, y: r.y, width: r.width, height: r.height }];
  }
  const topH = Math.floor(canvasHeight * 0.45);
  const botY = Math.floor(canvasHeight * 0.75);
  const botH = canvasHeight - botY;
  return [
    { window_id: 0, x: 0, y: 0, width: canvasWidth, height: topH },
    { window_id: 1, x: 0, y: botY, width: canvasWidth, height: botH },
  ];
}

/** True if every region's bitmap fits inside its assigned window. */
function checkWindowsFit(regions: BoundedBitmap[], windows: WdsWindow[]): boolean {
  for (let i = 0; i < regions.length; i++) {
    if (i >= windows.length) return false;
    const r = regions[i];
    const w = windows[i];
    if (r.x < w.x || r.y < w.y || r.x + r.width > w.x + w.width || r.y + r.height > w.y + w.height) {
      return false;
    }
  }
  return true;
}

// ── Quantization helpers (epoch-aware palette ranges) ────────────────

/** Convert a PaletteEntry array (256 entries, opaque ones at indices
    1..N) into PDS entries with the given offset applied to the index.
    Skips fully-transparent entries (alpha=0) except when forceIncludeIdx
    matches (for index 0, which is the canonical transparent slot).

    The caller sets maxOldIdx to bound the iteration (256 for single-object
    mode, 128 for 2-object mode where each object reserves 127 indices).
    We only drop entries whose newIdx falls outside the PGS palette range
    [0..255] — important because in single-object mode oldIdx=255 maps to
    newIdx=255 and that entry MUST land in the PDS, otherwise pixels the
    quantizer assigned to index 255 (often the white fill for CJK glyphs,
    which the median-cut leaves un-split at the tail) render transparent. */
function paletteToPdsEntries(
  palette: PaletteEntry[],
  offset: number,
  maxOldIdx: number,
  forceIncludeIdx?: number,
): PdsEntry[] {
  const out: PdsEntry[] = [];
  for (let oldIdx = 0; oldIdx < maxOldIdx; oldIdx++) {
    if (oldIdx >= palette.length) break;
    const p = palette[oldIdx];
    const newIdx = oldIdx === 0 ? 0 : oldIdx + offset;
    if (newIdx > 255) break;
    if (p.a === 0 && newIdx !== forceIncludeIdx) continue;
    out.push({ index: newIdx, y: p.y, cr: p.cr, cb: p.cb, alpha: p.a });
  }
  return out;
}

/** Quantize one region's bitmap into a palette + RLE bytes, applying
    the epoch-reserved index offset (0 for single-region or obj 0,
    +127 for obj 1 in 2-region mode). */
function quantizeSingleObject(
  bm: BoundedBitmap,
  objIndex: number,
  numObjects: number,
): QuantizedObject {
  const maxColors = numObjects === 1 ? 255 : 127;
  const offset = numObjects === 1 ? 0 : objIndex * 127;

  const { indices, palette } = quantizeImage(bm.rgba, bm.width, bm.height, maxColors);

  // Apply offset to opaque indices (transparent stays at 0).
  let outIndices = indices;
  if (offset > 0) {
    outIndices = new Uint8Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      const v = indices[i];
      outIndices[i] = v === 0 ? 0 : (v + offset) & 0xFF;
    }
  }

  const rleData = encodeRle(outIndices, bm.width, bm.height);
  const maxOldIdx = numObjects > 1 ? 128 : 256;
  // For non-zero offsets we don't include the transparent slot in this
  // entry list — it belongs only on the merged palette (index 0).
  const palEntries = paletteToPdsEntries(palette, offset, maxOldIdx);
  // Strip the transparent index 0 entry from individual object entries
  // since the merged palette emits it once explicitly.
  const filtered = palEntries.filter((e) => e.index !== 0);

  return { rle_data: rleData, width: bm.width, height: bm.height, pal_entries: filtered };
}

/** Quantize all regions for an Epoch Start.  Returns per-object data +
    the merged palette entries to embed in the PDS. */
function quantizeForEpoch(regions: BoundedBitmap[]): {
  obj_data: QuantizedObject[];
  merged_palette: PdsEntry[];
} {
  const num = regions.length;
  if (num === 1) {
    const obj = quantizeSingleObject(regions[0], 0, 1);
    // For single-object the merged palette = transparent + obj entries
    const merged: PdsEntry[] = [{ index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }];
    for (const e of obj.pal_entries) {
      if (e.alpha > 0) merged.push(e);
    }
    return { obj_data: [obj], merged_palette: merged };
  }

  // 2 objects with reserved palette ranges
  const merged: PdsEntry[] = [{ index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }];
  const objData: QuantizedObject[] = [];
  for (let i = 0; i < regions.length; i++) {
    const obj = quantizeSingleObject(regions[i], i, num);
    objData.push(obj);
    for (const e of obj.pal_entries) {
      if (e.alpha > 0) merged.push(e);
    }
  }
  return { obj_data: objData, merged_palette: merged };
}

// ── Display set emitters ─────────────────────────────────────────────

interface BuiltSegments {
  segments: Uint8Array[];
  new_state: EpochState;
  ds_type: "epoch_start" | "acquisition_point" | "normal";
}

function emitEpochStart(
  frame: PendingFrame,
  compNumber: number,
  canvasWidth: number,
  canvasHeight: number,
): BuiltSegments {
  const pts = frame.start_ms * 90;
  const windows = computeWindows(frame.regions, canvasWidth, canvasHeight);
  const { obj_data, merged_palette } = quantizeForEpoch(frame.regions);

  const pcsObjects: PcsObjectRef[] = [];
  const cached: CachedObject[] = [];
  for (let i = 0; i < frame.regions.length; i++) {
    const region = frame.regions[i];
    const data = obj_data[i];
    const winId = windows[i].window_id;
    pcsObjects.push({ object_id: i, window_id: winId, x: region.x, y: region.y, crop_flag: 0 });
    cached.push({
      object_id: i,
      rle_data: data.rle_data,
      width: data.width,
      height: data.height,
      x: region.x,
      y: region.y,
      palette_entries: data.pal_entries,
      content_key: frame.region_keys[i] ?? "",
    });
  }

  const segments: Uint8Array[] = [];
  segments.push(makeSegment(SEG_PCS, pts,
    makePcs(canvasWidth, canvasHeight, compNumber, COMP_EPOCH_START, false, 0, pcsObjects),
  ));
  segments.push(makeSegment(SEG_WDS, pts, makeWds(windows)));
  segments.push(makeSegment(SEG_PDS, pts, makePds(0, 0, merged_palette)));
  for (let i = 0; i < obj_data.length; i++) {
    const d = obj_data[i];
    segments.push(...buildOdsSegments(i, 0, d.width, d.height, d.rle_data, pts));
  }
  segments.push(makeSegment(SEG_END, pts, new Uint8Array(0)));

  const newState: EpochState = {
    num_objects: frame.regions.length,
    content_keys: [...frame.region_keys],
    cached_objects: cached,
    windows,
    ds_in_epoch: 1,
    pal_version: 0,
  };
  return { segments, new_state: newState, ds_type: "epoch_start" };
}

function emitAcquisitionPoint(
  frame: PendingFrame,
  compNumber: number,
  canvasWidth: number,
  canvasHeight: number,
  changed: number[],
  prevState: EpochState,
): BuiltSegments {
  const pts = frame.start_ms * 90;
  const num = frame.regions.length;
  const palVersion = prevState.pal_version + 1;
  const windows = computeWindows(frame.regions, canvasWidth, canvasHeight);

  const cached = [...prevState.cached_objects];
  const allPal: PdsEntry[] = [{ index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }];

  for (let i = 0; i < num; i++) {
    if (changed.includes(i)) {
      const region = frame.regions[i];
      const obj = quantizeSingleObject(region, i, num);
      cached[i] = {
        object_id: i,
        rle_data: obj.rle_data,
        width: obj.width,
        height: obj.height,
        x: region.x,
        y: region.y,
        palette_entries: obj.pal_entries,
        content_key: frame.region_keys[i] ?? "",
      };
      for (const e of obj.pal_entries) if (e.alpha > 0) allPal.push(e);
    } else {
      for (const e of cached[i].palette_entries) if (e.alpha > 0) allPal.push(e);
    }
  }

  const pcsObjects: PcsObjectRef[] = [];
  for (let i = 0; i < num; i++) {
    const co = cached[i];
    pcsObjects.push({ object_id: i, window_id: windows[i].window_id, x: co.x, y: co.y, crop_flag: 0 });
  }

  const segments: Uint8Array[] = [];
  segments.push(makeSegment(SEG_PCS, pts,
    makePcs(canvasWidth, canvasHeight, compNumber, COMP_ACQUISITION_POINT, false, 0, pcsObjects),
  ));
  segments.push(makeSegment(SEG_WDS, pts, makeWds(windows)));
  segments.push(makeSegment(SEG_PDS, pts, makePds(0, palVersion, allPal)));
  for (let i = 0; i < num; i++) {
    const co = cached[i];
    segments.push(...buildOdsSegments(i, 0, co.width, co.height, co.rle_data, pts));
  }
  segments.push(makeSegment(SEG_END, pts, new Uint8Array(0)));

  const newState: EpochState = {
    num_objects: num,
    content_keys: [...frame.region_keys],
    cached_objects: cached,
    windows,
    ds_in_epoch: prevState.ds_in_epoch + 1,
    pal_version: palVersion,
  };
  return { segments, new_state: newState, ds_type: "acquisition_point" };
}

function emitNormal(
  frame: PendingFrame,
  compNumber: number,
  canvasWidth: number,
  canvasHeight: number,
  changed: number[],
  prevState: EpochState,
): BuiltSegments {
  const pts = frame.start_ms * 90;
  const num = frame.regions.length;
  const palVersion = prevState.pal_version + 1;
  const cached = [...prevState.cached_objects];
  const windows = prevState.windows;

  // Re-quantize only the changed objects.
  for (const i of changed) {
    const region = frame.regions[i];
    const obj = quantizeSingleObject(region, i, num);
    cached[i] = {
      object_id: i,
      rle_data: obj.rle_data,
      width: obj.width,
      height: obj.height,
      x: region.x,
      y: region.y,
      palette_entries: obj.pal_entries,
      content_key: frame.region_keys[i] ?? "",
    };
  }

  // Full palette = transparent + every object's entries (changed +
  // unchanged).  Sending a partial palette would let buggy decoders
  // flash the unchanged object by clearing its palette entries.
  const palEntries: PdsEntry[] = [{ index: 0, y: 16, cr: 128, cb: 128, alpha: 0 }];
  for (let i = 0; i < num; i++) {
    for (const e of cached[i].palette_entries) if (e.alpha > 0) palEntries.push(e);
  }

  // PCS lists ALL objects (changed and unchanged) so both stay visible.
  const pcsObjects: PcsObjectRef[] = [];
  for (let i = 0; i < num; i++) {
    const co = cached[i];
    const winId = i < windows.length ? windows[i].window_id : 0;
    pcsObjects.push({ object_id: i, window_id: winId, x: co.x, y: co.y, crop_flag: 0 });
  }

  const segments: Uint8Array[] = [];
  segments.push(makeSegment(SEG_PCS, pts,
    makePcs(canvasWidth, canvasHeight, compNumber, COMP_NORMAL, false, 0, pcsObjects),
  ));
  // No WDS for Normal — windows persist from Epoch Start.
  segments.push(makeSegment(SEG_PDS, pts, makePds(0, palVersion, palEntries)));
  for (const i of changed) {
    const co = cached[i];
    segments.push(...buildOdsSegments(i, 0, co.width, co.height, co.rle_data, pts));
  }
  segments.push(makeSegment(SEG_END, pts, new Uint8Array(0)));

  const newState: EpochState = {
    num_objects: num,
    content_keys: [...frame.region_keys],
    cached_objects: cached,
    windows,
    ds_in_epoch: prevState.ds_in_epoch + 1,
    pal_version: palVersion,
  };
  return { segments, new_state: newState, ds_type: "normal" };
}

/** Decide which composition state to emit, then build the segments. */
function buildEpochSegments(
  frame: PendingFrame,
  compNumber: number,
  canvasWidth: number,
  canvasHeight: number,
  prevState: EpochState | null,
): BuiltSegments | null {
  if (frame.regions.length === 0) return null;

  // Force Epoch Start when no prior state or region count changed.
  if (prevState === null || frame.regions.length !== prevState.num_objects) {
    return emitEpochStart(frame, compNumber, canvasWidth, canvasHeight);
  }

  // All keys identical → Skip.
  const changed: number[] = [];
  for (let i = 0; i < frame.region_keys.length; i++) {
    if (i >= prevState.content_keys.length || frame.region_keys[i] !== prevState.content_keys[i]) {
      changed.push(i);
    }
  }
  if (changed.length === 0) return null;

  // AP if windows don't fit anymore or we hit the AP interval.
  const windowFallback = !checkWindowsFit(frame.regions, prevState.windows);
  if (windowFallback || (prevState.ds_in_epoch > 0 && prevState.ds_in_epoch % AP_INTERVAL === 0)) {
    return emitAcquisitionPoint(frame, compNumber, canvasWidth, canvasHeight, changed, prevState);
  }

  return emitNormal(frame, compNumber, canvasWidth, canvasHeight, changed, prevState);
}

// ── Clear Display Set ────────────────────────────────────────────────

/** Build the segments that clear the screen at a given PTS.  Always
    emitted as Epoch Start (composition state 0x80) so the player can
    seek to this point and correctly clear without prior context. */
function buildClearSegments(
  ptsMs: number,
  compNumber: number,
  canvasWidth: number,
  canvasHeight: number,
): Uint8Array[] {
  const pts = ptsMs * 90;
  const pcs = makePcs(canvasWidth, canvasHeight, compNumber, COMP_EPOCH_START, false, 0, []);
  // 1×1 minimal window — zero-area windows confuse ffmpeg's SUP demuxer
  // during mux even though mpv tolerates them on direct .sup load.
  const wds = makeWds([{ window_id: 0, x: 0, y: 0, width: 1, height: 1 }]);
  return [
    makeSegment(SEG_PCS, pts, pcs),
    makeSegment(SEG_WDS, pts, wds),
    makeSegment(SEG_END, pts, new Uint8Array(0)),
  ];
}

// ── Public streaming writer ──────────────────────────────────────────

export interface SupWriterStats {
  epoch_start: number;
  acquisition_point: number;
  normal: number;
  skipped: number;
  clears: number;
}

/** Streaming PGS/SUP writer.  Buffers one pending frame so it can guard
    the clear PTS against the next show PTS (monotonicity).  Call
    `close()` to flush the final pending frame and return the full
    .sup byte stream. */
export class SupWriter {
  #canvasWidth: number;
  #canvasHeight: number;
  #chunks: Uint8Array[] = [];
  #comp = 0;
  #pending: PendingFrame | null = null;
  #anchorWritten = false;
  #epochState: EpochState | null = null;
  stats: SupWriterStats = {
    epoch_start: 0,
    acquisition_point: 0,
    normal: 0,
    skipped: 0,
    clears: 0,
  };

  constructor(canvasWidth: number, canvasHeight: number) {
    this.#canvasWidth = canvasWidth;
    this.#canvasHeight = canvasHeight;
  }

  /** Accept one frame.  null rgba (or all-transparent) marks an
      explicit clear — flushes the pending DS without emitting a show. */
  write(frame: SupWriterFrame): void {
    if (frame.width !== this.#canvasWidth || frame.height !== this.#canvasHeight) {
      throw new Error(
        `SupWriter: frame ${frame.width}x${frame.height} ` +
        `does not match canvas ${this.#canvasWidth}x${this.#canvasHeight}`,
      );
    }

    // Anchor at PTS=0 on the very first frame whose start_ms > 0 (so
    // ffmpeg doesn't rebase timestamps during mux).
    if (!this.#anchorWritten) {
      this.#anchorWritten = true;
      if (frame.start_ms > 0) {
        const anchorPcs = makePcs(this.#canvasWidth, this.#canvasHeight, this.#comp, COMP_EPOCH_START, false, 0, []);
        const anchorWds = makeWds([{ window_id: 0, x: 0, y: 0, width: 1, height: 1 }]);
        this.#chunks.push(makeSegment(SEG_PCS, 0, anchorPcs));
        this.#chunks.push(makeSegment(SEG_WDS, 0, anchorWds));
        this.#chunks.push(makeSegment(SEG_END, 0, new Uint8Array(0)));
        this.#comp += 1;
      }
    }

    // null rgba → flush pending then drop.  No show, but the pending
    // frame's clear still needs to honor monotonicity against this
    // frame's start_ms.
    if (frame.rgba === null) {
      if (this.#pending !== null) this.#flushPending(frame.start_ms);
      return;
    }

    // Crop + split.  All-transparent crop returns null → treat as
    // explicit clear (defensive — rasterizer should have set rgba=null).
    const cropped = cropToBBox(frame.rgba, frame.width, frame.height);
    if (cropped === null) {
      if (this.#pending !== null) this.#flushPending(frame.start_ms);
      return;
    }
    const regions = splitRegions(cropped, this.#canvasHeight);
    const regionKeys = deriveRegionKeys(regions, frame.top_text, frame.bottom_text);

    // Flush prior pending DS, guarding clear PTS with this frame's start.
    if (this.#pending !== null) this.#flushPending(frame.start_ms);

    this.#pending = {
      start_ms: frame.start_ms,
      end_ms: frame.end_ms,
      regions,
      region_keys: regionKeys,
    };
  }

  #flushPending(nextStartMs: number | null): void {
    const frame = this.#pending;
    if (frame === null) return;

    // Build show segments for this frame (epoch-aware).
    const built = buildEpochSegments(frame, this.#comp, this.#canvasWidth, this.#canvasHeight, this.#epochState);

    if (built === null) {
      // Skip — no segments emitted for this frame's show portion.  We
      // still need to bump the in-epoch counter so the AP interval
      // ticks correctly even across skipped frames.
      this.stats.skipped += 1;
      if (this.#epochState !== null) {
        this.#epochState.ds_in_epoch += 1;
      }
    } else {
      for (const seg of built.segments) this.#chunks.push(seg);
      this.#comp += 1;
      this.#epochState = built.new_state;
      this.stats[built.ds_type] += 1;
    }

    // Decide whether to emit a clear.  Abutting frames (gap <= 50ms)
    // skip the clear so the screen stays painted without a flash.
    const abutting =
      nextStartMs !== null && nextStartMs - frame.end_ms <= 50;

    if (!abutting) {
      let clearMs = frame.end_ms;
      if (nextStartMs !== null && clearMs >= nextStartMs) {
        clearMs = nextStartMs - 1; // 1 ms before next show PTS
      }
      const segs = buildClearSegments(clearMs, this.#comp, this.#canvasWidth, this.#canvasHeight);
      for (const seg of segs) this.#chunks.push(seg);
      this.#comp += 1;
      this.stats.clears += 1;
      this.#epochState = null; // clear breaks the epoch
    }

    this.#pending = null;
  }

  /** Flush the final pending frame and return the full .sup stream. */
  close(): Uint8Array {
    if (this.#pending !== null) this.#flushPending(null);
    let total = 0;
    for (const c of this.#chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this.#chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

// ── Region content key derivation ────────────────────────────────────

/** Map per-layer text to per-region content keys based on the actual
    region count.  For 1 region: a single combined key (top + bottom).
    For 2 regions: top region tracks `top_text`, bottom tracks
    `bottom_text`.  When the source text is unknown, fall back to a
    pixel-content fingerprint so identical-content frames still hit Skip
    in the epoch state machine. */
function deriveRegionKeys(
  regions: BoundedBitmap[],
  topText: string | undefined,
  bottomText: string | undefined,
): string[] {
  if (regions.length === 1) {
    if (topText !== undefined || bottomText !== undefined) {
      return [`combined:${topText ?? ""}|${bottomText ?? ""}|${regions[0].x},${regions[0].y}`];
    }
    return [pixelFingerprint(regions[0])];
  }
  // 2 regions.  Convention: regions are emitted in row order (top-down)
  // by splitRegions() — index 0 is the upper region, index 1 the lower.
  const topKey = topText !== undefined ? `top:${topText}|${regions[0].x},${regions[0].y}` : pixelFingerprint(regions[0]);
  const botKey = bottomText !== undefined ? `bot:${bottomText}|${regions[1].x},${regions[1].y}` : pixelFingerprint(regions[1]);
  return [topKey, botKey];
}

/** Cheap deterministic fingerprint of a region's RGBA buffer.  Sums a
    rolling hash over a stride-sampled subset of pixels — fast (skips
    the bulk of a 2M-pixel buffer) and good enough for change detection
    in the epoch state machine. */
function pixelFingerprint(bm: BoundedBitmap): string {
  let hash = 2166136261 >>> 0; // FNV-1a seed
  const stride = 16;
  for (let i = 0; i < bm.rgba.length; i += stride) {
    hash ^= bm.rgba[i];
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `pix:${bm.width}x${bm.height}@${bm.x},${bm.y}#${hash.toString(16)}`;
}
