// PGS (Presentation Graphic Stream) segment writers + RLE encoder + color
// conversion.  Port of the byte-level primitives from
// loom_core/rasterize/sup_writer.py — every constant + struct layout
// mirrors that file so the desktop's .sup output and ours stay
// bit-compatible (modulo pixel quantization, which differs because we
// don't have PIL's median-cut).
//
// All multi-byte integers are big-endian.  Segment header is:
//   2 bytes "PG" magic
//   4 bytes PTS (uint32, 90 kHz clock)
//   4 bytes DTS (uint32, always 0)
//   1 byte  segment type
//   2 bytes payload size (uint16)
//   N bytes payload

// ── Segment type constants ──────────────────────────────────────────────
export const SEG_PCS = 0x16; // Presentation Composition Segment
export const SEG_WDS = 0x17; // Window Definition Segment
export const SEG_PDS = 0x14; // Palette Definition Segment
export const SEG_ODS = 0x15; // Object Definition Segment
export const SEG_END = 0x80; // End of Display Set

// PCS composition_state values
export const COMP_EPOCH_START = 0x80;
export const COMP_NORMAL = 0x00;
export const COMP_ACQUISITION_POINT = 0x40;

/** Emit Acquisition Point every N display sets so a player seeking
    mid-stream can pick up the full state from a recent reference. */
export const AP_INTERVAL = 12;

const PG_MAGIC = [0x50, 0x47]; // "PG"

// ── Color conversion ────────────────────────────────────────────────────

/** Convert RGB to YCbCr using BT.601 full-range — inverse of the
    decoder in loom_core/video/ocr.py.  No studio-range offsets. */
export function rgbToYCbCr(r: number, g: number, b: number): [number, number, number] {
  const y = clamp255(Math.round(0.299 * r + 0.587 * g + 0.114 * b));
  const cb = clamp255(Math.round(-0.169 * r - 0.331 * g + 0.500 * b + 128));
  const cr = clamp255(Math.round(0.500 * r - 0.419 * g - 0.081 * b + 128));
  return [y, cb, cr];
}

function clamp255(n: number): number {
  return n < 0 ? 0 : n > 255 ? 255 : n;
}

// ── RLE encoding ────────────────────────────────────────────────────────
//
// PGS RLE opcodes (per Blu-ray spec):
//   color != 0, run == 1               → [color]
//   color == 0, run < 64               → [0x00, run]
//   color == 0, run >= 64              → [0x00, 0x40 | (run>>8), run & 0xFF]
//   color != 0, run < 64               → [0x00, 0x80 | run, color]
//   color != 0, run >= 64              → [0x00, 0xC0 | (run>>8), run & 0xFF, color]
// Each row terminated with [0x00, 0x00].
// Max run length is 16383 (14-bit).

const MAX_RUN = 16383;

/** RLE-encode one row of palette indices into PGS opcodes. */
function encodeRleRow(row: Uint8Array, out: number[]): void {
  const width = row.length;
  if (width === 0) {
    out.push(0x00, 0x00);
    return;
  }

  let col = 0;
  while (col < width) {
    const color = row[col];
    let run = 1;
    while (col + run < width && row[col + run] === color && run < MAX_RUN) {
      run += 1;
    }

    if (color === 0) {
      if (run < 64) {
        out.push(0x00, run & 0x3F);
      } else {
        out.push(0x00, 0x40 | ((run >> 8) & 0x3F), run & 0xFF);
      }
    } else {
      if (run === 1) {
        out.push(color);
      } else if (run < 64) {
        out.push(0x00, 0x80 | (run & 0x3F), color);
      } else {
        out.push(0x00, 0xC0 | ((run >> 8) & 0x3F), run & 0xFF, color);
      }
    }
    col += run;
  }

  out.push(0x00, 0x00);
}

/** RLE-encode a full bitmap of palette indices.  `indices.length` must
    equal `width * height`.  Returns the encoded PGS bitmap data. */
