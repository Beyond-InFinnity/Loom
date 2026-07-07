// Passive caption-position probe (DEV BUILDS ONLY).
//
// A DIAGNOSTIC that is deliberately DECOUPLED from Loom's activation: it
// runs even when the pill is off / dormant, does nothing but READ the DOM,
// and emits a copy-pasteable snapshot whenever the video is paused (or on
// the Ctrl+Shift+L hotkey).  Its job is to build the render↔data
// correspondence we need before designing multi-cue / positioned / vertical
// subtitle handling:
//
//   pause → the probe logs every caption CUE currently on screen, keyed by
//   the exact `currentTime` → you save a screenshot of that frame → paste
//   both.  Across a handful of frames (two speakers, a positioned sign,
//   vertical NERV captions, italic/emphasis/sized runs, an English track)
//   this reveals how the source's positional AND typographic data actually
//   renders, so Loom can preserve it rather than flatten it.
//
// It measures the RENDER, not the source, so it sidesteps the "dialogue vs
// description" classification (it reports where the text really is + how it's
// styled).  Nothing found on a frame that visibly has captions = the
// informative negative: captions are painted to canvas → we need the TTML
// source path instead.
//
// What each cue reports (the 2026-07-07 extension):
//   - text, zone (top/mid/bottom × left/center/right), orientation (vertical
//     vs horizontal), position %, size, colour, box background;
//   - INLINE RUNS: sub-fragments whose typography differs from the cue base
//     — italic (off-screen / emphasis), font-size deltas (shouting / small),
//     text-emphasis dots (圏点), weight — i.e. the aesthetic detail we must
//     preserve when we add a second language.
//
// Zero effect on prod: the whole install is gated on IS_DEV, so Vite
// dead-code-eliminates it from production bundles.

import { IS_DEV } from "../env";
import { resolvePrimePlayerSurface } from "./prime-player-anchor";

interface Invalidatable {
  onInvalidated(cb: () => void): void;
}

/** The CONFIRMED Prime caption text element (live 2026-07-07):
    `span.atvwebplayersdk-captions-text`.  Matching this gives ONE entry per
    logical cue (its glyph/word children are descendants), so we don't drown
    in per-character spans.  The `-text`/`-window` variants + generic
    caption/subtitle keep it robust if Prime renames or on other platforms. */
const CAPTION_UNIT_SELECTOR =
  '[class*="captions-text" i],[class*="caption-text" i],[class*="subtitle-text" i],[class*="captions-window" i]';

/** Class substrings marking player CHROME — used only by the heuristic
    FALLBACK scan (when no real caption element is found), so band text from
    the UI doesn't masquerade as a caption. */
const CONTROL_TOKENS = [
  "seekbar", "scrubber", "timeindicator", "time-indicator", "controls",
  "button", "btn", "title", "toast", "loading", "tooltip", "menu",
  "settings", "nexttitle", "header", "rating", "overlay-info", "synopsis",
  "genres", "node-dp",
];

const CAPTION_RE = /caption|subtitle|timedtext|dialog/i;

export function installCaptionPauseProbe(ctx: Invalidatable): void {
  if (!IS_DEV) return;

  const onPause = (e: Event): void => {
    const v = e.target;
    if (v instanceof HTMLVideoElement) snapshot(v, "pause");
  };
  // `pause` does NOT bubble, but it still traverses the CAPTURE phase from
  // document down to the target — so one capturing listener catches pause on
  // whichever <video> Prime is currently playing, no per-element rebinding.
  document.addEventListener("pause", onPause, true);

  const onKey = (e: KeyboardEvent): void => {
    // Ctrl+Shift+L — snapshot WITHOUT pausing (some players reposition
    // captions when the control chrome appears on pause).
    if (e.ctrlKey && e.shiftKey && (e.key === "L" || e.key === "l")) {
      const v = resolveProbeVideo();
      if (v) snapshot(v, "hotkey");
    }
  };
  document.addEventListener("keydown", onKey, true);

  console.info(
    "[Loom PROBE] passive caption probe armed — pause the video (or Ctrl+Shift+L) to snapshot caption cues + typography.",
  );

  ctx.onInvalidated(() => {
    document.removeEventListener("pause", onPause, true);
    document.removeEventListener("keydown", onKey, true);
  });
}

