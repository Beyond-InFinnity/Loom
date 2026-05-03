// Median-cut palette quantization for PGS bitmap encoding.
//
// Replaces PIL.Image.quantize(method=2) from loom_core/rasterize/sup_writer.py.
// Subtitle bitmaps are extremely friendly to median-cut: typical content
// is white/colored text + outline + glow gradient against transparent —
// a few hundred unique RGB triples at most, even for 1080p frames.
//
// Algorithm:
//   1. Pre-pass: zero alpha for "barely-there" pixels (alpha < 8) to
//      prevent glow fringe from dragging cluster averages around.
//   2. Build a histogram of unique opaque RGBA tuples — this typically
//      collapses 2M pixels to <1k entries and makes everything downstream
//      cheap.
//   3. Recursively split the longest-axis box of unique colors at its
//      weighted median (by pixel count, not entry count) until we have
//      <= max_colors boxes.
//   4. Each box → one palette entry (weighted average RGBA).
//   5. Build a lookup map (color → palette index), then emit
//      per-pixel indices: 0 for transparent, 1..N for opaque.
//
// Output palette has 256 entries (PGS spec).  Index 0 is always
// (Y=16, Cb=128, Cr=128, A=0) i.e. fully transparent.

import { rgbToYCbCr } from "./pgs-segments";

/** A single palette entry stored in YCbCrA — the format the PDS writer
    consumes. */
export interface PaletteEntry {
  y: number;
  cb: number;
  cr: number;
  a: number;
}

export interface QuantizeResult {
  /** Per-pixel palette indices.  Length = width * height.
      Index 0 = transparent.  Indices 1..max_colors = opaque colors. */
  indices: Uint8Array;
  /** 256-entry palette in PGS format (Y, Cb, Cr, A). */
  palette: PaletteEntry[];
}

const ALPHA_CLAMP_THRESHOLD = 8;

/** Pack RGBA into a 32-bit key for histogram lookup.  Uses unsigned
    shift on the high byte so the result fits in a JS Number. */
