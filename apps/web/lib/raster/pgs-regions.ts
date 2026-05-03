// Bounding-box crop + 2-region split for PGS bitmap encoding.
//
// Replaces the PIL.getbbox() / PIL.crop() / split_regions() flow from
// loom_core/rasterize/sup_writer.py.  Operates directly on packed RGBA
// buffers — no Image abstraction.
//
// A "region" is a tightly-cropped RGBA bitmap with its canvas-relative
// (x, y) offset.  PGS allows at most 2 regions (objects) per Display
// Set; the splitter detects a vertical gap of fully-transparent rows
// and emits 1 or 2 regions accordingly.

/** Minimum vertical gap (transparent rows) to trigger a 2-region split.
    Smaller gaps stay as one region — prevents splitting between romaji
    and the kanji line that follows it (typically 5–20 rows). */
const MIN_SPLIT_GAP = 50;

export interface BoundedBitmap {
  /** Tightly-cropped RGBA buffer, length = width * height * 4. */
  rgba: Uint8Array;
  width: number;
  height: number;
  /** Canvas-relative top-left offset. */
  x: number;
  y: number;
}

/** Compute the tight content bounds of a full-frame RGBA bitmap.
    Returns null if every pixel is transparent. */
export function computeBBox(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): { left: number; top: number; right: number; bottom: number } | null {
  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;

  // Scan top → first non-transparent row
  for (let row = 0; row < height; row++) {
    let rowHasContent = false;
    let rowMinX = width;
    let rowMaxX = -1;
    const base = row * width * 4;
    for (let col = 0; col < width; col++) {
      if (rgba[base + col * 4 + 3] !== 0) {
        rowHasContent = true;
        if (col < rowMinX) rowMinX = col;
        if (col > rowMaxX) rowMaxX = col;
      }
    }
    if (rowHasContent) {
      if (top === -1) top = row;
      bottom = row;
      if (rowMinX < left) left = rowMinX;
      if (rowMaxX > right) right = rowMaxX;
    }
  }

  if (top === -1) return null;
  // bbox is inclusive — return half-open right/bottom for crop convenience
  return { left, top, right: right + 1, bottom: bottom + 1 };
}

/** Crop a full-frame RGBA bitmap to a sub-rectangle and return a
    standalone BoundedBitmap. */
export function cropBitmap(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  _height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): BoundedBitmap {
  const w = right - left;
  const h = bottom - top;
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const srcStart = ((top + row) * width + left) * 4;
    const dstStart = row * w * 4;
    out.set(rgba.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return { rgba: out, width: w, height: h, x: left, y: top };
}

/** Convenience: bbox + crop in one call.  Returns null for empty bitmaps. */
export function cropToBBox(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): BoundedBitmap | null {
  const bbox = computeBBox(rgba, width, height);
  if (!bbox) return null;
  return cropBitmap(rgba, width, height, bbox.left, bbox.top, bbox.right, bbox.bottom);
}

// ── 2-region split ────────────────────────────────────────────────────

interface ContentBlock {
  start: number; // first content row (inclusive)
  end: number;   // last content row (exclusive)
}

/** Find contiguous blocks of rows that have at least one non-transparent
    pixel.  Returns blocks in row order. */
function findContentBlocks(bm: BoundedBitmap): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  let inBlock = false;
  let blockStart = 0;

  for (let row = 0; row < bm.height; row++) {
    const base = row * bm.width * 4;
    let rowHasContent = false;
    for (let col = 0; col < bm.width; col++) {
      if (bm.rgba[base + col * 4 + 3] !== 0) {
        rowHasContent = true;
        break;
      }
    }
    if (rowHasContent && !inBlock) {
      inBlock = true;
      blockStart = row;
    } else if (!rowHasContent && inBlock) {
      inBlock = false;
      blocks.push({ start: blockStart, end: row });
    }
  }
  if (inBlock) {
    blocks.push({ start: blockStart, end: bm.height });
  }
  return blocks;
}

/** Split a tightly-cropped bitmap into 1 or 2 vertically-separated
    regions.  Mirrors loom_core/rasterize/sup_writer.py::split_regions. */
export function splitRegions(
  bitmap: BoundedBitmap,
  canvasHeight: number,
  minGap: number = MIN_SPLIT_GAP,
): BoundedBitmap[] {
  if (bitmap.height < minGap * 2) {
    return [bitmap];
  }

  const blocks = findContentBlocks(bitmap);
  if (blocks.length <= 1) return [bitmap];

  // Find largest gap between consecutive blocks.
  let bestGapIdx = -1;
  let bestGap = 0;
  for (let i = 0; i < blocks.length - 1; i++) {
    const gap = blocks[i + 1].start - blocks[i].end;
    if (gap > bestGap) {
      bestGap = gap;
      bestGapIdx = i;
    }
  }
  if (bestGap < minGap || bestGapIdx === -1) return [bitmap];

  const splitTopEnd = blocks[bestGapIdx].end;
  const splitBotStart = blocks[bestGapIdx + 1].start;

  // Canvas-aware guard: gap midpoint must fall in the middle 50% of the
  // canvas, otherwise both clusters are in the same screen half and
  // should stay merged.  Mirrors the canvas_height guard in the Python.
  const gapMidCanvas = bitmap.y + (splitTopEnd + splitBotStart) / 2.0;
  const midLo = canvasHeight * 0.25;
  const midHi = canvasHeight * 0.75;
  if (gapMidCanvas < midLo || gapMidCanvas > midHi) {
    return [bitmap];
  }

  // Top region: blocks[0..bestGapIdx], bottom region: blocks[bestGapIdx+1..end]
  const topRowStart = blocks[0].start;
  const topRowEnd = splitTopEnd;
  const botRowStart = splitBotStart;
  const botRowEnd = blocks[blocks.length - 1].end;

  const out: BoundedBitmap[] = [];
  for (const [rowStart, rowEnd] of [[topRowStart, topRowEnd], [botRowStart, botRowEnd]]) {
    const subHeight = rowEnd - rowStart;
    // Vertical slice
    const slice = new Uint8Array(bitmap.width * subHeight * 4);
    for (let row = 0; row < subHeight; row++) {
      const srcStart = ((rowStart + row) * bitmap.width) * 4;
      const dstStart = row * bitmap.width * 4;
      slice.set(
        bitmap.rgba.subarray(srcStart, srcStart + bitmap.width * 4),
        dstStart,
      );
    }
    // Re-crop horizontally to tight content bounds within this slice.
    const subBBox = computeBBox(slice, bitmap.width, subHeight);
    if (!subBBox) continue;
    const tight = cropBitmap(
      slice, bitmap.width, subHeight,
      subBBox.left, subBBox.top, subBBox.right, subBBox.bottom,
    );
    out.push({
      rgba: tight.rgba,
      width: tight.width,
      height: tight.height,
      x: bitmap.x + subBBox.left,
      y: bitmap.y + rowStart + subBBox.top,
    });
  }

  if (out.length === 0) return [bitmap];
  return out;
}