function resolveProbeVideo(): HTMLVideoElement | null {
  const surface = resolvePrimePlayerSurface();
  const inSurface = surface?.querySelector<HTMLVideoElement>("video");
  if (inSurface) return inSurface;
  for (const v of document.querySelectorAll<HTMLVideoElement>("video")) {
    if (Number.isFinite(v.duration) && v.duration > 0) return v;
  }
  return document.querySelector<HTMLVideoElement>("video");
}

// ---- Snapshot -------------------------------------------------------------

function snapshot(video: HTMLVideoElement, trigger: string): void {
  const surface = resolvePrimePlayerSurface();
  const player =
    surface?.getBoundingClientRect() ??
    new DOMRect(0, 0, window.innerWidth, window.innerHeight);

  const lines: string[] = [];
  lines.push(`===== LOOM PAUSE SNAPSHOT (${trigger}) =====`);
  lines.push(
    `video: t=${video.currentTime.toFixed(2)}s  dur=${
      Number.isFinite(video.duration) ? Math.round(video.duration) : "NaN"
    }s  paused=${video.paused}  intrinsic=${video.videoWidth}x${video.videoHeight}`,
  );
  lines.push(
    `player: ${Math.round(player.width)}x${Math.round(player.height)} @ viewport(${Math.round(
      player.left,
    )},${Math.round(player.top)})`,
  );

  const units = collectCaptionUnits(player);
  if (units.length > 0) {
    lines.push(
      `caption cues: ${units.length}  |  zones: ${units
        .map((u) => `${u.zone}/${u.orient}`)
        .join("  ·  ")}`,
    );
    for (const u of units) {
      lines.push(cueLine(u, player));
      for (const r of u.runs) lines.push(`      run ${r}`);
    }
  } else {
    const generic = collectGeneric(player);
    lines.push(`caption-like elements (heuristic fallback): ${generic.length}`);
    if (generic.length === 0) {
      lines.push(
        "  (none — if captions ARE visible in your screenshot, Prime is painting",
      );
      lines.push(
        "   them to a canvas/unreadable surface → we need the TTML-source path.)",
      );
    }
    for (const c of generic) lines.push(genericLine(c, player));
  }
  lines.push("=======================================");
  console.info(lines.join("\n"));
}

// ---- Caption-cue pass (primary) -------------------------------------------

interface CaptionUnit {
  el: HTMLElement;
  rect: DOMRect;
  text: string;
  zone: string;
  orient: "vertical" | "horizontal";
  wm: string;
  align: string;
  color: string;
  bg: string;
  fontPx: string;
  /** Human-readable descriptions of inline sub-runs whose typography
      differs from the cue base (italic / size / emphasis / weight).  Empty
      when the cue is typographically uniform. */
  runs: string[];
}

function collectCaptionUnits(player: DOMRect): CaptionUnit[] {
  const raw = Array.from(
    document.querySelectorAll<HTMLElement>(CAPTION_UNIT_SELECTOR),
  ).filter((el) => {
    if (el.closest("loom-overlay-root")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (!intersects(r, player)) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") {
      return false;
    }
    return (el.textContent?.trim().length ?? 0) > 0;
  });

  // De-nest: if one matched element contains another matched element, keep
  // the INNERMOST (the actual text span), drop the wrapper.
  const inner = raw.filter((el) => !raw.some((o) => o !== el && el.contains(o)));

  return inner.map((el) => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const orient: CaptionUnit["orient"] = /vertical/.test(cs.writingMode)
      ? "vertical"
      : "horizontal";
    return {
      el,
      rect,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
      zone: zoneOf(rect, player),
      orient,
      wm: cs.writingMode,
      align: cs.textAlign,
      color: cs.color,
      bg: cs.backgroundColor,
      fontPx: cs.fontSize,
      runs: describeRuns(el, cs),
    };
  });
}