function packRgba(r: number, g: number, b: number, a: number): number {
  return (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
}

function unpackRgba(key: number): [number, number, number, number] {
  return [
    (key >>> 24) & 0xFF,
    (key >>> 16) & 0xFF,
    (key >>> 8) & 0xFF,
    key & 0xFF,
  ];
}

/** Quantize an RGBA bitmap to at most `maxColors` opaque colors plus a
    reserved transparent slot at index 0.  `rgba` must be length
    `width * height * 4`. */
export function quantizeImage(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  maxColors: number = 255,
): QuantizeResult {
  const numPixels = width * height;
  if (rgba.length !== numPixels * 4) {
    throw new Error(`quantize: rgba length ${rgba.length} != width*height*4 (${numPixels * 4})`);
  }

  // ── Pass 1: alpha clamp + histogram of opaque colors ──────────────
  // We rebuild a working RGBA copy with low-alpha pixels zeroed.  This
  // mirrors the PIL pre-clamp in the Python reference and prevents glow
  // fringe pixels (alpha 1–7) from being clustered with opaque text.
  const work = new Uint8Array(rgba.length);
  work.set(rgba);

  // histogram: rgba-key → pixel count
  const hist = new Map<number, number>();
  for (let i = 0; i < numPixels; i++) {
    const off = i * 4;
    const a = work[off + 3];
    if (a === 0) continue;
    if (a < ALPHA_CLAMP_THRESHOLD) {
      work[off + 3] = 0;
      continue;
    }
    const key = packRgba(work[off], work[off + 1], work[off + 2], a);
    hist.set(key, (hist.get(key) ?? 0) + 1);
  }

  // ── Pass 2: median-cut ────────────────────────────────────────────
  const uniqueKeys = Array.from(hist.keys());
  const numUnique = uniqueKeys.length;

  // Trivial cases
  if (numUnique === 0) {
    // All-transparent image — emit pure transparent palette.
    const palette = newEmptyPalette();
    return { indices: new Uint8Array(numPixels), palette };
  }

  let boxes: Box[];
  if (numUnique <= maxColors) {
    // No need to quantize — every unique color gets its own palette entry.
    boxes = uniqueKeys.map((k) => {
      const [r, g, b, a] = unpackRgba(k);
      const count = hist.get(k)!;
      return {
        keys: [k],
        rMin: r, rMax: r,
        gMin: g, gMax: g,
        bMin: b, bMax: b,
        totalPixels: count,
      };
    });
  } else {
    boxes = medianCut(uniqueKeys, hist, maxColors);
  }

  // ── Pass 3: build palette + lookup map ────────────────────────────
  // Index 0 = transparent (per PGS convention).  Opaque colors start at 1.
  const palette = newEmptyPalette();
  const colorToIndex = new Map<number, number>();

  boxes.forEach((box, i) => {
    const idx = i + 1;
    const avg = boxAverage(box, hist);
    const [y, cb, cr] = rgbToYCbCr(avg.r, avg.g, avg.b);
    palette[idx] = { y, cb, cr, a: avg.a };
    for (const k of box.keys) {
      colorToIndex.set(k, idx);
    }
  });

  // ── Pass 4: per-pixel index assignment ────────────────────────────
  const indices = new Uint8Array(numPixels);
  for (let i = 0; i < numPixels; i++) {
    const off = i * 4;
    const a = work[off + 3];
    if (a === 0) {
      indices[i] = 0;
      continue;
    }
    const key = packRgba(work[off], work[off + 1], work[off + 2], a);
    indices[i] = colorToIndex.get(key) ?? 0;
  }

  return { indices, palette };
}

function newEmptyPalette(): PaletteEntry[] {
  const palette: PaletteEntry[] = new Array(256);
  for (let i = 0; i < 256; i++) {
    palette[i] = { y: 16, cb: 128, cr: 128, a: 0 };
  }
  return palette;
}

// ── Median-cut implementation ──────────────────────────────────────────

interface Box {
  keys: number[]; // packed RGBA keys belonging to this box
  rMin: number;
  rMax: number;
  gMin: number;
  gMax: number;
  bMin: number;
  bMax: number;
  totalPixels: number;
}

function buildBox(keys: number[], hist: Map<number, number>): Box {
  let rMin = 255, rMax = 0;
  let gMin = 255, gMax = 0;
  let bMin = 255, bMax = 0;
  let total = 0;
  for (const k of keys) {
    const [r, g, b] = unpackRgba(k);
    if (r < rMin) rMin = r; if (r > rMax) rMax = r;
    if (g < gMin) gMin = g; if (g > gMax) gMax = g;
    if (b < bMin) bMin = b; if (b > bMax) bMax = b;
    total += hist.get(k)!;
  }
  return { keys, rMin, rMax, gMin, gMax, bMin, bMax, totalPixels: total };
}

function boxLongestAxis(box: Box): "r" | "g" | "b" {
  const dr = box.rMax - box.rMin;
  const dg = box.gMax - box.gMin;
  const db = box.bMax - box.bMin;
  if (dr >= dg && dr >= db) return "r";
  if (dg >= db) return "g";
  return "b";
}

function boxLongestExtent(box: Box): number {
  return Math.max(
    box.rMax - box.rMin,
    box.gMax - box.gMin,
    box.bMax - box.bMin,
  );
}

/** Split a box at the weighted median along its longest axis.  Returns
    two new boxes, or null if the split is degenerate (one side empty). */
function splitBox(box: Box, hist: Map<number, number>): [Box, Box] | null {
  if (box.keys.length < 2) return null;
  const axis = boxLongestAxis(box);
  const channelOf = (key: number): number => {
    if (axis === "r") return (key >>> 24) & 0xFF;
    if (axis === "g") return (key >>> 16) & 0xFF;
    return (key >>> 8) & 0xFF;
  };

  // Sort keys by axis value.  N is small (one box's unique colors), so
  // a basic comparator sort is fine.
  const sortedKeys = [...box.keys].sort((a, b) => channelOf(a) - channelOf(b));

  // Find the weighted median: smallest prefix whose pixel-count sum
  // exceeds half the total.  This biases the split toward the side with
  // more pixels, producing smaller error than entry-count median.
  const half = box.totalPixels / 2;
  let acc = 0;
  let splitIdx = 0;
  for (let i = 0; i < sortedKeys.length; i++) {
    acc += hist.get(sortedKeys[i])!;
    if (acc >= half) {
      splitIdx = i + 1;
      break;
    }
  }
  // Guard degenerate split (all weight on one side).
  if (splitIdx === 0 || splitIdx >= sortedKeys.length) {
    splitIdx = Math.max(1, Math.min(sortedKeys.length - 1, Math.floor(sortedKeys.length / 2)));
  }

  const leftKeys = sortedKeys.slice(0, splitIdx);
  const rightKeys = sortedKeys.slice(splitIdx);
  if (leftKeys.length === 0 || rightKeys.length === 0) return null;

  return [buildBox(leftKeys, hist), buildBox(rightKeys, hist)];
}

/** Run median-cut until we have `targetCount` boxes (or no further split
    is possible).  Always splits the box with the largest extent on its
    longest axis. */
function medianCut(uniqueKeys: number[], hist: Map<number, number>, targetCount: number): Box[] {
  let boxes: Box[] = [buildBox(uniqueKeys, hist)];

  while (boxes.length < targetCount) {
    // Find the splittable box with largest extent.
    let bestIdx = -1;
    let bestExtent = 0;
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].keys.length < 2) continue;
      const ext = boxLongestExtent(boxes[i]);
      if (ext > bestExtent) {
        bestExtent = ext;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break; // every box is 1 color — done

    const split = splitBox(boxes[bestIdx], hist);
    if (split === null) {
      // This box can't be split (e.g. all keys identical on every axis
      // despite being separate entries — degenerate but possible).  Mark
      // it as un-splittable by removing it from candidates.
      boxes[bestIdx] = { ...boxes[bestIdx], keys: [boxes[bestIdx].keys[0]] };
      continue;
    }
    boxes.splice(bestIdx, 1, split[0], split[1]);
  }

  return boxes;
}

interface AvgColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Compute the pixel-count-weighted average color of a box. */
function boxAverage(box: Box, hist: Map<number, number>): AvgColor {
  let sumR = 0, sumG = 0, sumB = 0, sumA = 0, totalCount = 0;
  for (const k of box.keys) {
    const [r, g, b, a] = unpackRgba(k);
    const count = hist.get(k)!;
    sumR += r * count;
    sumG += g * count;
    sumB += b * count;
    sumA += a * count;
    totalCount += count;
  }
  if (totalCount === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: Math.round(sumR / totalCount),
    g: Math.round(sumG / totalCount),
    b: Math.round(sumB / totalCount),
    a: Math.round(sumA / totalCount),
  };
}