export function encodeRle(indices: Uint8Array, width: number, height: number): Uint8Array {
  // Use number[] as an append-only buffer; convert once at the end.  Pre-size
  // is hard to estimate (RLE compresses ~10–100×), so dynamic growth is fine.
  const buf: number[] = [];
  for (let row = 0; row < height; row++) {
    const slice = indices.subarray(row * width, (row + 1) * width);
    encodeRleRow(slice, buf);
  }
  return new Uint8Array(buf);
}

// ── Byte writer helpers ─────────────────────────────────────────────────

/** Concatenate Uint8Arrays into one buffer.  Used to assemble payloads
    + final segment bytes. */
export function concatBytes(parts: (Uint8Array | number[])[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    if (p instanceof Uint8Array) {
      out.set(p, off);
      off += p.length;
    } else {
      for (let i = 0; i < p.length; i++) out[off + i] = p[i];
      off += p.length;
    }
  }
  return out;
}

function u16BE(n: number): [number, number] {
  return [(n >> 8) & 0xFF, n & 0xFF];
}

function u32BE(n: number): [number, number, number, number] {
  // Use unsigned shift to avoid sign-extension on values >= 2^31.
  return [
    (n >>> 24) & 0xFF,
    (n >>> 16) & 0xFF,
    (n >>> 8) & 0xFF,
    n & 0xFF,
  ];
}

// ── Segment header + payload builders ───────────────────────────────────

/** Wrap a payload in a PGS segment header. */
export function makeSegment(segType: number, pts90khz: number, payload: Uint8Array): Uint8Array {
  const payloadLen = payload.length;
  if (payloadLen > 0xFFFF) {
    throw new Error(`pgs segment payload too large: ${payloadLen} > 65535`);
  }
  // Header = 13 bytes
  const header = new Uint8Array(13);
  header[0] = PG_MAGIC[0];
  header[1] = PG_MAGIC[1];
  const [p0, p1, p2, p3] = u32BE(pts90khz >>> 0);
  header[2] = p0; header[3] = p1; header[4] = p2; header[5] = p3;
  // DTS = 0
  header[6] = 0; header[7] = 0; header[8] = 0; header[9] = 0;
  header[10] = segType;
  header[11] = (payloadLen >> 8) & 0xFF;
  header[12] = payloadLen & 0xFF;
  return concatBytes([header, payload]);
}

export interface PcsObjectRef {
  object_id: number;
  window_id: number;
  x: number;
  y: number;
  crop_flag: number; // always 0 in our writer
}

/** Build the Presentation Composition Segment payload. */
export function makePcs(
  canvasWidth: number,
  canvasHeight: number,
  compNumber: number,
  compState: number,
  paletteUpdate: boolean,
  paletteId: number,
  objects: PcsObjectRef[],
): Uint8Array {
  const buf: number[] = [];
  buf.push(...u16BE(canvasWidth));
  buf.push(...u16BE(canvasHeight));
  buf.push(0x10); // Frame rate marker (23.976 fps — most decoders ignore)
  buf.push(...u16BE(compNumber & 0xFFFF));
  buf.push(compState);
  buf.push(paletteUpdate ? 0x80 : 0x00);
  buf.push(paletteId);
  buf.push(objects.length);
  for (const o of objects) {
    buf.push(...u16BE(o.object_id));
    buf.push(o.window_id);
    buf.push(o.crop_flag);
    buf.push(...u16BE(o.x));
    buf.push(...u16BE(o.y));
  }
  return new Uint8Array(buf);
}