/** Break a cue into inline runs and report only the ones whose typography
    DIFFERS from the cue base — italic, font-size delta, emphasis dots,
    bold.  Uniform cues (incl. per-glyph vertical text that all shares one
    style) return []. */
function describeRuns(unit: HTMLElement, baseCs: CSSStyleDeclaration): string[] {
  const base = styleSig(baseCs);

  // Leaf fragments = elements with DIRECT text (the glyph/word spans).  If
  // none, the text is direct on the unit → single run == base → uniform.
  const leaves = Array.from(unit.querySelectorAll<HTMLElement>("*")).filter(
    (el) => directTextOf(el).length > 0,
  );
  if (leaves.length === 0) return [];

  // Coalesce consecutive leaves with an identical signature (document order).
  interface Run {
    sig: Sig;
    text: string;
  }
  const runs: Run[] = [];
  for (const el of leaves) {
    const sig = styleSig(getComputedStyle(el));
    const txt = directTextOf(el);
    const last = runs[runs.length - 1];
    if (last && sameSig(last.sig, sig)) last.text += txt;
    else runs.push({ sig, text: txt });
  }

  const out: string[] = [];
  for (const r of runs) {
    if (sameSig(r.sig, base)) continue; // uninteresting: matches cue base
    out.push(`"${truncate(r.text, 32)}"  ${sigDelta(r.sig, base)}`);
  }
  return out;
}

// ---- Style signatures -----------------------------------------------------

interface Sig {
  italic: boolean;
  bold: boolean;
  sizePx: number;
  emphasis: string; // "" when none
  color: string;
}

function styleSig(cs: CSSStyleDeclaration): Sig {
  const weight = parseInt(cs.fontWeight, 10);
  return {
    italic: cs.fontStyle === "italic" || cs.fontStyle === "oblique",
    bold: Number.isFinite(weight) ? weight >= 600 : cs.fontWeight === "bold",
    sizePx: Math.round(parseFloat(cs.fontSize) || 0),
    emphasis: emphasisOf(cs),
    color: cs.color,
  };
}

function sameSig(a: Sig, b: Sig): boolean {
  return (
    a.italic === b.italic &&
    a.bold === b.bold &&
    a.sizePx === b.sizePx &&
    a.emphasis === b.emphasis &&
    a.color === b.color
  );
}

/** Compact description of how `s` differs from cue base `b`. */
function sigDelta(s: Sig, b: Sig): string {
  const bits: string[] = [];
  if (s.italic !== b.italic) bits.push(s.italic ? "italic" : "upright");
  if (s.bold !== b.bold) bits.push(s.bold ? "bold" : "normal-wt");
  if (s.sizePx !== b.sizePx) bits.push(`size=${s.sizePx}px(base ${b.sizePx})`);
  if (s.emphasis !== b.emphasis && s.emphasis) bits.push(`emphasis=${s.emphasis}`);
  if (s.color !== b.color) bits.push(`color=${s.color}`);
  return bits.join(" ") || "differs";
}

/** text-emphasis (圏点) — "" when none.  Uses getPropertyValue so an
    unsupported property is a safe empty string, not a throw. */
function emphasisOf(cs: CSSStyleDeclaration): string {
  const style =
    cs.getPropertyValue("text-emphasis-style") ||
    cs.getPropertyValue("-webkit-text-emphasis-style");
  const s = style.trim();
  if (!s || s === "none") return "";
  const color =
    cs.getPropertyValue("text-emphasis-color") ||
    cs.getPropertyValue("-webkit-text-emphasis-color");
  return color.trim() ? `${s}/${color.trim()}` : s;
}

// ---- Heuristic fallback pass (only when no caption element found) ---------

interface Generic {
  tier: "vert" | "cap-class" | "band";
  rect: DOMRect;
  text: string;
  wm: string;
  align: string;
  font: string;
  color: string;
  classChain: string;
}

