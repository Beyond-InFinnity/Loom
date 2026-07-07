import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  setLongVowelMode as discoverSetLongVowelMode,
  setNativeAnnotateEnabled as discoverSetNativeAnnotateEnabled,
  setNativeLangPref as discoverSetNativeLangPref,
  setNativePhoneticSystem as discoverSetNativePhoneticSystem,
  setNativeRomanizeEnabled as discoverSetNativeRomanizeEnabled,
  setNativeTrack as discoverSetNativeTrack,
  setNativeTranslateTo as discoverSetNativeTranslateTo,
  setTargetAnnotateEnabled as discoverSetTargetAnnotateEnabled,
  setTargetPhoneticSystem as discoverSetTargetPhoneticSystem,
  setTargetRomanizeEnabled as discoverSetTargetRomanizeEnabled,
  setTargetTrack as discoverSetTargetTrack,
  setTargetTranslateTo as discoverSetTargetTranslateTo,
  subscribeToCaptions,
  type DiscoveryStatus,
} from "@/lib/captions/discover";
import { CaptionStream } from "@/lib/captions/stream";
import type { CaptionEvent, CaptionTrack } from "@/lib/captions/types";
import type { AnnotateMap, AnnotateTokenMap } from "@/lib/annotate/types";
import type { RomanizeMap } from "@/lib/romanize/types";
import { fetchPresetCatalog } from "@/lib/presets/fetch";
import type { Preset, PresetCatalog, PresetLayerColors } from "@/lib/presets/types";
import { getPlatform } from "@/lib/captions/platform";

// Native-caption suppression is platform-resolved (5h-3): YouTube hides
// `.ytp-caption-window-container`, Netflix hides `.player-timedtext`.
// Resolve lazily per call so a null platform (unsupported host) no-ops.
function hideNativeCaptions(): void {
  getPlatform()?.hideNativeCaptions();
}
function restoreNativeCaptions(): void {
  getPlatform()?.restoreNativeCaptions();
}

// Color + position preferences live in caption-context (not discover.ts)
// because they're presentation state, not caption-discovery state.
// All persisted to browser.storage.local; load is fire-and-forget on
// mount, default values render until the storage read lands.
const STORAGE_KEY_TOP_COLOR = "loom_top_color";
const STORAGE_KEY_BOTTOM_COLOR = "loom_bottom_color";
const STORAGE_KEY_ANNOTATION_COLOR = "loom_annotation_color";
const STORAGE_KEY_TARGET_POSITION = "loom_target_position";
const STORAGE_KEY_NATIVE_POSITION = "loom_native_position";
// Per-layer typography (added when desktop's StyleConfig was ported
// piecemeal — color first, then font family + size).  All persisted.
const STORAGE_KEY_TOP_FONT_FAMILY = "loom_top_font_family";
const STORAGE_KEY_BOTTOM_FONT_FAMILY = "loom_bottom_font_family";
const STORAGE_KEY_ANNOTATION_FONT_FAMILY = "loom_annotation_font_family";
const STORAGE_KEY_TOP_FONT_SIZE = "loom_top_font_size_px";
const STORAGE_KEY_BOTTOM_FONT_SIZE = "loom_bottom_font_size_px";
const STORAGE_KEY_CAPTION_SIZE_PCT = "loom_caption_size_pct";
const STORAGE_KEY_POSITION_BY_PLATFORM = "loom_position_by_platform";
const STORAGE_KEY_ANNOTATION_FONT_RATIO = "loom_annotation_font_ratio";
// Romanization layer (5e — full-utterance phonetic line above the
// foreign text, or the entire phonetic surface for non-CJK families).
// One shared set of style controls for both Top + Bottom romanization
// — mirrors annotation's shared-style design.
const STORAGE_KEY_ROMANIZATION_FONT_FAMILY = "loom_romanization_font_family";
const STORAGE_KEY_ROMANIZATION_FONT_RATIO = "loom_romanization_font_ratio";
const STORAGE_KEY_ROMANIZATION_COLOR = "loom_romanization_color";
// Alternate-orthography (under-ruby) layer.  Per-layer enable so the
// user can turn on under-ruby for their learning lang without polluting
// the native layer.  Highlight + colors are SHARED across layers so a
// "what does this color mean" affordance stays consistent visually.
const STORAGE_KEY_TARGET_VARIANT_ENABLED = "loom_target_variant_enabled";
const STORAGE_KEY_NATIVE_VARIANT_ENABLED = "loom_native_variant_enabled";
const STORAGE_KEY_VARIANT_HIGHLIGHT = "loom_variant_highlight_enabled";
const STORAGE_KEY_VARIANT_COLOR = "loom_variant_color";
const STORAGE_KEY_VARIANT_CLEAN_COLOR = "loom_variant_clean_color";
const STORAGE_KEY_VARIANT_COLLAPSE_COLOR = "loom_variant_collapse_color";
// When true (default), the Simplified auxiliary-ruby glyph tracks the Top
// layer's color so the two read as one unit; uncheck to color it freely.
const STORAGE_KEY_VARIANT_COLOR_SAME_AS_TOP =
  "loom_variant_color_same_as_top";
const STORAGE_KEY_ACTIVE_PRESET = "loom_active_preset_id";
// Advanced per-layer styling — alpha, outline (4-corner text-shadow
// stroke), glow (0 0 Npx text-shadow halo).  All match the desktop's
// LayerColors wire shape so presets apply correctly.  Storage keys
// follow `loom_${layer}_${field}` so a future "reset to default" can
// just walk these keys without a manifest.
const STORAGE_KEY_TOP_ALPHA = "loom_top_alpha";
const STORAGE_KEY_BOTTOM_ALPHA = "loom_bottom_alpha";
const STORAGE_KEY_ANNOTATION_ALPHA = "loom_annotation_alpha";
const STORAGE_KEY_TOP_OUTLINE_COLOR = "loom_top_outline_color";
const STORAGE_KEY_BOTTOM_OUTLINE_COLOR = "loom_bottom_outline_color";
const STORAGE_KEY_ANNOTATION_OUTLINE_COLOR = "loom_annotation_outline_color";
const STORAGE_KEY_TOP_OUTLINE_ALPHA = "loom_top_outline_alpha";
const STORAGE_KEY_BOTTOM_OUTLINE_ALPHA = "loom_bottom_outline_alpha";
const STORAGE_KEY_ANNOTATION_OUTLINE_ALPHA = "loom_annotation_outline_alpha";
const STORAGE_KEY_TOP_GLOW_RADIUS = "loom_top_glow_radius";
const STORAGE_KEY_BOTTOM_GLOW_RADIUS = "loom_bottom_glow_radius";
const STORAGE_KEY_ANNOTATION_GLOW_RADIUS = "loom_annotation_glow_radius";
const STORAGE_KEY_TOP_GLOW_COLOR = "loom_top_glow_color";
const STORAGE_KEY_BOTTOM_GLOW_COLOR = "loom_bottom_glow_color";
const STORAGE_KEY_ANNOTATION_GLOW_COLOR = "loom_annotation_glow_color";
const STORAGE_KEY_TOP_GLOW_ALPHA = "loom_top_glow_alpha";
const STORAGE_KEY_BOTTOM_GLOW_ALPHA = "loom_bottom_glow_alpha";
const STORAGE_KEY_ANNOTATION_GLOW_ALPHA = "loom_annotation_glow_alpha";
// Opacity model (C-5): Bottom is independent.  The Top group (Top +
// Annotation + Romanization + alt-orth) shares one opacity by default —
// `topGroupOpacityLinked` true means the Top alpha drives the whole
// group; false lets Annotation + Romanization take their own alpha.
const STORAGE_KEY_ROMANIZATION_ALPHA = "loom_romanization_alpha";
const STORAGE_KEY_TOP_GROUP_OPACITY_LINKED = "loom_top_group_opacity_linked";
// Per-line master enable (C-8): turn the whole Top (foreign) or Bottom
// (native) line on/off, so Loom doubles as a subtitle customizer — e.g.
// foreign + annotations only, no native line.  Top off hides its
// annotation / romanization / alt-orth too (nothing to attach to).
const STORAGE_KEY_TOP_LINE_ENABLED = "loom_top_line_enabled";
const STORAGE_KEY_BOTTOM_LINE_ENABLED = "loom_bottom_line_enabled";
// Default palette — soft pastels (they read well together and against
// video, and give a brand-new user an informative color-coded layout
// instead of an overwhelming wall of white).  Per-line: Bottom = warm
// custard/cream, Top = pastel purple, Annotation = pastel red,
// Romanization = pastel green, plus the alt-orth tier colors below.
// Fresh installs only — a user's saved customization is never stomped.
const DEFAULT_TOP_COLOR = "#bdb2ff";        // pastel purple — foreign text
const DEFAULT_BOTTOM_COLOR = "#fbf3c4";     // custard/cream — native text
const DEFAULT_ANNOTATION_COLOR = "#ffadad"; // pastel red — per-token reading
/** "auto" sentinel means use the overlay's default cross-script
    Noto-fallback FONT_STACK from caption-overlay.tsx.  Any other
    string is a CSS font-family value used verbatim. */
const DEFAULT_FONT_FAMILY = "auto";
const DEFAULT_TOP_FONT_SIZE_PX = 52;
const DEFAULT_BOTTOM_FONT_SIZE_PX = 48;
/** "Subtitle size" multiplier (percent), stored PER PLATFORM.  Scales the
    WHOLE overlay stack — top / bottom / annotation / romanization —
    uniformly, on top of the per-line font sizes and the player-scale.
    100 = the tuned defaults (top 52 / bottom 48 @ 1080-scale, the Prime
    look).  Per-platform because the same relative size can read large on
    one platform's picture (e.g. Netflix fullscreen) and perfect on another
    (Prime), so each site remembers its own value. */
const DEFAULT_CAPTION_SIZE_PCT = 100;

/** Identifier for the current site's per-platform size bucket. */
function currentPlatformId(): string {
  return getPlatform()?.id ?? "unknown";
}

/** Per-platform position prefs, stored under one map keyed by platform id.
    - top/bottom: vertical nudge in % of player height.  Positive = toward
      the picture center (down for the top zone, up for the bottom) — the
      direction that pulls a line off a letterbox bar into the frame.  0 =
      the tuned default inset.  Applies ONLY to the main top/bottom lines;
      positional signs / vertical cues keep their source location.
    - spacing: gap between stacked lines, px @ 1080-scale (mirrors the
      overlay's LAYER_GAP_PX default).
    Per-platform because a letterbox nudge that fixes one site shouldn't
    move text on another (matches the size knob). */