export interface WdsWindow {
  window_id: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Build the Window Definition Segment payload. */
export function makeWds(windows: WdsWindow[]): Uint8Array {
  const buf: number[] = [];
  buf.push(windows.length);
  for (const w of windows) {
    buf.push(w.window_id);
    buf.push(...u16BE(w.x));
    buf.push(...u16BE(w.y));
    buf.push(...u16BE(w.width));
    buf.push(...u16BE(w.height));
  }
  return new Uint8Array(buf);
}

/** PDS palette entry — note Cr/Cb order matches PGS spec, which is
    swapped relative to the (Y, Cb, Cr, A) tuples we carry internally. */
export interface PdsEntry {
  index: number;
  y: number;
  cr: number;
  cb: number;
  alpha: number;
}

/** Build the Palette Definition Segment payload. */
export function makePds(paletteId: number, paletteVersion: number, entries: PdsEntry[]): Uint8Array {
  const buf: number[] = [];
  buf.push(paletteId);
  buf.push(paletteVersion);
  for (const e of entries) {
    buf.push(e.index, e.y, e.cr, e.cb, e.alpha);
  }
  return new Uint8Array(buf);
}

// ── ODS fragmentation ───────────────────────────────────────────────────
//
// PGS segment payload is a uint16 (max 65535 bytes).  Full-frame bitmaps
// at 1080p+ routinely overflow this, so a single object can span multiple
// ODS segments: the first carries the total data length + dimensions;
// continuation fragments carry only raw RLE chunks.

const MAX_SEG_PAYLOAD = 65535;
const ODS_FIRST_OVERHEAD = 11; // obj_id(2) + ver(1) + seq(1) + data_len(3) + w(2) + h(2)
const ODS_CONT_OVERHEAD = 4;   // obj_id(2) + ver(1) + seq(1)

/** Build one or more ODS segments for a single object, fragmenting if
    the RLE payload would exceed the per-segment uint16 limit. */
export function buildOdsSegments(
  objectId: number,
  version: number,
  width: number,
  height: number,
  rleData: Uint8Array,
  pts90khz: number,
): Uint8Array[] {
  const totalFirstPayload = ODS_FIRST_OVERHEAD + rleData.length;

  if (totalFirstPayload <= MAX_SEG_PAYLOAD) {
    return [makeSegment(SEG_ODS, pts90khz, makeOdsSingle(objectId, version, width, height, rleData))];
  }

  // Multi-fragment path
  const segments: Uint8Array[] = [];
  const firstRleMax = MAX_SEG_PAYLOAD - ODS_FIRST_OVERHEAD;
  const contRleMax = MAX_SEG_PAYLOAD - ODS_CONT_OVERHEAD;

  const firstChunk = rleData.subarray(0, firstRleMax);
  const remaining = rleData.subarray(firstRleMax);

  // First fragment: 0x80 = first, not last
  const firstPayload: number[] = [];
  firstPayload.push(...u16BE(objectId));
  firstPayload.push(version);
  firstPayload.push(0x80);
  const objDataLen = rleData.length + 4; // includes width + height bytes
  firstPayload.push((objDataLen >> 16) & 0xFF);
  firstPayload.push((objDataLen >> 8) & 0xFF);
  firstPayload.push(objDataLen & 0xFF);
  firstPayload.push(...u16BE(width));
  firstPayload.push(...u16BE(height));
  segments.push(makeSegment(SEG_ODS, pts90khz, concatBytes([new Uint8Array(firstPayload), firstChunk])));

  // Continuation fragments
  let offset = 0;
  while (offset < remaining.length) {
    const chunkEnd = Math.min(offset + contRleMax, remaining.length);
    const isLast = chunkEnd === remaining.length;
    const chunk = remaining.subarray(offset, chunkEnd);

    const contHeader: number[] = [];
    contHeader.push(...u16BE(objectId));
    contHeader.push(version);
    contHeader.push(isLast ? 0x40 : 0x00);
    segments.push(makeSegment(SEG_ODS, pts90khz, concatBytes([new Uint8Array(contHeader), chunk])));
    offset = chunkEnd;
  }

  return segments;
}

function makeOdsSingle(
  objectId: number,
  version: number,
  width: number,
  height: number,
  rleData: Uint8Array,
): Uint8Array {
  const header: number[] = [];
  header.push(...u16BE(objectId));
  header.push(version);
  // 0xC0 = first + last (single fragment)
  header.push(0xC0);
  const objDataLen = rleData.length + 4;
  header.push((objDataLen >> 16) & 0xFF);
  header.push((objDataLen >> 8) & 0xFF);
  header.push(objDataLen & 0xFF);
  header.push(...u16BE(width));
  header.push(...u16BE(height));
  return concatBytes([new Uint8Array(header), rleData]);
}
