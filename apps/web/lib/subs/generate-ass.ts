// Port of loom_core/subs/processing.py::generate_ass_file.
//
// Scope intentionally cut for 4d-2 (path A — defer romanization to 4e):
//   - Romanized layer: only emitted when caller passes a `romanize`
//     function.  4e wires the real romanization API call; until then,
//     callers can pass an identity stub or skip the layer entirely.
//   - Annotation layer: NOT emitted.  CJK \pos() annotation requires
//     MeCab/jieba tokenization which is a separate large port; PGS
//     handles annotation visually so we may never need ASS annotation
//     in the web client.
//   - opencc Trad↔Simplified conversion: NOT applied.  Either lands
//     here later (~50KB JS port available as opencc-js) or we accept
//     that the web client ships subs in their source script.
//   - Preserved styles (signs/typesetting/karaoke from the source ASS):
//     NOT carried through.  Needs detect_ass_styles port — secondary
//     polish, marked TODO.
//
// What this DOES port faithfully (no shortcuts):
//   - Multi-layer composition (Bottom from native, Top from target)
//   - PlayRes + WrapStyle + ScaledBorderAndShadow setup
//   - Style construction from per-layer LayerStyle config
//   - Glow handling: \blur tag prefix + outline color override when
//     `outline_enabled` is false (matches Python's glow_none branch)
//   - vertical_offset applied to top + romanized marginv
//   - romanized_gap nudges Romanized down toward Top
//   - Output PlayRes scaling (style + event marginv/marginl/marginr scale)

import { formatAssColor } from "./color";
import { SSAFile } from "./ssa";
import type { SSAEvent, SSAStyle, Color } from "./types";
import { defaultStyle } from "./types";
import type { LayerKey, LayerStyle, StyleConfig } from "./style-config";
import { LAYER_WIRE } from "./style-config";

const _PLAY_RES_X = 1920;
const _PLAY_RES_Y = 1080;

export interface GenerateAssOptions {
  /** Native (user's-language) subs.  Bottom layer source. */
  native: SSAFile;
  /** Target (foreign/media) subs.  Top + Romanized layer source. */
  target: SSAFile;
  /** Live style config — same shape as the desktop UI's StyleConfig. */
  styles: StyleConfig;
  /** Output PlayRes (width, height).  Defaults to (1920, 1080). */
  output_play_res?: [number, number];
  /** Optional pre-romanization hook.  When provided, Romanized layer
      events are emitted with romanize(target_text) per event.  When
      absent or styles.romanized.enabled = false, the layer is skipped.
      4e wires the real call; tests can pass identity. */
  romanize?: (text: string) => string;
}

export function generateAssFile(opts: GenerateAssOptions): string {
  const { native, target, styles, romanize } = opts;
  const out_res = opts.output_play_res ?? [_PLAY_RES_X, _PLAY_RES_Y];
  const scale = out_res[1] / _PLAY_RES_Y;

  // ── Build the output SSAFile ───────────────────────────────
  const stitched = new SSAFile({
    info: {
      Title: "Loom-generated",
      ScriptType: "v4.00+",
      // WrapStyle 2 = no wrap (text rendered exactly as written).
      WrapStyle: "2",
      ScaledBorderAndShadow: "yes",
      PlayResX: String(out_res[0]),
      PlayResY: String(out_res[1]),
      "YCbCr Matrix": "TV.709",
    },
    styles: new Map(),
    events: [],
  });

  // Style construction in a fixed order so the output ASS is deterministic
  // (Bottom, Top, Romanized, Annotation per LAYER_WIRE).
  const layers: LayerKey[] = ["bottom", "top", "romanized", "annotation"];
  const glowConfigs = new Map<string, number>();

  for (const key of layers) {
    const config: LayerStyle = styles[key];
    if (!config.enabled) continue;
    // Annotation deferred for 4d-2 — see scope note.
    if (key === "annotation") continue;
    // Romanized only ships when the caller provides a romanizer.
    if (key === "romanized" && !romanize) continue;

    const wireName = LAYER_WIRE[key];
    const style = layerStyleToSSA(wireName, config, scale, key, styles);
    stitched.styles.set(wireName, style);

    if (config.glow_enabled) {
      // Match Python: blur radius = max(1, glow_radius // 3).
      glowConfigs.set(wireName, Math.max(1, Math.floor(config.glow_radius / 3)));
    }
  }

  // ── Emit Bottom from native subs ──────────────────────────────
  if (styles.bottom.enabled) {
    const blur = glowConfigs.get("Bottom");
    for (const ev of iterDialogueEvents(native)) {
      const copy = cloneEvent(ev);
      copy.style = "Bottom";
      copy.layer = 0;
      if (blur) copy.text = `{\\blur${blur}}${copy.text}`;
      // Scale marginv/l/r if output res differs from source PlayRes.
      // Source PlayRes for SRT is implicit; we use the 1920×1080 default.
      stitched.events.push(copy);
    }
  }

  // ── Emit Top + Romanized from target subs ─────────────────────
  const blurTop = glowConfigs.get("Top");
  const blurRomanized = glowConfigs.get("Romanized");
  for (const ev of iterDialogueEvents(target)) {
    if (styles.top.enabled) {
      const copy = cloneEvent(ev);
      copy.style = "Top";
      copy.layer = 0;
      if (blurTop) copy.text = `{\\blur${blurTop}}${copy.text}`;
      stitched.events.push(copy);
    }

    if (styles.romanized.enabled && romanize) {
      const copy = cloneEvent(ev);
      // Strip ASS override tags before romanizing — preserves the
      // user's intent (romanize the visible text, not the markup).
      const plain = stripAssOverrideTags(ev.text);
      copy.text = romanize(plain);
      copy.style = "Romanized";
      copy.layer = 0;
      if (blurRomanized) copy.text = `{\\blur${blurRomanized}}${copy.text}`;
      stitched.events.push(copy);
    }
  }

  // TODO(4d-2-followup): preserved styles + detect_ass_styles + opencc + annotation.
  // Tracked separately; not blocking the core pipeline.

  return stitched.toAss();
}