interface PositionPrefs {
  top: number;
  bottom: number;
  spacing: number;
}
const DEFAULT_POSITION_PREFS: PositionPrefs = { top: 0, bottom: 0, spacing: 4 };

// Module-level caches of the per-platform size + position prefs.  Prime
// mounts the overlay through a REMOUNT reconciler (a surface migration tears
// the React tree — and thus the CaptionProvider — down and rebuilds it,
// often several times in a row as it lands on the preview surface then
// migrates to the episode).  Each rebuild would otherwise start at defaults
// and race an async storage read, so the last-set value appeared not to
// persist.  Reading these module caches SYNCHRONOUSLY in the useState
// initializers means every rebuild restores instantly; storage stays the
// durable source of truth and these are just a warm in-memory mirror,
// populated by the first read and kept current on every save.  Module scope
// = one instance per content-script (per tab), which is exactly right.
let cachedSizeByPlatform: Record<string, number> = {};
let cachedPositionByPlatform: Record<string, PositionPrefs> = {};
/** Annotation font is sized as a fraction of the TOP font (matches
    loom_core/styles.py::annotation_font_ratio).  0.5 for CJK ruby,
    0.4 for alphabetic.  User can override per-track. */
const DEFAULT_ANNOTATION_FONT_RATIO = 0.5;
/** Romanization line font is also a fraction of the parent layer's
    font, picked to roughly match desktop's absolute 30/52 ratio for
    Top.  Slightly larger than annotation since the romanization line
    is a full utterance — more reading load, bigger glyphs help. */
const DEFAULT_ROMANIZATION_FONT_RATIO = 0.55;
const DEFAULT_ROMANIZATION_COLOR = "#caffbf";        // pastel green — phonetic line
const DEFAULT_VARIANT_COLOR = "#bdb2ff";             // pastel purple — Simplified glyph (= Top by default)
const DEFAULT_VARIANT_CLEAN_COLOR = "#a0c4ff";       // pastel blue — 1:1 / distinct mapping
const DEFAULT_VARIANT_COLLAPSE_COLOR = "#fdffb6";   // pastel yellow — forward-collapse / merged
/** Simplified auxiliary-ruby color tracks the Top color by default so
    the pair reads as one unit; the user can uncheck to set it freely. */
const DEFAULT_VARIANT_COLOR_SAME_AS_TOP = true;
// Defaults for advanced layer styling.  Match desktop's LayerColors
// defaults from loom_core/color_presets.py::_L() so presets behave
// identically across surfaces.
const DEFAULT_LAYER_ALPHA = 100;                    // 0–100, full opacity
const DEFAULT_OUTLINE_COLOR = "#000000";
const DEFAULT_OUTLINE_ALPHA = 90;
const DEFAULT_GLOW_RADIUS = 0;                       // 0 disables glow rendering
const DEFAULT_GLOW_COLOR = "#ffffff";
const DEFAULT_GLOW_ALPHA = 100;
/** Top group opacity is linked by default — one slider dims the foreign
    line and its readings together. */
const DEFAULT_TOP_GROUP_OPACITY_LINKED = true;

/** The Loom factory defaults, expressed AS a preset so a fresh install
 *  shows a named preset ("Loominate (Default)") instead of the bare
 *  "(no preset — custom colors)" placeholder — and so re-picking it acts
 *  as "reset colors to default".  Built from the same DEFAULT_* constants
 *  the initial layer state uses, so the two can never drift.  This is a
 *  CLIENT-side preset (not from /styles/presets); PresetPicker injects it
 *  at the top of the list and applyPreset handles it like any other. */
export const LOOMINATE_DEFAULT_PRESET_ID = "loominate-default";
const _defaultLayer = (color: string): PresetLayerColors => ({
  color,
  opacity: DEFAULT_LAYER_ALPHA,
  outline_color: DEFAULT_OUTLINE_COLOR,
  outline_opacity: DEFAULT_OUTLINE_ALPHA,
  // Glow default is off (radius 0); a null glow_color tells applyPreset
  // "leave glow off" rather than turning a glow on.
  glow_color: null,
  glow_opacity: null,
});
export const LOOMINATE_DEFAULT_PRESET: Preset = {
  id: LOOMINATE_DEFAULT_PRESET_ID,
  label: "Loominate (Default)",
  description: "Loom's default pastel colors.",
  group: "loom",
  layers: {
    Bottom: _defaultLayer(DEFAULT_BOTTOM_COLOR),
    Top: _defaultLayer(DEFAULT_TOP_COLOR),
    Annotation: _defaultLayer(DEFAULT_ANNOTATION_COLOR),
    Romanized: _defaultLayer(DEFAULT_ROMANIZATION_COLOR),
  },
  languages: null, // universal — shown on every track
};

/** Slot a track occupies on screen.
    - top-1    : top of player, upper line of top zone (visually highest)
    - top-2    : top of player, lower line of top zone
    - bottom-1 : bottom of player, upper line of bottom zone
    - bottom-2 : bottom of player, lower line of bottom zone (visually lowest)

    Solo case (only one track in a zone): the slot-1/slot-2 distinction
    is irrelevant — flex layout collapses the single layer onto the
    zone's anchor edge.  See caption-overlay.tsx for the rendering. */
export type CaptionPosition = "top-1" | "top-2" | "bottom-1" | "bottom-2";

const VALID_POSITIONS: CaptionPosition[] = [
  "top-1",
  "top-2",
  "bottom-1",
  "bottom-2",
];
// Default split layout: video (target) pinned to the top zone, user (native)
// to the bottom zone — solo-top is top-1, solo-bottom is bottom-2 by
// convention.  Reads cleaner for a first-time user than both lines stacked.
const DEFAULT_TARGET_POSITION: CaptionPosition = "top-1";
const DEFAULT_NATIVE_POSITION: CaptionPosition = "bottom-2";

function isCaptionPosition(v: unknown): v is CaptionPosition {
  return typeof v === "string" && (VALID_POSITIONS as string[]).includes(v);
}

interface CaptionContextValue {
  /** Lifecycle status from discovery — drives the pill + overlay
      visibility decisions. */
  status: DiscoveryStatus;
  /** Currently active target / native events at the playhead.  null
      between events or when not tracking.  These are the PRIMARY cue for
      each side (the main dual-subs slot). */
  target: CaptionEvent | null;
  native: CaptionEvent | null;
  /** ALL concurrently-active target / native cues (a scene can show a
      bottom dialogue line AND a positioned/vertical side cue at once).
      The overlay renders `target`/`native` in the main slot and the
      remaining cues at their source positions.  Empty between events. */
  targets: CaptionEvent[];
  natives: CaptionEvent[];

  /** Underlying CaptionStream — exposed for components that need
      direct read access (rare).  Tests live downstream. */
  stream: CaptionStream;

  /** All caption tracks discovered for the current video.  Empty
      until phase-1 discovery completes. */
  tracks: CaptionTrack[];
  /** Resolved (override-or-auto) target/native SOURCE track.  Drives
      the settings panel's "currently selected" highlight. */
  selectedTarget: CaptionTrack | null;
  selectedNative: CaptionTrack | null;
  isUserPickedTarget: boolean;
  isUserPickedNative: boolean;
  /** User-set tlang= per layer.  null = no MT. */
  targetTranslateTo: string | null;
  nativeTranslateTo: string | null;
  /** Base BCP-47 lang code used for native auto-pick. */
  nativeLangPref: string;

  /** Per-layer text color (hex).  Persisted to browser.storage.local. */
  topColor: string;
  bottomColor: string;
  /** Color of the annotation reading (<rt> in ruby).  Distinct from
      topColor so the user can e.g. have white kanji + soft-yellow
      furigana without dragging colors together. */
  annotationColor: string;
  /** Per-layer font family.  "auto" sentinel = the cross-script
      Noto-fallback stack; any other string is verbatim CSS. */
  topFontFamily: string;
  bottomFontFamily: string;
  annotationFontFamily: string;
  /** Per-layer font size.  Top + Bottom in absolute CSS pixels at
      1080p reference (scaled by usePlayerScale at render time);
      annotation as a ratio of the TOP layer's size (matches the
      desktop's annotation_font_ratio convention). */
  topFontSizePx: number;
  bottomFontSizePx: number;
  /** Global "Subtitle size" multiplier (percent, 50–150).  Scales the whole
      overlay uniformly on top of the per-line sizes + player-scale. */
  captionSizePct: number;
  /** Vertical nudge (% of player height) for the top / bottom main lines;
      positive = toward picture center.  Line spacing = px gap between
      stacked lines.  See the DEFAULT_* constants for rationale. */
  topPositionOffsetPct: number;
  bottomPositionOffsetPct: number;
  lineSpacingPx: number;
  annotationFontRatio: number;
  /** Romanization (5e) styling — same shared-across-layers shape as
      annotation.  Ratio is relative to the parent layer's font (Top
      or Bottom depending on which layer has the line). */
  romanizationFontFamily: string;
  romanizationFontRatio: number;
  romanizationColor: string;

  /** Per-track screen position.  See CaptionPosition above.  Persisted. */
  targetPosition: CaptionPosition;
  nativePosition: CaptionPosition;

  /** Per-track annotation enable + phonetic-system override.
      Persisted by discover.ts. */
  targetAnnotateEnabled: boolean;
  nativeAnnotateEnabled: boolean;
  /** null = backend decides; otherwise pinyin / zhuyin / jyutping
      (Chinese variants) or rtgs / paiboon / ipa (Thai). */
  targetPhoneticSystem: string | null;
  nativePhoneticSystem: string | null;
  /** Annotation maps keyed by event text.  null while loading or
      when annotation is disabled.  Consumed by caption-overlay to
      render <ruby> for the currently-active event. */
  targetAnnotateMap: AnnotateMap | null;
  nativeAnnotateMap: AnnotateMap | null;
  /** Word-level token maps keyed by event text (VOCAB_LOOKUP.md Phase 2),
      parallel to the annotate maps.  Drives per-word vocab lookup on the
      target line. */
  targetTokenMap: AnnotateTokenMap | null;
  nativeTokenMap: AnnotateTokenMap | null;

  /** Per-track romanization (5e) — controls the 4th caption layer
      (the full-utterance phonetic line above the foreign text).
      Persisted by discover.ts. */
  targetRomanizeEnabled: boolean;
  nativeRomanizeEnabled: boolean;
  /** Japanese long-vowel mode.  Global (not per-layer).  Persisted. */
  longVowelMode: "macrons" | "doubled" | "unmarked";
  /** Romanization maps keyed by event text — full-utterance phonetic
      strings (vs the per-token spans in the annotate maps). */
  targetRomanizeMap: RomanizeMap | null;
  nativeRomanizeMap: RomanizeMap | null;