function collectGeneric(player: DOMRect): Generic[] {
  const seen = new Set<HTMLElement>();
  const out: Generic[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    if (seen.has(el)) continue;
    if (el.closest("loom-overlay-root")) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    if (!intersects(rect, player)) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || cs.opacity === "0") continue;

    const vertical = /vertical/.test(cs.writingMode);
    const capClass = CAPTION_RE.test(classString(el));
    const directText = directTextOf(el);

    let tier: Generic["tier"] | null = null;
    if (vertical) tier = "vert";
    else if (capClass && (el.textContent?.trim().length ?? 0) > 0) tier = "cap-class";
    else if (directText && inCaptionBand(rect, player) && !isControlish(el)) tier = "band";
    if (!tier) continue;

    seen.add(el);
    out.push({
      tier,
      rect,
      text: directText || truncate(el.textContent?.trim() ?? "", 80),
      wm: cs.writingMode,
      align: cs.textAlign,
      font: cs.fontSize,
      color: cs.color,
      classChain: classChainOf(el),
    });
  }
  const order: Record<Generic["tier"], number> = { vert: 0, "cap-class": 1, band: 2 };
  out.sort((a, b) => order[a.tier] - order[b.tier]);
  return out.slice(0, 24);
}

// ---- Formatting -----------------------------------------------------------

function cueLine(u: CaptionUnit, player: DOMRect): string {
  const { xPct, yPct } = centerPct(u.rect, player);
  return `  [${u.orient === "vertical" ? "VERT" : "horiz"}] "${truncate(
    u.text,
    52,
  )}"  @(${xPct}%,${yPct}%) ${u.zone}  ${Math.round(u.rect.width)}x${Math.round(
    u.rect.height,
  )}  font=${u.fontPx} align=${u.align} wm=${u.wm} color=${u.color} bg=${u.bg}`;
}

function genericLine(c: Generic, player: DOMRect): string {
  const { xPct, yPct } = centerPct(c.rect, player);
  const band = zoneOf(c.rect, player);
  return `  [${c.tier}] "${truncate(c.text, 48)}"  @(${xPct}%,${yPct}%) ${band}  ${Math.round(
    c.rect.width,
  )}x${Math.round(c.rect.height)}  wm=${c.wm} align=${c.align} font=${c.font} color=${c.color}  cls=${c.classChain}`;
}

// ---- Geometry / DOM helpers ----------------------------------------------

function centerPct(rect: DOMRect, player: DOMRect): { xPct: number; yPct: number } {
  return {
    xPct: Math.round(((rect.left + rect.width / 2 - player.left) / player.width) * 100),
    yPct: Math.round(((rect.top + rect.height / 2 - player.top) / player.height) * 100),
  };
}

function zoneOf(rect: DOMRect, player: DOMRect): string {
  const { xPct, yPct } = centerPct(rect, player);
  const v = yPct < 33 ? "top" : yPct < 66 ? "mid" : "bottom";
  const h = xPct < 33 ? "left" : xPct < 66 ? "center" : "right";
  return `${v}-${h}`;
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function directTextOf(el: HTMLElement): string {
  let s = "";
  for (const n of el.childNodes) {
    if (n.nodeType === Node.TEXT_NODE) s += n.textContent ?? "";
  }
  return s.trim();
}

function inCaptionBand(rect: DOMRect, player: DOMRect): boolean {
  const yPct = ((rect.top + rect.height / 2 - player.top) / player.height) * 100;
  return yPct < 32 || yPct > 60;
}

function isControlish(el: HTMLElement): boolean {
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 3; i++) {
    const cls = classString(cur).toLowerCase();
    if (CONTROL_TOKENS.some((t) => cls.includes(t))) return true;
    cur = cur.parentElement;
  }
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(directTextOf(el))) return true;
  return false;
}

function classString(el: Element): string {
  return typeof el.className === "string" ? el.className : "";
}

function classChainOf(el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  for (let i = 0; cur && i < 4; i++) {
    const cls = classString(cur).trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
    parts.push(`${cur.tagName.toLowerCase()}${cls ? "." + cls : ""}`);
    cur = cur.parentElement;
  }
  return parts.join("<");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