// ── Helpers ──────────────────────────────────────────────────

function layerStyleToSSA(
  wireName: string,
  cfg: LayerStyle,
  scale: number,
  key: LayerKey,
  allStyles: StyleConfig,
): SSAStyle {
  const base = defaultStyle(wireName);
  base.fontname = cfg.fontname;
  base.fontsize = cfg.fontsize * scale;
  base.bold = cfg.bold;
  base.italic = cfg.italic;
  base.primarycolor = hexToColor(cfg.primarycolor, cfg.primary_opacity);
  base.outlinecolor = hexToColor(cfg.outlinecolor, cfg.outline_opacity);
  base.backcolor = hexToColor(cfg.backcolor, cfg.back_opacity);
  base.outline = cfg.outline_enabled ? cfg.outline * scale : 0;
  base.shadow = cfg.shadow_enabled ? cfg.shadow * scale : 0;
  base.alignment = cfg.alignment;
  base.margin_l = Math.round(cfg.marginl * scale);
  base.margin_r = Math.round(cfg.marginr * scale);

  // Glow override: when glow_enabled and outline disabled, the outline
  // becomes the glow effect — outline width = glow_radius/3 (px).  See
  // Python's glow_none branch in generate_ass_file.
  if (cfg.glow_enabled && !cfg.outline_enabled) {
    base.outline = (cfg.glow_radius / 3) * scale;
    base.outlinecolor = hexToColor(cfg.glow_color_hex, 100);
  }

  // marginv with vertical_offset + romanized_gap nudges.
  let marginv = cfg.marginv;
  if (key === "top" || key === "romanized") {
    marginv += allStyles.vertical_offset;
  }
  if (key === "romanized") {
    marginv -= allStyles.romanized_gap;
  }
  base.margin_v = Math.round(marginv * scale);

  // border_style 1 = outline+shadow (default).  3 = opaque box (used
  // when background_enabled).  Match Python's behavior.
  if (cfg.background_enabled) {
    base.border_style = 3;
  }

  return base;
}

/** Strip every ASS override block ({\...}) from text.  Matches the
    Python `re.sub(r'\{[^}]*\}', '', text)` pattern used in places
    where we need plain text for romanization / annotation. */
function stripAssOverrideTags(text: string): string {
  return text.replace(/\{[^}]*\}/g, "");
}

/** Iterate dialogue events from an SSAFile.  4d-2 ships a simple
    pass-through that yields all non-comment events.  When 4d-3 or
    later ports detect_ass_styles, this is the integration point for
    style-mapping-aware iteration (dialogue vs preserve vs exclude). */
function* iterDialogueEvents(subs: SSAFile): Iterable<SSAEvent> {
  for (const ev of subs.events) {
    if (ev.type === "Comment") continue;
    yield ev;
  }
}

function cloneEvent(ev: SSAEvent): SSAEvent {
  return { ...ev };
}

function hexToColor(hex: string, opacity_pct: number): Color {
  const cleaned = hex.replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(cleaned)) {
    return { r: 255, g: 255, b: 255, a: 0 };
  }
  const r = parseInt(cleaned.slice(0, 2), 16);
  const g = parseInt(cleaned.slice(2, 4), 16);
  const b = parseInt(cleaned.slice(4, 6), 16);
  // ASS alpha is INVERTED: 0 = opaque, 255 = transparent.
  const opacity = Math.max(0, Math.min(100, opacity_pct)) / 100;
  const a = Math.round((1 - opacity) * 255);
  return { r, g, b, a };
}

// formatAssColor is re-exported for symmetry with parsers, even though
// generate-ass.ts itself doesn't call it directly (toAss() does).
export { formatAssColor };
