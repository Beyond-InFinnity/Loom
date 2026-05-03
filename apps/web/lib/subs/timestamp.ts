// Timestamp parse/format helpers for SRT and ASS formats.  Both store
// times in their own string conventions; the SSAFile model uses
// integer milliseconds throughout.

/** Parse an ASS timestamp ("H:MM:SS.cs", centiseconds) → ms. */
export function parseAssTimestamp(ts: string): number {
  // ASS uses single-digit hours, two-digit min/sec, two-digit cs.
  const m = ts.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) throw new Error(`Bad ASS timestamp: ${JSON.stringify(ts)}`);
  const [, hStr, mStr, sStr, fracStr] = m;
  const h = parseInt(hStr, 10);
  const min = parseInt(mStr, 10);
  const s = parseInt(sStr, 10);
  // ASS centiseconds (2 digits) — pad to ms (multiply by 10).  SRT uses
  // 3-digit ms; same parser handles both via the regex tolerating 1–3 digits.
  let frac = parseInt(fracStr, 10);
  if (fracStr.length === 1) frac *= 100;
  else if (fracStr.length === 2) frac *= 10;
  return h * 3_600_000 + min * 60_000 + s * 1_000 + frac;
}

/** Format ms → ASS timestamp "H:MM:SS.cs" (centiseconds). */
export function formatAssTimestamp(totalMs: number): string {
  if (totalMs < 0) totalMs = 0;
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  // Round to centiseconds (ASS resolution).  pysubs2 truncates;
  // we round-half-up so a 999ms event doesn't end at 0.99s.
  const cs = Math.round(ms / 10);
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`;
}

/** Parse an SRT timestamp ("HH:MM:SS,mmm") → ms. */
export function parseSrtTimestamp(ts: string): number {
  const m = ts.trim().match(/^(\d+):(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!m) throw new Error(`Bad SRT timestamp: ${JSON.stringify(ts)}`);
  const [, h, min, s, ms] = m;
  return parseInt(h, 10) * 3_600_000
       + parseInt(min, 10) * 60_000
       + parseInt(s, 10) * 1_000
       + parseInt(ms, 10);
}

function pad(n: number, width: number): string {
  return n.toString().padStart(width, "0");
}
