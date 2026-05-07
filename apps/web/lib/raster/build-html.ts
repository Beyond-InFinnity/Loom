// Build the per-event HTML payload for html2canvas rasterization.
// Mirrors loom_core/rasterize/pgs.py::_build_fullframe_html, simplified
// for 4d-3 (no annotation, no romanized — those are deferred to 4e+).
//
// The desktop version builds a full-frame template with empty divs and
// updates innerHTML per event via a JS hook (Playwright reuses the same
// page across events for speed).  In the browser we don't have that
// luxury — html2canvas walks DOM at draw time.  So we build a fresh
// HTML string per event, mount it once, snapshot, discard.  Slower but
// simpler.

import type { LayerStyle, StyleConfig } from "../subs/style-config";

interface BuildSubtitleHtmlOptions {
  styles: StyleConfig;
  /** Plain text (post-override-strip) for the Top layer.  Empty string
      means "no top this frame" — div is omitted. */
  top_text: string;
  /** Plain text for Bottom.  Empty string omits div. */
  bottom_text: string;
  /** Canvas dimensions in CSS pixels.  Render at output PlayRes. */
  canvas_width: number;
  canvas_height: number;
  /** Output PlayRes / 1080p ratio — applied to font sizes + margins. */
  scale: number;
  top_rtl?: boolean;
  bottom_rtl?: boolean;
}

/** Convert hex + opacity (%) to rgba() — used for color, text-shadow.
    Mirrors loom_core/rasterize/pgs.py::_color_css. */
function colorCss(layer: LayerStyle): string {
  const cleaned = layer.primarycolor.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) return "white";
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  const opacity = Math.max(0, Math.min(100, layer.primary_opacity)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/** Build the text-shadow CSS that emulates ASS outline + shadow + glow.
    Approximation: outline → 4 offset shadows at ±dx/±dy.  Glow → blur. */
function textShadowCss(layer: LayerStyle, scale: number): string {
  const parts: string[] = [];
  if (layer.outline_enabled && layer.outline > 0) {
    const d = layer.outline * scale;
    const oc = layer.outlinecolor;
    const oOpacity = Math.max(0, Math.min(100, layer.outline_opacity)) / 100;
    const cleaned = oc.replace(/^#/, "");
    const r = parseInt(cleaned.slice(0, 2), 16) || 0;
    const g = parseInt(cleaned.slice(2, 4), 16) || 0;
    const b = parseInt(cleaned.slice(4, 6), 16) || 0;
    const rgba = `rgba(${r}, ${g}, ${b}, ${oOpacity})`;
    parts.push(`-${d}px -${d}px 0 ${rgba}`);
    parts.push(`${d}px -${d}px 0 ${rgba}`);
    parts.push(`-${d}px ${d}px 0 ${rgba}`);
    parts.push(`${d}px ${d}px 0 ${rgba}`);
  }
  if (layer.glow_enabled && layer.glow_radius > 0) {
    const radius = layer.glow_radius * scale;
    const cleaned = layer.glow_color_hex.replace(/^#/, "");
    const r = parseInt(cleaned.slice(0, 2), 16) || 255;
    const g = parseInt(cleaned.slice(2, 4), 16) || 255;
    const b = parseInt(cleaned.slice(4, 6), 16) || 0;
    parts.push(`0 0 ${radius}px rgba(${r}, ${g}, ${b}, 1)`);
  }
  if (layer.shadow_enabled && layer.shadow > 0) {
    const d = layer.shadow * scale;
    parts.push(`${d}px ${d}px 0 rgba(0, 0, 0, 0.7)`);
  }
  return parts.length > 0 ? `text-shadow: ${parts.join(", ")};` : "";
}

/** HTML-escape user-provided text so override leaks (`<script>`-like
    content in subs) can't escape into markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Convert ASS line-break markers (\\N, \\n) to <br>.  Done after
    HTML escaping so a literal "\\N" in the source doesn't accidentally
    create breaks where the user typed escaped text. */
function lineBreaksToBr(s: string): string {
  return s.replace(/\\N|\\n/g, "<br>");
}

export function buildSubtitleHtml(opts: BuildSubtitleHtmlOptions): string {
  const {
    styles, top_text, bottom_text,
    canvas_width, canvas_height, scale,
  } = opts;
  const v_offset = styles.vertical_offset;

  const bottom = styles.bottom;
  const top = styles.top;

  const bottomCss = (
    `font-family: '${bottom.fontname}', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans', sans-serif;` +
    `font-size: ${(bottom.fontsize * scale).toFixed(1)}px;` +
    `font-weight: ${bottom.bold ? "bold" : "normal"};` +
    `font-style: ${bottom.italic ? "italic" : "normal"};` +
    `color: ${colorCss(bottom)};` +
    `bottom: ${(bottom.marginv * scale).toFixed(1)}px;` +
    textShadowCss(bottom, scale)
  );
  const topCss = (
    `font-family: '${top.fontname}', 'Noto Sans JP', 'Noto Sans SC', 'Noto Sans TC', 'Noto Sans KR', 'Noto Sans Thai', 'Noto Sans', sans-serif;` +
    `font-size: ${(top.fontsize * scale).toFixed(1)}px;` +
    `font-weight: ${top.bold ? "bold" : "normal"};` +
    `font-style: ${top.italic ? "italic" : "normal"};` +
    `color: ${colorCss(top)};` +
    `top: ${((top.marginv + v_offset) * scale).toFixed(1)}px;` +
    textShadowCss(top, scale)
  );

  const topDir = opts.top_rtl ? ' dir="rtl"' : "";
  const bottomDir = opts.bottom_rtl ? ' dir="rtl"' : "";

  const topDiv = (top_text && styles.top.enabled)
    ? `<div id="top" class="layer"${topDir}>${lineBreaksToBr(escapeHtml(top_text))}</div>`
    : "";
  const bottomDiv = (bottom_text && styles.bottom.enabled)
    ? `<div id="bottom" class="layer"${bottomDir}>${lineBreaksToBr(escapeHtml(bottom_text))}</div>`
    : "";

  // Every rule scoped to #loom-raster-host so the styles can't bleed into
  // the host page when we mount this snippet inline.  An earlier version
  // emitted `* { margin: 0 }` + `html, body { background: transparent }`
  // — those applied globally once mounted (the host's <html>/<body>) and
  // visibly trashed the marketing chrome during a long generate.  Dropped
  // the universal reset entirely: the host container already gets the
  // sizing it needs from rasterizer.ts setup, and CJK glyphs don't care
  // about element default margins.
  return `<style>
#loom-raster-host { background: transparent; overflow: hidden;
                    width: ${canvas_width}px; height: ${canvas_height}px; }
#loom-raster-host .frame { position: relative;
                           width: ${canvas_width}px; height: ${canvas_height}px; }
#loom-raster-host .layer { position: absolute; width: 100%; text-align: center;
                           white-space: pre-wrap; padding: 0 10px;
                           box-sizing: border-box; unicode-bidi: isolate;
                           margin: 0; }
#loom-raster-host #bottom { ${bottomCss} }
#loom-raster-host #top { ${topCss} }
</style>
<div class="frame">${topDiv}${bottomDiv}</div>`;
}
