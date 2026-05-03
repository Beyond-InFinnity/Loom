// ASS color encoding: stored as `&HAABBGGRR` (8 hex chars, byte-reversed
// from CSS #RRGGBB, alpha INVERTED — 00 = opaque, FF = transparent).
//
// pysubs2 also accepts decimal forms; we only emit/accept the &H form
// since that's what every ASS file in the wild uses.

import type { Color } from "./types";

/** Parse "&HAABBGGRR" or "&HBBGGRR" (alpha defaults to 0/opaque) → Color. */
export function parseAssColor(s: string): Color {
  const trimmed = s.trim().replace(/^&H/i, "").replace(/&$/, "");
  if (!/^[0-9a-f]+$/i.test(trimmed)) {
    throw new Error(`Bad ASS color: ${JSON.stringify(s)}`);
  }
  // Pad short values (some files use abbreviated form).
  const hex = trimmed.padStart(8, "0").toLowerCase();
  if (hex.length !== 8) throw new Error(`Bad ASS color length: ${JSON.stringify(s)}`);
  const a = parseInt(hex.slice(0, 2), 16);
  const b = parseInt(hex.slice(2, 4), 16);
  const g = parseInt(hex.slice(4, 6), 16);
  const r = parseInt(hex.slice(6, 8), 16);
  return { r, g, b, a };
}

/** Format Color → "&HAABBGGRR&" (the trailing & is conventional in
    ASS Style lines but optional; we emit it for ASS-tooling parity). */
export function formatAssColor(c: Color): string {
  return `&H${hex(c.a)}${hex(c.b)}${hex(c.g)}${hex(c.r)}`;
}

function hex(n: number): string {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();
}
