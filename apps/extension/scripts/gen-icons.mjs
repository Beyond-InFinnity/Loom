// Placeholder icon generator for the Loom extension's dev/prod build split.
//
//   node scripts/gen-icons.mjs   (or: npm run icons)
//
// Emits public/icons/{prod,dev}/{16,32,48,96,128}.png — a rounded-square mark
// with a simple woven-thread motif. Prod = indigo, Dev = amber + a red corner
// dot so the two install side-by-side and are distinguishable at a glance.
//
// These are intentional PLACEHOLDERS (pure-Node PNGs, no design tooling) so
// the build-split mechanism is testable now. Replace with real art at the
// "Icon set" polish step in PUBLISH_PLAN.md; keep the same paths and this
// wiring works unchanged.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SIZES = [16, 32, 48, 96, 128];
const VARIANTS = {
  prod: { bg: [79, 70, 229], thread: [224, 231, 255], dot: null },
  dev: { bg: [217, 119, 6], thread: [255, 247, 237], dot: [239, 68, 68] },
};

// ── minimal PNG encoder (RGBA, no filtering) ────────────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); // filter byte 0
  }
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── the mark ────────────────────────────────────────────────────────────────
function render(size, { bg, thread, dot }) {
  const w = size;
  const rgba = Buffer.alloc(w * w * 4); // zero-init = fully transparent
  const radius = Math.max(2, Math.round(size * 0.22));
  const bar = Math.max(1, Math.round(size * 0.08));
  const threadAt = [0.32, 0.64].map((f) => Math.round(size * f));
  const isThread = (p) => threadAt.some((c) => Math.abs(p - c) <= bar / 2);

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, radius), w - 1 - radius);
    const cy = Math.min(Math.max(y, radius), w - 1 - radius);
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius;
  };

  const dotR = dot ? Math.max(2, Math.round(size * 0.17)) : 0;
  const dcx = w - 1 - dotR;
  const dcy = dotR;

  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      if (!inRounded(x, y)) continue;
      const i = (y * w + x) * 4;
      const col = isThread(x) || isThread(y) ? thread : bg;
      rgba[i] = col[0];
      rgba[i + 1] = col[1];
      rgba[i + 2] = col[2];
      rgba[i + 3] = 255;
      if (dot) {
        const dx = x - dcx;
        const dy = y - dcy;
        if (dx * dx + dy * dy <= dotR * dotR) {
          rgba[i] = dot[0];
          rgba[i + 1] = dot[1];
          rgba[i + 2] = dot[2];
          rgba[i + 3] = 255;
        }
      }
    }
  }
  return encodePng(w, w, rgba);
}

const base = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "icons");
for (const [variant, spec] of Object.entries(VARIANTS)) {
  const dir = join(base, variant);
  mkdirSync(dir, { recursive: true });
  for (const size of SIZES) writeFileSync(join(dir, `${size}.png`), render(size, spec));
  console.log(`wrote ${SIZES.length} icons → public/icons/${variant}/`);
}