  /** Per-layer alpha — 0..100, applied to the layer's color at render
      time via rgba() conversion.  Default 100 (fully opaque). */
  topAlpha: number;
  bottomAlpha: number;
  annotationAlpha: number;
  /** Romanization line opacity — only consulted when the Top group is
      UNLINKED; while linked it follows topAlpha. */
  romanizationAlpha: number;
  /** When true (default), Top alpha drives the whole Top group
      (Top + Annotation + Romanization + alt-orth).  When false, each
      sub-line uses its own alpha. */
  topGroupOpacityLinked: boolean;
  /** Master per-line enable (C-8).  When false the whole line is hidden;
      Top off also hides its annotation / romanization / alt-orth. */
  topLineEnabled: boolean;
  bottomLineEnabled: boolean;
  /** Per-layer outline color + alpha — the 4-corner text-shadow stroke
      that emulates ASS outline.  Default black @ 90%. */
  topOutlineColor: string;
  bottomOutlineColor: string;
  annotationOutlineColor: string;
  topOutlineAlpha: number;
  bottomOutlineAlpha: number;
  annotationOutlineAlpha: number;
  /** Per-layer glow — `text-shadow: 0 0 ${radius}px rgba(...)` halo.
      Radius 0 disables glow rendering for that layer.  Default 0. */
  topGlowRadius: number;
  bottomGlowRadius: number;
  annotationGlowRadius: number;
  topGlowColor: string;
  bottomGlowColor: string;
  annotationGlowColor: string;
  topGlowAlpha: number;
  bottomGlowAlpha: number;
  annotationGlowAlpha: number;

  /** Color preset catalog fetched from /styles/presets for the current
      target lang.  null while loading or on fetch failure (UI shows
      "no presets" placeholder). */
  presetCatalog: PresetCatalog | null;
  /** id of the most-recently applied preset, persisted so the dropdown
      remembers selection across reloads.  Empty string = none / custom. */
  activePresetId: string;
  /** Apply a preset's colors to the per-layer color state.  Only writes
      Bottom / Top / Annotation today; Romanized is ignored until 5e. */
  applyPreset: (preset: Preset) => void;
  setActivePresetId: (id: string) => void;

  /** Per-layer alternate-orthography enable.  Resolves to under-ruby
      rendering (e.g. zh-Hant base + zh-Hans below) when the layer's
      lang has a registered variant table.  Persisted. */
  targetVariantEnabled: boolean;
  nativeVariantEnabled: boolean;
  /** When true (default), in-table base chars are coloured by tier
      (clean vs collapse).  When false, only the under-rt renders. */
  variantHighlightEnabled: boolean;
  /** Colors — shared across layers for visual consistency.
      `variantColor` is the under-rt; the two highlight colors are
      applied to the BASE glyph at render time. */
  variantColor: string;
  variantCleanColor: string;
  variantCollapseColor: string;
  /** When true (default), the Simplified auxiliary-ruby glyph uses the
      Top layer's color (so the pair reads as one unit).  When false, it
      uses `variantColor` verbatim. */
  variantColorSameAsTop: boolean;

  /** Setters wired into discover.ts.  Pass null to revert to
      auto-pick. */
  setTargetTrack: (track: CaptionTrack | null) => void;
  setNativeTrack: (track: CaptionTrack | null) => void;
  setTargetTranslateTo: (code: string | null) => void;
  setNativeTranslateTo: (code: string | null) => void;
  setNativeLangPref: (code: string) => void;
  setTopColor: (hex: string) => void;
  setBottomColor: (hex: string) => void;
  setAnnotationColor: (hex: string) => void;
  setTopFontFamily: (family: string) => void;
  setBottomFontFamily: (family: string) => void;
  setAnnotationFontFamily: (family: string) => void;
  setTopFontSizePx: (px: number) => void;
  setCaptionSizePct: (pct: number) => void;
  setTopPositionOffsetPct: (pct: number) => void;
  setBottomPositionOffsetPct: (pct: number) => void;
  setLineSpacingPx: (px: number) => void;
  setBottomFontSizePx: (px: number) => void;
  setAnnotationFontRatio: (ratio: number) => void;
  setRomanizationColor: (hex: string) => void;
  setRomanizationFontFamily: (family: string) => void;
  setRomanizationFontRatio: (ratio: number) => void;
  /** Position setters auto-swap when the requested slot is already
      occupied by the other track, so state stays collision-free. */
  setTargetPosition: (pos: CaptionPosition) => void;
  setNativePosition: (pos: CaptionPosition) => void;
  /** Advanced per-layer setters.  Each persists + restores. */
  setTopAlpha: (v: number) => void;
  setBottomAlpha: (v: number) => void;
  setAnnotationAlpha: (v: number) => void;
  setRomanizationAlpha: (v: number) => void;
  setTopGroupOpacityLinked: (v: boolean) => void;
  setTopLineEnabled: (v: boolean) => void;
  setBottomLineEnabled: (v: boolean) => void;
  setTopOutlineColor: (hex: string) => void;
  setBottomOutlineColor: (hex: string) => void;
  setAnnotationOutlineColor: (hex: string) => void;
  setTopOutlineAlpha: (v: number) => void;
  setBottomOutlineAlpha: (v: number) => void;
  setAnnotationOutlineAlpha: (v: number) => void;
  setTopGlowRadius: (v: number) => void;
  setBottomGlowRadius: (v: number) => void;
  setAnnotationGlowRadius: (v: number) => void;
  setTopGlowColor: (hex: string) => void;
  setBottomGlowColor: (hex: string) => void;
  setAnnotationGlowColor: (hex: string) => void;
  setTopGlowAlpha: (v: number) => void;
  setBottomGlowAlpha: (v: number) => void;
  setAnnotationGlowAlpha: (v: number) => void;

  /** Annotation setters — discover.ts persists + re-fetches. */
  setTargetAnnotateEnabled: (v: boolean) => void;
  setNativeAnnotateEnabled: (v: boolean) => void;
  setTargetPhoneticSystem: (code: string | null) => void;
  setNativePhoneticSystem: (code: string | null) => void;
  /** Romanization setters — same delegation pattern. */
  setTargetRomanizeEnabled: (v: boolean) => void;
  setNativeRomanizeEnabled: (v: boolean) => void;
  setLongVowelMode: (mode: "macrons" | "doubled" | "unmarked") => void;
  /** Alternate-orthography setters.  Per-layer enable; shared highlight
      + colors. */
  setTargetVariantEnabled: (v: boolean) => void;
  setNativeVariantEnabled: (v: boolean) => void;
  setVariantHighlightEnabled: (v: boolean) => void;
  setVariantColor: (hex: string) => void;
  setVariantCleanColor: (hex: string) => void;
  setVariantCollapseColor: (hex: string) => void;
  setVariantColorSameAsTop: (v: boolean) => void;
}

const CaptionContext = createContext<CaptionContextValue | null>(null);

export function CaptionStreamProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<DiscoveryStatus>({ kind: "idle" });
  const [target, setTarget] = useState<CaptionEvent | null>(null);
  const [native, setNative] = useState<CaptionEvent | null>(null);
  const [targets, setTargets] = useState<CaptionEvent[]>([]);
  const [natives, setNatives] = useState<CaptionEvent[]>([]);
  const [tracks, setTracks] = useState<CaptionTrack[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<CaptionTrack | null>(
    null,
  );
  const [selectedNative, setSelectedNative] = useState<CaptionTrack | null>(
    null,
  );
  const [isUserPickedTarget, setIsUserPickedTarget] = useState(false);
  const [isUserPickedNative, setIsUserPickedNative] = useState(false);
  const [targetTranslateTo, setTargetTranslateToState] = useState<
    string | null
  >(null);
  const [nativeTranslateTo, setNativeTranslateToState] = useState<
    string | null
  >(null);
  const [nativeLangPref, setNativeLangPrefState] = useState("en");
  const [topColor, setTopColorState] = useState(DEFAULT_TOP_COLOR);
  const [bottomColor, setBottomColorState] = useState(DEFAULT_BOTTOM_COLOR);
  const [annotationColor, setAnnotationColorState] = useState(
    DEFAULT_ANNOTATION_COLOR,
  );
  const [topFontFamily, setTopFontFamilyState] = useState(DEFAULT_FONT_FAMILY);
  const [bottomFontFamily, setBottomFontFamilyState] =
    useState(DEFAULT_FONT_FAMILY);
  const [annotationFontFamily, setAnnotationFontFamilyState] =
    useState(DEFAULT_FONT_FAMILY);
  const [topFontSizePx, setTopFontSizePxState] = useState(
    DEFAULT_TOP_FONT_SIZE_PX,
  );
  const [bottomFontSizePx, setBottomFontSizePxState] = useState(
    DEFAULT_BOTTOM_FONT_SIZE_PX,
  );
  // Each of these holds the CURRENT platform's value (what the overlay +
  // settings consume).  The useState INITIALIZER reads the module cache
  // synchronously so a Prime remount restores the last value on the first
  // render — no flash to default, no race with the async storage read.
  const [captionSizePct, setCaptionSizePctState] = useState(
    () => cachedSizeByPlatform[currentPlatformId()] ?? DEFAULT_CAPTION_SIZE_PCT,
  );
  const [topPositionOffsetPct, setTopPositionOffsetPctState] = useState(
    () =>
      cachedPositionByPlatform[currentPlatformId()]?.top ??
      DEFAULT_POSITION_PREFS.top,
  );
  const [bottomPositionOffsetPct, setBottomPositionOffsetPctState] = useState(
    () =>
      cachedPositionByPlatform[currentPlatformId()]?.bottom ??
      DEFAULT_POSITION_PREFS.bottom,
  );
  const [lineSpacingPx, setLineSpacingPxState] = useState(
    () =>
      cachedPositionByPlatform[currentPlatformId()]?.spacing ??
      DEFAULT_POSITION_PREFS.spacing,
  );
  const [annotationFontRatio, setAnnotationFontRatioState] = useState(
    DEFAULT_ANNOTATION_FONT_RATIO,
  );
  const [romanizationColor, setRomanizationColorState] = useState(
    DEFAULT_ROMANIZATION_COLOR,
  );
  const [romanizationFontFamily, setRomanizationFontFamilyState] = useState(
    DEFAULT_FONT_FAMILY,
  );
  const [romanizationFontRatio, setRomanizationFontRatioState] = useState(
    DEFAULT_ROMANIZATION_FONT_RATIO,
  );
  const [targetPosition, setTargetPositionState] = useState<CaptionPosition>(
    DEFAULT_TARGET_POSITION,
  );
  const [nativePosition, setNativePositionState] = useState<CaptionPosition>(
    DEFAULT_NATIVE_POSITION,
  );
  // Annotation state piped from discover.ts payload — discover owns
  // persistence + the fetch lifecycle; we just mirror for context
  // consumers.  Setters delegate back into discover via the imported
  // discoverSet* functions.
  const [targetAnnotateEnabled, setTargetAnnotateEnabledState] = useState(true);
  const [nativeAnnotateEnabled, setNativeAnnotateEnabledState] =
    useState(false);
  const [targetPhoneticSystem, setTargetPhoneticSystemState] = useState<
    string | null
  >(null);
  const [nativePhoneticSystem, setNativePhoneticSystemState] = useState<
    string | null
  >(null);
  const [targetAnnotateMap, setTargetAnnotateMapState] =
    useState<AnnotateMap | null>(null);
  const [nativeAnnotateMap, setNativeAnnotateMapState] =
    useState<AnnotateMap | null>(null);
  const [targetTokenMap, setTargetTokenMapState] =
    useState<AnnotateTokenMap | null>(null);
  const [nativeTokenMap, setNativeTokenMapState] =
    useState<AnnotateTokenMap | null>(null);
  // Romanization state (5e) — mirrors annotation state shape.
  const [targetRomanizeEnabled, setTargetRomanizeEnabledState] = useState(true);
  const [nativeRomanizeEnabled, setNativeRomanizeEnabledState] =
    useState(false);
  const [longVowelMode, setLongVowelModeState] = useState<
    "macrons" | "doubled" | "unmarked"
  >("macrons");
  const [targetRomanizeMap, setTargetRomanizeMapState] =
    useState<RomanizeMap | null>(null);
  const [nativeRomanizeMap, setNativeRomanizeMapState] =
    useState<RomanizeMap | null>(null);
  // Default ON: alternate orthography only resolves when the selected track
  // HAS a variant (today only zh-Hant → Simplified under-ruby), so enabling it
  // by default surfaces the zh-Hant alt-orthography out of the box and is a
  // no-op for every other language (targetEffective = enabled && !!variant).
  // Persisted user choice still overrides this initial value on load.
  const [targetVariantEnabled, setTargetVariantEnabledState] = useState(true);
  const [nativeVariantEnabled, setNativeVariantEnabledState] = useState(true);
  const [variantHighlightEnabled, setVariantHighlightEnabledState] =
    useState(true);
  const [variantColor, setVariantColorState] = useState(DEFAULT_VARIANT_COLOR);
  const [variantCleanColor, setVariantCleanColorState] = useState(
    DEFAULT_VARIANT_CLEAN_COLOR,
  );
  const [variantCollapseColor, setVariantCollapseColorState] = useState(
    DEFAULT_VARIANT_COLLAPSE_COLOR,
  );
  const [variantColorSameAsTop, setVariantColorSameAsTopState] = useState(
    DEFAULT_VARIANT_COLOR_SAME_AS_TOP,
  );
  const [presetCatalog, setPresetCatalog] = useState<PresetCatalog | null>(
    null,
  );
  // Fresh installs start on the Loom default preset (not "" = no preset),
  // so the picker reads "Loominate (Default)" rather than the bare
  // custom-colors placeholder.  A saved id from storage overrides this on
  // load; picking any real preset or hand-editing a color replaces it.
  const [activePresetId, setActivePresetIdState] = useState<string>(
    LOOMINATE_DEFAULT_PRESET_ID,
  );
  const [topAlpha, setTopAlphaState] = useState(DEFAULT_LAYER_ALPHA);
  const [bottomAlpha, setBottomAlphaState] = useState(DEFAULT_LAYER_ALPHA);
  const [annotationAlpha, setAnnotationAlphaState] = useState(DEFAULT_LAYER_ALPHA);
  const [romanizationAlpha, setRomanizationAlphaState] =
    useState(DEFAULT_LAYER_ALPHA);
  const [topGroupOpacityLinked, setTopGroupOpacityLinkedState] = useState(
    DEFAULT_TOP_GROUP_OPACITY_LINKED,
  );
  const [topLineEnabled, setTopLineEnabledState] = useState(true);
  const [bottomLineEnabled, setBottomLineEnabledState] = useState(true);
  const [topOutlineColor, setTopOutlineColorState] = useState(DEFAULT_OUTLINE_COLOR);
  const [bottomOutlineColor, setBottomOutlineColorState] = useState(DEFAULT_OUTLINE_COLOR);
  const [annotationOutlineColor, setAnnotationOutlineColorState] = useState(DEFAULT_OUTLINE_COLOR);
  const [topOutlineAlpha, setTopOutlineAlphaState] = useState(DEFAULT_OUTLINE_ALPHA);
  const [bottomOutlineAlpha, setBottomOutlineAlphaState] = useState(DEFAULT_OUTLINE_ALPHA);
  const [annotationOutlineAlpha, setAnnotationOutlineAlphaState] = useState(DEFAULT_OUTLINE_ALPHA);
  const [topGlowRadius, setTopGlowRadiusState] = useState(DEFAULT_GLOW_RADIUS);
  const [bottomGlowRadius, setBottomGlowRadiusState] = useState(DEFAULT_GLOW_RADIUS);
  const [annotationGlowRadius, setAnnotationGlowRadiusState] = useState(DEFAULT_GLOW_RADIUS);
  const [topGlowColor, setTopGlowColorState] = useState(DEFAULT_GLOW_COLOR);
  const [bottomGlowColor, setBottomGlowColorState] = useState(DEFAULT_GLOW_COLOR);
  const [annotationGlowColor, setAnnotationGlowColorState] = useState(DEFAULT_GLOW_COLOR);
  const [topGlowAlpha, setTopGlowAlphaState] = useState(DEFAULT_GLOW_ALPHA);
  const [bottomGlowAlpha, setBottomGlowAlphaState] = useState(DEFAULT_GLOW_ALPHA);
  const [annotationGlowAlpha, setAnnotationGlowAlphaState] = useState(DEFAULT_GLOW_ALPHA);

  const stream = useMemo(
    () =>
      new CaptionStream({
        onStatusChange: (s) => {
          // CaptionStream emits its own status (idle/detecting/
          // tracking/unsupported/error).  We treat the discovery
          // payload as authoritative for the outer status; the
          // stream's status is just internal lifecycle plumbing.
          // No-op here; status comes from the discover subscription.
          void s;
        },
        onActiveChange: (d) => {
          setTarget(d.target);
          setNative(d.native);
          setTargets(d.targets);
          setNatives(d.natives);
          // No annotation-fetch trigger here (5d-perf v3): the
          // /annotate/batch one-shot at track-resolve time pre-
          // populates the entire map, so playhead boundaries don't
          // need to drive any network or cache work.
        },
      }),
    [],
  );

  useEffect(() => {
    const unsubscribe = subscribeToCaptions((payload) => {
      setStatus(payload.status);
      setTracks(payload.tracks);
      setSelectedTarget(payload.selectedTarget);
      setSelectedNative(payload.selectedNative);
      setIsUserPickedTarget(payload.isUserPickedTarget);
      setIsUserPickedNative(payload.isUserPickedNative);
      setTargetTranslateToState(payload.targetTranslateTo);
      setNativeTranslateToState(payload.nativeTranslateTo);
      setNativeLangPrefState(payload.nativeLangPref);
      setTargetAnnotateEnabledState(payload.targetAnnotateEnabled);
      setNativeAnnotateEnabledState(payload.nativeAnnotateEnabled);
      setTargetPhoneticSystemState(payload.targetPhoneticSystem);
      setNativePhoneticSystemState(payload.nativePhoneticSystem);
      setTargetAnnotateMapState(payload.targetAnnotateMap);
      setNativeAnnotateMapState(payload.nativeAnnotateMap);
      setTargetTokenMapState(payload.targetTokenMap);
      setNativeTokenMapState(payload.nativeTokenMap);
      setTargetRomanizeEnabledState(payload.targetRomanizeEnabled);
      setNativeRomanizeEnabledState(payload.nativeRomanizeEnabled);
      setLongVowelModeState(payload.longVowelMode);
      setTargetRomanizeMapState(payload.targetRomanizeMap);
      setNativeRomanizeMapState(payload.nativeRomanizeMap);

      const s = payload.status;
      if (s.kind === "tracking" && payload.targetEvents) {
        hideNativeCaptions();
        stream.start({
          targetEvents: payload.targetEvents,
          nativeEvents: payload.nativeEvents ?? [],
          targetLang: s.targetLang,
          nativeLang: s.nativeLang,
        });
      } else if (s.kind === "unsupported") {
        restoreNativeCaptions();
        stream.setUnsupported(s.reason);
      } else if (s.kind === "error") {
        restoreNativeCaptions();
        stream.setError(s.message);
      } else if (s.kind === "discovering") {
        // Keep current stream state — re-resolve is in flight.  When
        // it lands as `tracking`, stream.start swaps in new events.
        // YT captions stay hidden during the brief in-flight window
        // because we hid them on the previous `tracking` emit and
        // haven't called restore.
      }
    });
    return () => {
      unsubscribe();
      restoreNativeCaptions();
      stream.stop();
    };
  }, [stream]);

  // One-shot load of persisted color + position preferences.  Fire-
  // and-forget; unpersisted defaults render until the storage read
  // lands.  Position values are validated against VALID_POSITIONS so a
  // stale/corrupt entry doesn't poison render — we silently fall back
  // to the default.
  useEffect(() => {
    void (async () => {
      try {
        const result = await browser.storage.local.get([
          STORAGE_KEY_TOP_COLOR,
          STORAGE_KEY_BOTTOM_COLOR,
          STORAGE_KEY_ANNOTATION_COLOR,
          STORAGE_KEY_TARGET_POSITION,
          STORAGE_KEY_NATIVE_POSITION,
          STORAGE_KEY_TOP_FONT_FAMILY,
          STORAGE_KEY_BOTTOM_FONT_FAMILY,
          STORAGE_KEY_ANNOTATION_FONT_FAMILY,
          STORAGE_KEY_TOP_FONT_SIZE,
          STORAGE_KEY_BOTTOM_FONT_SIZE,
          STORAGE_KEY_CAPTION_SIZE_PCT,
          STORAGE_KEY_POSITION_BY_PLATFORM,
          STORAGE_KEY_ANNOTATION_FONT_RATIO,
          STORAGE_KEY_TARGET_VARIANT_ENABLED,
          STORAGE_KEY_NATIVE_VARIANT_ENABLED,
          STORAGE_KEY_VARIANT_HIGHLIGHT,
          STORAGE_KEY_VARIANT_COLOR,
          STORAGE_KEY_VARIANT_CLEAN_COLOR,
          STORAGE_KEY_VARIANT_COLLAPSE_COLOR,
          STORAGE_KEY_VARIANT_COLOR_SAME_AS_TOP,
          STORAGE_KEY_ACTIVE_PRESET,
          STORAGE_KEY_TOP_ALPHA,
          STORAGE_KEY_BOTTOM_ALPHA,
          STORAGE_KEY_ANNOTATION_ALPHA,
          STORAGE_KEY_TOP_OUTLINE_COLOR,
          STORAGE_KEY_BOTTOM_OUTLINE_COLOR,
          STORAGE_KEY_ANNOTATION_OUTLINE_COLOR,
          STORAGE_KEY_TOP_OUTLINE_ALPHA,
          STORAGE_KEY_BOTTOM_OUTLINE_ALPHA,
          STORAGE_KEY_ANNOTATION_OUTLINE_ALPHA,
          STORAGE_KEY_TOP_GLOW_RADIUS,
          STORAGE_KEY_BOTTOM_GLOW_RADIUS,
          STORAGE_KEY_ANNOTATION_GLOW_RADIUS,
          STORAGE_KEY_TOP_GLOW_COLOR,
          STORAGE_KEY_BOTTOM_GLOW_COLOR,
          STORAGE_KEY_ANNOTATION_GLOW_COLOR,
          STORAGE_KEY_TOP_GLOW_ALPHA,
          STORAGE_KEY_BOTTOM_GLOW_ALPHA,
          STORAGE_KEY_ANNOTATION_GLOW_ALPHA,
          STORAGE_KEY_ROMANIZATION_COLOR,
          STORAGE_KEY_ROMANIZATION_FONT_FAMILY,
          STORAGE_KEY_ROMANIZATION_FONT_RATIO,
          STORAGE_KEY_ROMANIZATION_ALPHA,
          STORAGE_KEY_TOP_GROUP_OPACITY_LINKED,
          STORAGE_KEY_TOP_LINE_ENABLED,
          STORAGE_KEY_BOTTOM_LINE_ENABLED,
        ]);
        const top = result[STORAGE_KEY_TOP_COLOR];
        const bottom = result[STORAGE_KEY_BOTTOM_COLOR];
        const ann = result[STORAGE_KEY_ANNOTATION_COLOR];
        const tPos = result[STORAGE_KEY_TARGET_POSITION];
        const nPos = result[STORAGE_KEY_NATIVE_POSITION];
        if (typeof top === "string" && top.length > 0) setTopColorState(top);
        if (typeof bottom === "string" && bottom.length > 0)
          setBottomColorState(bottom);
        if (typeof ann === "string" && ann.length > 0)
          setAnnotationColorState(ann);
        if (isCaptionPosition(tPos) && isCaptionPosition(nPos) && tPos !== nPos) {
          // Both validated AND non-colliding.  Anything else falls
          // back to defaults so we never start in a broken state.
          setTargetPositionState(tPos);
          setNativePositionState(nPos);
        }
        // Font family — any non-empty string is acceptable as a CSS
        // font-family value.  Defaults guarantee at least DEFAULT_FONT_FAMILY.
        const tFont = result[STORAGE_KEY_TOP_FONT_FAMILY];
        const bFont = result[STORAGE_KEY_BOTTOM_FONT_FAMILY];
        const aFont = result[STORAGE_KEY_ANNOTATION_FONT_FAMILY];
        if (typeof tFont === "string" && tFont.length > 0)
          setTopFontFamilyState(tFont);
        if (typeof bFont === "string" && bFont.length > 0)
          setBottomFontFamilyState(bFont);
        if (typeof aFont === "string" && aFont.length > 0)
          setAnnotationFontFamilyState(aFont);
        // Font sizes — defensive numeric clamps so a stored garbage
        // value can't render a 1-px or 10,000-px overlay.
        const tSize = result[STORAGE_KEY_TOP_FONT_SIZE];
        const bSize = result[STORAGE_KEY_BOTTOM_FONT_SIZE];
        const aRatio = result[STORAGE_KEY_ANNOTATION_FONT_RATIO];
        if (typeof tSize === "number" && tSize >= 12 && tSize <= 120)
          setTopFontSizePxState(tSize);
        if (typeof bSize === "number" && bSize >= 12 && bSize <= 120)
          setBottomFontSizePxState(bSize);
        // Per-platform map: { [platformId]: pct }.  A legacy plain-number
        // value (the earlier global knob) is discarded so it can't leak one
        // platform's size onto the others.
        const sizePct = result[STORAGE_KEY_CAPTION_SIZE_PCT];
        if (sizePct && typeof sizePct === "object") {
          const map: Record<string, number> = {};
          for (const [plat, val] of Object.entries(sizePct)) {
            if (typeof val === "number" && val >= 50 && val <= 150)
              map[plat] = val;
          }
          cachedSizeByPlatform = map;
          const mine = map[currentPlatformId()];
          if (typeof mine === "number") setCaptionSizePctState(mine);
        }
        // Per-platform position map: { [platformId]: {top,bottom,spacing} }.
        const posMap = result[STORAGE_KEY_POSITION_BY_PLATFORM];
        if (posMap && typeof posMap === "object") {
          const clean: Record<string, PositionPrefs> = {};
          for (const [plat, raw] of Object.entries(posMap)) {
            if (!raw || typeof raw !== "object") continue;
            const p = raw as Partial<PositionPrefs>;
            const top =
              typeof p.top === "number" && p.top >= -40 && p.top <= 40
                ? p.top
                : DEFAULT_POSITION_PREFS.top;
            const bottom =
              typeof p.bottom === "number" && p.bottom >= -40 && p.bottom <= 40
                ? p.bottom
                : DEFAULT_POSITION_PREFS.bottom;
            const spacing =
              typeof p.spacing === "number" &&
              p.spacing >= 0 &&
              p.spacing <= 40
                ? p.spacing
                : DEFAULT_POSITION_PREFS.spacing;
            clean[plat] = { top, bottom, spacing };
          }
          cachedPositionByPlatform = clean;
          const mine = clean[currentPlatformId()];
          if (mine) {
            setTopPositionOffsetPctState(mine.top);
            setBottomPositionOffsetPctState(mine.bottom);
            setLineSpacingPxState(mine.spacing);
          }
        }
        if (typeof aRatio === "number" && aRatio >= 0.2 && aRatio <= 1.0)
          setAnnotationFontRatioState(aRatio);
        // Romanization layer (5e) — same clamping shape as annotation.
        const rCol = result[STORAGE_KEY_ROMANIZATION_COLOR];
        const rFont = result[STORAGE_KEY_ROMANIZATION_FONT_FAMILY];
        const rRatio = result[STORAGE_KEY_ROMANIZATION_FONT_RATIO];
        if (typeof rCol === "string" && rCol.length > 0)
          setRomanizationColorState(rCol);
        if (typeof rFont === "string" && rFont.length > 0)
          setRomanizationFontFamilyState(rFont);
        if (typeof rRatio === "number" && rRatio >= 0.2 && rRatio <= 1.0)
          setRomanizationFontRatioState(rRatio);
        // Variant prefs — booleans validated as actual booleans (avoid
        // truthy-coercion of stale "true"/"false" strings); colors
        // accept any non-empty string (the native color input will
        // validate format at the UI layer).
        const tVar = result[STORAGE_KEY_TARGET_VARIANT_ENABLED];
        const nVar = result[STORAGE_KEY_NATIVE_VARIANT_ENABLED];
        const vHigh = result[STORAGE_KEY_VARIANT_HIGHLIGHT];
        if (typeof tVar === "boolean") setTargetVariantEnabledState(tVar);
        if (typeof nVar === "boolean") setNativeVariantEnabledState(nVar);
        if (typeof vHigh === "boolean") setVariantHighlightEnabledState(vHigh);
        const vCol = result[STORAGE_KEY_VARIANT_COLOR];
        const vClean = result[STORAGE_KEY_VARIANT_CLEAN_COLOR];
        const vColl = result[STORAGE_KEY_VARIANT_COLLAPSE_COLOR];
        if (typeof vCol === "string" && vCol.length > 0) setVariantColorState(vCol);
        if (typeof vClean === "string" && vClean.length > 0)
          setVariantCleanColorState(vClean);
        if (typeof vColl === "string" && vColl.length > 0)
          setVariantCollapseColorState(vColl);
        const vSame = result[STORAGE_KEY_VARIANT_COLOR_SAME_AS_TOP];
        if (typeof vSame === "boolean") setVariantColorSameAsTopState(vSame);
        const ap = result[STORAGE_KEY_ACTIVE_PRESET];
        if (typeof ap === "string") setActivePresetIdState(ap);
        // Advanced styling — clamp numerics, validate hex strings.
        const loadAlpha = (k: string, setter: (n: number) => void) => {
          const v = result[k];
          if (typeof v === "number" && v >= 0 && v <= 100) setter(v);
        };
        const loadHex = (k: string, setter: (s: string) => void) => {
          const v = result[k];
          if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) setter(v);
        };
        const loadRadius = (k: string, setter: (n: number) => void) => {
          const v = result[k];
          if (typeof v === "number" && v >= 0 && v <= 50) setter(v);
        };
        loadAlpha(STORAGE_KEY_TOP_ALPHA, setTopAlphaState);
        loadAlpha(STORAGE_KEY_BOTTOM_ALPHA, setBottomAlphaState);
        loadAlpha(STORAGE_KEY_ANNOTATION_ALPHA, setAnnotationAlphaState);
        loadHex(STORAGE_KEY_TOP_OUTLINE_COLOR, setTopOutlineColorState);
        loadHex(STORAGE_KEY_BOTTOM_OUTLINE_COLOR, setBottomOutlineColorState);
        loadHex(STORAGE_KEY_ANNOTATION_OUTLINE_COLOR, setAnnotationOutlineColorState);
        loadAlpha(STORAGE_KEY_TOP_OUTLINE_ALPHA, setTopOutlineAlphaState);
        loadAlpha(STORAGE_KEY_BOTTOM_OUTLINE_ALPHA, setBottomOutlineAlphaState);
        loadAlpha(STORAGE_KEY_ANNOTATION_OUTLINE_ALPHA, setAnnotationOutlineAlphaState);
        loadRadius(STORAGE_KEY_TOP_GLOW_RADIUS, setTopGlowRadiusState);
        loadRadius(STORAGE_KEY_BOTTOM_GLOW_RADIUS, setBottomGlowRadiusState);
        loadRadius(STORAGE_KEY_ANNOTATION_GLOW_RADIUS, setAnnotationGlowRadiusState);
        loadHex(STORAGE_KEY_TOP_GLOW_COLOR, setTopGlowColorState);
        loadHex(STORAGE_KEY_BOTTOM_GLOW_COLOR, setBottomGlowColorState);
        loadHex(STORAGE_KEY_ANNOTATION_GLOW_COLOR, setAnnotationGlowColorState);
        loadAlpha(STORAGE_KEY_TOP_GLOW_ALPHA, setTopGlowAlphaState);
        loadAlpha(STORAGE_KEY_BOTTOM_GLOW_ALPHA, setBottomGlowAlphaState);
        loadAlpha(STORAGE_KEY_ANNOTATION_GLOW_ALPHA, setAnnotationGlowAlphaState);
        loadAlpha(STORAGE_KEY_ROMANIZATION_ALPHA, setRomanizationAlphaState);
        const linked = result[STORAGE_KEY_TOP_GROUP_OPACITY_LINKED];
        if (typeof linked === "boolean") setTopGroupOpacityLinkedState(linked);
        const tLine = result[STORAGE_KEY_TOP_LINE_ENABLED];
        const bLine = result[STORAGE_KEY_BOTTOM_LINE_ENABLED];
        if (typeof tLine === "boolean") setTopLineEnabledState(tLine);
        if (typeof bLine === "boolean") setBottomLineEnabledState(bLine);
      } catch (e) {
        console.warn("[Loom] failed to load presentation prefs:", e);
      }
    })();
  }, []);

  // Preset catalog fetch — re-runs whenever the active target track's
  // language changes (so a zh-Hant track gets cultural-Chinese presets,
  // a ja track gets Ukiyo-e/NERV/etc., a fr/en/de track gets universal
  // presets only).  AbortController cancels the in-flight fetch on
  // rapid track-switching so we don't write stale catalogs over fresh.
  useEffect(() => {
    const lang = selectedTarget?.languageCode ?? "";
    const ctrl = new AbortController();
    void (async () => {
      const catalog = await fetchPresetCatalog({ lang, signal: ctrl.signal });
      if (!ctrl.signal.aborted && catalog) {
        setPresetCatalog(catalog);
      }
    })();
    return () => ctrl.abort();
  }, [selectedTarget?.languageCode]);

  const setActivePresetId = useCallback((id: string) => {
    setActivePresetIdState(id);
    void browser.storage.local
      .set({ [STORAGE_KEY_ACTIVE_PRESET]: id })
      .catch((e) => console.warn("[Loom] persist activePresetId:", e));
  }, []);

  // applyPreset — writes Bottom / Top / Annotation colors from the
  // preset's layers in one atomic batch.  Each setter persists
  // independently, but functionally they all land in this frame.
  // Romanized is ignored until 5e wires it in; opacity / outline /
  // glow fields are present in the wire shape but the extension
  // hasn't surfaced UI for those, so they're dropped silently.
  const applyPreset = useCallback((preset: Preset) => {
    // Apply ALL preset fields per layer: color + opacity + outline
    // (color + opacity) + optional glow (color + opacity).  Romanized
    // layer is ignored until 5e wires the 4th caption slot in.
    const applyLayer = (
      layerKey: "Bottom" | "Top" | "Annotation",
      colorSetter: React.Dispatch<React.SetStateAction<string>>,
      colorStorageKey: string,
      alphaSetter: React.Dispatch<React.SetStateAction<number>>,
      alphaStorageKey: string,
      outlineColorSetter: React.Dispatch<React.SetStateAction<string>>,
      outlineColorStorageKey: string,
      outlineAlphaSetter: React.Dispatch<React.SetStateAction<number>>,
      outlineAlphaStorageKey: string,
      glowRadiusSetter: React.Dispatch<React.SetStateAction<number>>,
      glowRadiusStorageKey: string,
      glowColorSetter: React.Dispatch<React.SetStateAction<string>>,
      glowColorStorageKey: string,
      glowAlphaSetter: React.Dispatch<React.SetStateAction<number>>,
      glowAlphaStorageKey: string,
    ) => {
      const lc = preset.layers[layerKey];
      if (!lc) return;
      colorSetter(lc.color);
      void browser.storage.local.set({ [colorStorageKey]: lc.color }).catch(() => {});
      alphaSetter(lc.opacity);
      void browser.storage.local.set({ [alphaStorageKey]: lc.opacity }).catch(() => {});
      outlineColorSetter(lc.outline_color);
      void browser.storage.local.set({ [outlineColorStorageKey]: lc.outline_color }).catch(() => {});
      outlineAlphaSetter(lc.outline_opacity);
      void browser.storage.local.set({ [outlineAlphaStorageKey]: lc.outline_opacity }).catch(() => {});
      // Glow is OPTIONAL on a preset; null means "preset doesn't
      // touch glow, leave whatever the user had."  When the preset
      // DOES specify glow, default radius to a visible 8px since
      // the wire shape carries color + opacity but no explicit
      // radius — matches desktop convention.
      if (lc.glow_color !== null && lc.glow_opacity !== null) {
        glowRadiusSetter(8);
        void browser.storage.local.set({ [glowRadiusStorageKey]: 8 }).catch(() => {});
        glowColorSetter(lc.glow_color);
        void browser.storage.local.set({ [glowColorStorageKey]: lc.glow_color }).catch(() => {});
        glowAlphaSetter(lc.glow_opacity);
        void browser.storage.local.set({ [glowAlphaStorageKey]: lc.glow_opacity }).catch(() => {});
      } else {
        // Preset doesn't carry glow — turn it off explicitly so a
        // previously-applied glowy preset doesn't bleed visual state
        // into the new one.
        glowRadiusSetter(0);
        void browser.storage.local.set({ [glowRadiusStorageKey]: 0 }).catch(() => {});
      }
    };
    applyLayer(
      "Bottom",
      setBottomColorState, STORAGE_KEY_BOTTOM_COLOR,
      setBottomAlphaState, STORAGE_KEY_BOTTOM_ALPHA,
      setBottomOutlineColorState, STORAGE_KEY_BOTTOM_OUTLINE_COLOR,
      setBottomOutlineAlphaState, STORAGE_KEY_BOTTOM_OUTLINE_ALPHA,
      setBottomGlowRadiusState, STORAGE_KEY_BOTTOM_GLOW_RADIUS,
      setBottomGlowColorState, STORAGE_KEY_BOTTOM_GLOW_COLOR,
      setBottomGlowAlphaState, STORAGE_KEY_BOTTOM_GLOW_ALPHA,
    );
    applyLayer(
      "Top",
      setTopColorState, STORAGE_KEY_TOP_COLOR,
      setTopAlphaState, STORAGE_KEY_TOP_ALPHA,
      setTopOutlineColorState, STORAGE_KEY_TOP_OUTLINE_COLOR,
      setTopOutlineAlphaState, STORAGE_KEY_TOP_OUTLINE_ALPHA,
      setTopGlowRadiusState, STORAGE_KEY_TOP_GLOW_RADIUS,
      setTopGlowColorState, STORAGE_KEY_TOP_GLOW_COLOR,
      setTopGlowAlphaState, STORAGE_KEY_TOP_GLOW_ALPHA,
    );
    applyLayer(
      "Annotation",
      setAnnotationColorState, STORAGE_KEY_ANNOTATION_COLOR,
      setAnnotationAlphaState, STORAGE_KEY_ANNOTATION_ALPHA,
      setAnnotationOutlineColorState, STORAGE_KEY_ANNOTATION_OUTLINE_COLOR,
      setAnnotationOutlineAlphaState, STORAGE_KEY_ANNOTATION_OUTLINE_ALPHA,
      setAnnotationGlowRadiusState, STORAGE_KEY_ANNOTATION_GLOW_RADIUS,
      setAnnotationGlowColorState, STORAGE_KEY_ANNOTATION_GLOW_COLOR,
      setAnnotationGlowAlphaState, STORAGE_KEY_ANNOTATION_GLOW_ALPHA,
    );
    setActivePresetIdState(preset.id);
    void browser.storage.local
      .set({ [STORAGE_KEY_ACTIVE_PRESET]: preset.id })
      .catch(() => {});
  }, []);

  const setTargetTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetTargetTrack(track);
  }, []);
  const setNativeTrack = useCallback((track: CaptionTrack | null) => {
    discoverSetNativeTrack(track);
  }, []);
  const setTargetTranslateTo = useCallback((code: string | null) => {
    discoverSetTargetTranslateTo(code);
  }, []);
  const setNativeTranslateTo = useCallback((code: string | null) => {
    discoverSetNativeTranslateTo(code);
  }, []);
  const setNativeLangPref = useCallback((code: string) => {
    discoverSetNativeLangPref(code);
  }, []);
  const setTopColor = useCallback((hex: string) => {
    setTopColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_COLOR]: hex })
      .catch((e) => console.warn("[Loom] failed to persist topColor:", e));
  }, []);
  const setBottomColor = useCallback((hex: string) => {
    setBottomColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_COLOR]: hex })
      .catch((e) => console.warn("[Loom] failed to persist bottomColor:", e));
  }, []);
  const setAnnotationColor = useCallback((hex: string) => {
    setAnnotationColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_COLOR]: hex })
      .catch((e) =>
        console.warn("[Loom] failed to persist annotationColor:", e),
      );
  }, []);
  const setTopFontFamily = useCallback((family: string) => {
    setTopFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist topFontFamily:", e));
  }, []);
  const setBottomFontFamily = useCallback((family: string) => {
    setBottomFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist bottomFontFamily:", e));
  }, []);
  const setAnnotationFontFamily = useCallback((family: string) => {
    setAnnotationFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_FONT_FAMILY]: family })
      .catch((e) => console.warn("[Loom] persist annotationFontFamily:", e));
  }, []);
  const setTopFontSizePx = useCallback((px: number) => {
    // Defensive clamp — UI should already constrain, but a stray
    // setState from a custom integration shouldn't break layout.
    const clamped = Math.max(12, Math.min(120, px));
    setTopFontSizePxState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_FONT_SIZE]: clamped })
      .catch((e) => console.warn("[Loom] persist topFontSizePx:", e));
  }, []);
  const setBottomFontSizePx = useCallback((px: number) => {
    const clamped = Math.max(12, Math.min(120, px));
    setBottomFontSizePxState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_FONT_SIZE]: clamped })
      .catch((e) => console.warn("[Loom] persist bottomFontSizePx:", e));
  }, []);
  const setCaptionSizePct = useCallback((pct: number) => {
    const clamped = Math.max(50, Math.min(150, Math.round(pct)));
    setCaptionSizePctState(clamped);
    const map = { ...cachedSizeByPlatform, [currentPlatformId()]: clamped };
    cachedSizeByPlatform = map;
    void browser.storage.local
      .set({ [STORAGE_KEY_CAPTION_SIZE_PCT]: map })
      .catch((e) => console.warn("[Loom] persist captionSizePct:", e));
  }, []);
  const persistPositionPrefs = useCallback((patch: Partial<PositionPrefs>) => {
    const id = currentPlatformId();
    const prev = cachedPositionByPlatform[id] ?? { ...DEFAULT_POSITION_PREFS };
    const map = { ...cachedPositionByPlatform, [id]: { ...prev, ...patch } };
    cachedPositionByPlatform = map;
    void browser.storage.local
      .set({ [STORAGE_KEY_POSITION_BY_PLATFORM]: map })
      .catch((e) => console.warn("[Loom] persist position prefs:", e));
  }, []);
  const setTopPositionOffsetPct = useCallback(
    (pct: number) => {
      const clamped = Math.max(-40, Math.min(40, Math.round(pct)));
      setTopPositionOffsetPctState(clamped);
      persistPositionPrefs({ top: clamped });
    },
    [persistPositionPrefs],
  );
  const setBottomPositionOffsetPct = useCallback(
    (pct: number) => {
      const clamped = Math.max(-40, Math.min(40, Math.round(pct)));
      setBottomPositionOffsetPctState(clamped);
      persistPositionPrefs({ bottom: clamped });
    },
    [persistPositionPrefs],
  );
  const setLineSpacingPx = useCallback(
    (px: number) => {
      const clamped = Math.max(0, Math.min(40, Math.round(px)));
      setLineSpacingPxState(clamped);
      persistPositionPrefs({ spacing: clamped });
    },
    [persistPositionPrefs],
  );
  const setAnnotationFontRatio = useCallback((ratio: number) => {
    const clamped = Math.max(0.2, Math.min(1.0, ratio));
    setAnnotationFontRatioState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_ANNOTATION_FONT_RATIO]: clamped })
      .catch((e) => console.warn("[Loom] persist annotationFontRatio:", e));
  }, []);
  const setRomanizationColor = useCallback((hex: string) => {
    setRomanizationColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_ROMANIZATION_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist romanizationColor:", e));
  }, []);
  const setRomanizationFontFamily = useCallback((family: string) => {
    setRomanizationFontFamilyState(family);
    void browser.storage.local
      .set({ [STORAGE_KEY_ROMANIZATION_FONT_FAMILY]: family })
      .catch((e) =>
        console.warn("[Loom] persist romanizationFontFamily:", e),
      );
  }, []);
  const setRomanizationFontRatio = useCallback((ratio: number) => {
    const clamped = Math.max(0.2, Math.min(1.0, ratio));
    setRomanizationFontRatioState(clamped);
    void browser.storage.local
      .set({ [STORAGE_KEY_ROMANIZATION_FONT_RATIO]: clamped })
      .catch((e) => console.warn("[Loom] persist romanizationFontRatio:", e));
  }, []);

  // Position setters use functional setState so they read the latest
  // sibling-position (the OTHER track's slot) without needing it as a
  // dep.  When the requested slot is the sibling's current slot, swap
  // — sibling takes our old slot, we take the requested slot.  Keeps
  // the {target, native} pair always at two distinct slots.
  const setTargetPosition = useCallback((pos: CaptionPosition) => {
    setTargetPositionState((prevTarget) => {
      setNativePositionState((prevNative) => {
        const next = prevNative === pos ? prevTarget : prevNative;
        void browser.storage.local
          .set({ [STORAGE_KEY_NATIVE_POSITION]: next })
          .catch((e) =>
            console.warn("[Loom] failed to persist nativePosition:", e),
          );
        return next;
      });
      void browser.storage.local
        .set({ [STORAGE_KEY_TARGET_POSITION]: pos })
        .catch((e) =>
          console.warn("[Loom] failed to persist targetPosition:", e),
        );
      return pos;
    });
  }, []);

  // Advanced layer setters — generated from a small table so we
  // don't repeat 18 useCallback declarations with identical bodies.
  // Each setter persists to its own storage key + updates state.
  const makeNumberSetter = (
    setter: React.Dispatch<React.SetStateAction<number>>,
    key: string,
    min: number,
    max: number,
  ) =>
    (v: number) => {
      const clamped = Math.max(min, Math.min(max, v));
      setter(clamped);
      void browser.storage.local.set({ [key]: clamped }).catch(() => {});
    };
  const makeHexSetter = (
    setter: React.Dispatch<React.SetStateAction<string>>,
    key: string,
  ) =>
    (v: string) => {
      setter(v);
      void browser.storage.local.set({ [key]: v }).catch(() => {});
    };
  const setTopAlpha = useCallback(
    makeNumberSetter(setTopAlphaState, STORAGE_KEY_TOP_ALPHA, 0, 100),
    [],
  );
  const setBottomAlpha = useCallback(
    makeNumberSetter(setBottomAlphaState, STORAGE_KEY_BOTTOM_ALPHA, 0, 100),
    [],
  );
  const setAnnotationAlpha = useCallback(
    makeNumberSetter(setAnnotationAlphaState, STORAGE_KEY_ANNOTATION_ALPHA, 0, 100),
    [],
  );
  const setRomanizationAlpha = useCallback(
    makeNumberSetter(
      setRomanizationAlphaState,
      STORAGE_KEY_ROMANIZATION_ALPHA,
      0,
      100,
    ),
    [],
  );
  const setTopGroupOpacityLinked = useCallback((v: boolean) => {
    setTopGroupOpacityLinkedState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_GROUP_OPACITY_LINKED]: v })
      .catch((e) => console.warn("[Loom] persist topGroupOpacityLinked:", e));
  }, []);
  const setTopLineEnabled = useCallback((v: boolean) => {
    setTopLineEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_TOP_LINE_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist topLineEnabled:", e));
  }, []);
  const setBottomLineEnabled = useCallback((v: boolean) => {
    setBottomLineEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_BOTTOM_LINE_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist bottomLineEnabled:", e));
  }, []);
  const setTopOutlineColor = useCallback(
    makeHexSetter(setTopOutlineColorState, STORAGE_KEY_TOP_OUTLINE_COLOR),
    [],
  );
  const setBottomOutlineColor = useCallback(
    makeHexSetter(setBottomOutlineColorState, STORAGE_KEY_BOTTOM_OUTLINE_COLOR),
    [],
  );
  const setAnnotationOutlineColor = useCallback(
    makeHexSetter(setAnnotationOutlineColorState, STORAGE_KEY_ANNOTATION_OUTLINE_COLOR),
    [],
  );
  const setTopOutlineAlpha = useCallback(
    makeNumberSetter(setTopOutlineAlphaState, STORAGE_KEY_TOP_OUTLINE_ALPHA, 0, 100),
    [],
  );
  const setBottomOutlineAlpha = useCallback(
    makeNumberSetter(setBottomOutlineAlphaState, STORAGE_KEY_BOTTOM_OUTLINE_ALPHA, 0, 100),
    [],
  );
  const setAnnotationOutlineAlpha = useCallback(
    makeNumberSetter(setAnnotationOutlineAlphaState, STORAGE_KEY_ANNOTATION_OUTLINE_ALPHA, 0, 100),
    [],
  );
  const setTopGlowRadius = useCallback(
    makeNumberSetter(setTopGlowRadiusState, STORAGE_KEY_TOP_GLOW_RADIUS, 0, 50),
    [],
  );
  const setBottomGlowRadius = useCallback(
    makeNumberSetter(setBottomGlowRadiusState, STORAGE_KEY_BOTTOM_GLOW_RADIUS, 0, 50),
    [],
  );
  const setAnnotationGlowRadius = useCallback(
    makeNumberSetter(setAnnotationGlowRadiusState, STORAGE_KEY_ANNOTATION_GLOW_RADIUS, 0, 50),
    [],
  );
  const setTopGlowColor = useCallback(
    makeHexSetter(setTopGlowColorState, STORAGE_KEY_TOP_GLOW_COLOR),
    [],
  );
  const setBottomGlowColor = useCallback(
    makeHexSetter(setBottomGlowColorState, STORAGE_KEY_BOTTOM_GLOW_COLOR),
    [],
  );
  const setAnnotationGlowColor = useCallback(
    makeHexSetter(setAnnotationGlowColorState, STORAGE_KEY_ANNOTATION_GLOW_COLOR),
    [],
  );
  const setTopGlowAlpha = useCallback(
    makeNumberSetter(setTopGlowAlphaState, STORAGE_KEY_TOP_GLOW_ALPHA, 0, 100),
    [],
  );
  const setBottomGlowAlpha = useCallback(
    makeNumberSetter(setBottomGlowAlphaState, STORAGE_KEY_BOTTOM_GLOW_ALPHA, 0, 100),
    [],
  );
  const setAnnotationGlowAlpha = useCallback(
    makeNumberSetter(setAnnotationGlowAlphaState, STORAGE_KEY_ANNOTATION_GLOW_ALPHA, 0, 100),
    [],
  );

  const setTargetVariantEnabled = useCallback((v: boolean) => {
    setTargetVariantEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_TARGET_VARIANT_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist targetVariantEnabled:", e));
  }, []);
  const setNativeVariantEnabled = useCallback((v: boolean) => {
    setNativeVariantEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_NATIVE_VARIANT_ENABLED]: v })
      .catch((e) => console.warn("[Loom] persist nativeVariantEnabled:", e));
  }, []);
  const setVariantHighlightEnabled = useCallback((v: boolean) => {
    setVariantHighlightEnabledState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_HIGHLIGHT]: v })
      .catch((e) => console.warn("[Loom] persist variantHighlightEnabled:", e));
  }, []);
  const setVariantColor = useCallback((hex: string) => {
    setVariantColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantColor:", e));
  }, []);
  const setVariantCleanColor = useCallback((hex: string) => {
    setVariantCleanColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_CLEAN_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantCleanColor:", e));
  }, []);
  const setVariantCollapseColor = useCallback((hex: string) => {
    setVariantCollapseColorState(hex);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_COLLAPSE_COLOR]: hex })
      .catch((e) => console.warn("[Loom] persist variantCollapseColor:", e));
  }, []);
  const setVariantColorSameAsTop = useCallback((v: boolean) => {
    setVariantColorSameAsTopState(v);
    void browser.storage.local
      .set({ [STORAGE_KEY_VARIANT_COLOR_SAME_AS_TOP]: v })
      .catch((e) => console.warn("[Loom] persist variantColorSameAsTop:", e));
  }, []);

  const setTargetAnnotateEnabled = useCallback((v: boolean) => {
    discoverSetTargetAnnotateEnabled(v);
  }, []);
  const setNativeAnnotateEnabled = useCallback((v: boolean) => {
    discoverSetNativeAnnotateEnabled(v);
  }, []);
  const setTargetPhoneticSystem = useCallback((code: string | null) => {
    discoverSetTargetPhoneticSystem(code);
  }, []);
  const setNativePhoneticSystem = useCallback((code: string | null) => {
    discoverSetNativePhoneticSystem(code);
  }, []);
  const setTargetRomanizeEnabled = useCallback((v: boolean) => {
    discoverSetTargetRomanizeEnabled(v);
  }, []);
  const setNativeRomanizeEnabled = useCallback((v: boolean) => {
    discoverSetNativeRomanizeEnabled(v);
  }, []);
  const setLongVowelMode = useCallback(
    (mode: "macrons" | "doubled" | "unmarked") => {
      discoverSetLongVowelMode(mode);
    },
    [],
  );

  const setNativePosition = useCallback((pos: CaptionPosition) => {
    setNativePositionState((prevNative) => {
      setTargetPositionState((prevTarget) => {
        const next = prevTarget === pos ? prevNative : prevTarget;
        void browser.storage.local
          .set({ [STORAGE_KEY_TARGET_POSITION]: next })
          .catch((e) =>
            console.warn("[Loom] failed to persist targetPosition:", e),
          );
        return next;
      });
      void browser.storage.local
        .set({ [STORAGE_KEY_NATIVE_POSITION]: pos })
        .catch((e) =>
          console.warn("[Loom] failed to persist nativePosition:", e),
        );
      return pos;
    });
  }, []);

  const value = useMemo<CaptionContextValue>(
    () => ({
      status,
      target,
      native,
      targets,
      natives,
      stream,
      tracks,
      selectedTarget,
      selectedNative,
      isUserPickedTarget,
      isUserPickedNative,
      targetTranslateTo,
      nativeTranslateTo,
      nativeLangPref,
      topColor,
      bottomColor,
      annotationColor,
      topFontFamily,
      bottomFontFamily,
      annotationFontFamily,
      topFontSizePx,
      bottomFontSizePx,
      captionSizePct,
      topPositionOffsetPct,
      bottomPositionOffsetPct,
      lineSpacingPx,
      annotationFontRatio,
      romanizationFontFamily,
      romanizationFontRatio,
      romanizationColor,
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
      targetTokenMap,
      nativeTokenMap,
      targetRomanizeEnabled,
      nativeRomanizeEnabled,
      longVowelMode,
      targetRomanizeMap,
      nativeRomanizeMap,
      targetVariantEnabled,
      nativeVariantEnabled,
      variantHighlightEnabled,
      variantColor,
      variantCleanColor,
      variantCollapseColor,
      variantColorSameAsTop,
      presetCatalog,
      activePresetId,
      applyPreset,
      setActivePresetId,
      topAlpha,
      bottomAlpha,
      annotationAlpha,
      romanizationAlpha,
      topGroupOpacityLinked,
      topLineEnabled,
      bottomLineEnabled,
      topOutlineColor,
      bottomOutlineColor,
      annotationOutlineColor,
      topOutlineAlpha,
      bottomOutlineAlpha,
      annotationOutlineAlpha,
      topGlowRadius,
      bottomGlowRadius,
      annotationGlowRadius,
      topGlowColor,
      bottomGlowColor,
      annotationGlowColor,
      topGlowAlpha,
      bottomGlowAlpha,
      annotationGlowAlpha,
      setTopAlpha,
      setBottomAlpha,
      setAnnotationAlpha,
      setRomanizationAlpha,
      setTopGroupOpacityLinked,
      setTopLineEnabled,
      setBottomLineEnabled,
      setTopOutlineColor,
      setBottomOutlineColor,
      setAnnotationOutlineColor,
      setTopOutlineAlpha,
      setBottomOutlineAlpha,
      setAnnotationOutlineAlpha,
      setTopGlowRadius,
      setBottomGlowRadius,
      setAnnotationGlowRadius,
      setTopGlowColor,
      setBottomGlowColor,
      setAnnotationGlowColor,
      setTopGlowAlpha,
      setBottomGlowAlpha,
      setAnnotationGlowAlpha,
      setTargetTrack,
      setNativeTrack,
      setTargetTranslateTo,
      setNativeTranslateTo,
      setNativeLangPref,
      setTopColor,
      setBottomColor,
      setAnnotationColor,
      setTopFontFamily,
      setBottomFontFamily,
      setAnnotationFontFamily,
      setTopFontSizePx,
      setBottomFontSizePx,
      setCaptionSizePct,
      setTopPositionOffsetPct,
      setBottomPositionOffsetPct,
      setLineSpacingPx,
      setAnnotationFontRatio,
      setRomanizationColor,
      setRomanizationFontFamily,
      setRomanizationFontRatio,
      setTargetPosition,
      setNativePosition,
      setTargetAnnotateEnabled,
      setNativeAnnotateEnabled,
      setTargetPhoneticSystem,
      setNativePhoneticSystem,
      setTargetRomanizeEnabled,
      setNativeRomanizeEnabled,
      setLongVowelMode,
      setTargetVariantEnabled,
      setNativeVariantEnabled,
      setVariantHighlightEnabled,
      setVariantColor,
      setVariantCleanColor,
      setVariantCollapseColor,
      setVariantColorSameAsTop,
    }),
    [
      status,
      target,
      native,
      targets,
      natives,
      stream,
      tracks,
      selectedTarget,
      selectedNative,
      isUserPickedTarget,
      isUserPickedNative,
      targetTranslateTo,
      nativeTranslateTo,
      nativeLangPref,
      topColor,
      bottomColor,
      annotationColor,
      topFontFamily,
      bottomFontFamily,
      annotationFontFamily,
      topFontSizePx,
      bottomFontSizePx,
      captionSizePct,
      topPositionOffsetPct,
      bottomPositionOffsetPct,
      lineSpacingPx,
      annotationFontRatio,
      romanizationFontFamily,
      romanizationFontRatio,
      romanizationColor,
      targetPosition,
      nativePosition,
      targetAnnotateEnabled,
      nativeAnnotateEnabled,
      targetPhoneticSystem,
      nativePhoneticSystem,
      targetAnnotateMap,
      nativeAnnotateMap,
      targetTokenMap,
      nativeTokenMap,
      targetRomanizeEnabled,
      nativeRomanizeEnabled,
      longVowelMode,
      targetRomanizeMap,
      nativeRomanizeMap,
      targetVariantEnabled,
      nativeVariantEnabled,
      variantHighlightEnabled,
      variantColor,
      variantCleanColor,
      variantCollapseColor,
      variantColorSameAsTop,
      presetCatalog,
      activePresetId,
      applyPreset,
      setActivePresetId,
      topAlpha,
      bottomAlpha,
      annotationAlpha,
      romanizationAlpha,
      topGroupOpacityLinked,
      topLineEnabled,
      bottomLineEnabled,
      topOutlineColor,
      bottomOutlineColor,
      annotationOutlineColor,
      topOutlineAlpha,
      bottomOutlineAlpha,
      annotationOutlineAlpha,
      topGlowRadius,
      bottomGlowRadius,
      annotationGlowRadius,
      topGlowColor,
      bottomGlowColor,
      annotationGlowColor,
      topGlowAlpha,
      bottomGlowAlpha,
      annotationGlowAlpha,
      setTopAlpha,
      setBottomAlpha,
      setAnnotationAlpha,
      setRomanizationAlpha,
      setTopGroupOpacityLinked,
      setTopLineEnabled,
      setBottomLineEnabled,
      setTopOutlineColor,
      setBottomOutlineColor,
      setAnnotationOutlineColor,
      setTopOutlineAlpha,
      setBottomOutlineAlpha,
      setAnnotationOutlineAlpha,
      setTopGlowRadius,
      setBottomGlowRadius,
      setAnnotationGlowRadius,
      setTopGlowColor,
      setBottomGlowColor,
      setAnnotationGlowColor,
      setTopGlowAlpha,
      setBottomGlowAlpha,
      setAnnotationGlowAlpha,
      setTargetTrack,
      setNativeTrack,
      setTargetTranslateTo,
      setNativeTranslateTo,
      setNativeLangPref,
      setTopColor,
      setBottomColor,
      setAnnotationColor,
      setTopFontFamily,
      setBottomFontFamily,
      setAnnotationFontFamily,
      setTopFontSizePx,
      setBottomFontSizePx,
      setCaptionSizePct,
      setTopPositionOffsetPct,
      setBottomPositionOffsetPct,
      setLineSpacingPx,
      setAnnotationFontRatio,
      setRomanizationColor,
      setRomanizationFontFamily,
      setRomanizationFontRatio,
      setTargetPosition,
      setNativePosition,
      setTargetAnnotateEnabled,
      setNativeAnnotateEnabled,
      setTargetPhoneticSystem,
      setNativePhoneticSystem,
      setTargetRomanizeEnabled,
      setNativeRomanizeEnabled,
      setLongVowelMode,
      setTargetVariantEnabled,
      setNativeVariantEnabled,
      setVariantHighlightEnabled,
      setVariantColor,
      setVariantCleanColor,
      setVariantCollapseColor,
      setVariantColorSameAsTop,
    ],
  );

  return (
    <CaptionContext.Provider value={value}>{children}</CaptionContext.Provider>
  );
}

export function useCaptionStream(): CaptionContextValue {
  const value = useContext(CaptionContext);
  if (!value) {
    throw new Error(
      "useCaptionStream must be called inside <CaptionStreamProvider>",
    );
  }
  return value;
}
