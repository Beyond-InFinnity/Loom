// Desktop player settings model — the same `loom_*` keys the extension uses,
// stored in the shared cross-window store (host.ts).  The main window's
// SettingsPanel writes them; the player window reads them and applies them
// to its subtitle rendering.  Both windows stay in sync via the store's
// change broadcast.
//
// This is a desktop-local model (Connor's chosen isolated approach) — it
// deliberately does NOT import the extension's caption-context, so the
// extension carries zero risk.  Key names match so the two could converge
// later.

import { useCallback, useEffect, useState } from "react";
import { getApiClient } from "@loom/player-ui/api-client";
import type { Preset, PresetLayerColors } from "@loom/player-ui/presets/types";
import { readCached, storage } from "../player/host";

export type CaptionPosition = "top-1" | "top-2" | "bottom-1" | "bottom-2";
export type LongVowelMode = "macrons" | "doubled" | "unmarked";

// ---- Brainbow (Loom Default) --------------------------------------------
// The client-side factory preset — same id + pastel colors as the extension's
// LOOMINATE_DEFAULT_PRESET (apps/extension/components/caption-context.tsx).
// Defined here (the desktop's isolated model, not imported from the extension)
// and kept in lockstep.  BOTH the per-layer default colors AND the preset
// object below derive from these consts so they can never drift.
export const LOOMINATE_DEFAULT_PRESET_ID = "loominate-default";
const BRAINBOW = {
  bottom: "#fbf3c4", // native (custard/cream)
  top: "#bdb2ff", // foreign (pastel purple)
  annotation: "#ffadad", // per-token reading (pastel red)
  romanization: "#caffbf", // phonetic line (pastel green)
} as const;

function brainbowLayer(color: string): PresetLayerColors {
  return {
    color,
    opacity: 100,
    outline_color: "#000000",
    outline_opacity: 90,
    glow_color: null,
    glow_opacity: null,
  };
}

/** The client-side "Brainbow (Loom Default)" preset, injected at the top of the
    preset picker (the server catalog holds the 28 language presets). */
export const LOOMINATE_DEFAULT_PRESET: Preset = {
  id: LOOMINATE_DEFAULT_PRESET_ID,
  label: "Brainbow (Loom Default)",
  description: "Loom's default pastel colors.",
  group: "loom",
  languages: null,
  layers: {
    Bottom: brainbowLayer(BRAINBOW.bottom),
    Top: brainbowLayer(BRAINBOW.top),
    Annotation: brainbowLayer(BRAINBOW.annotation),
    Romanized: brainbowLayer(BRAINBOW.romanization),
  },
};

// ---- keys + defaults ----------------------------------------------------
export const SETTINGS = {
  // presets
  activePresetId: {
    key: "loom_active_preset_id",
    def: LOOMINATE_DEFAULT_PRESET_ID as string,
  },
  // per-layer color (fresh-install default = the Brainbow palette)
  topColor: { key: "loom_top_color", def: BRAINBOW.top },
  bottomColor: { key: "loom_bottom_color", def: BRAINBOW.bottom },
  annotationColor: { key: "loom_annotation_color", def: BRAINBOW.annotation },
  romanizationColor: { key: "loom_romanization_color", def: BRAINBOW.romanization },
  // per-layer size
  topFontSizePx: { key: "loom_top_font_size_px", def: 38 },
  bottomFontSizePx: { key: "loom_bottom_font_size_px", def: 30 },
  annotationFontRatio: { key: "loom_annotation_font_ratio", def: 0.5 },
  romanizationFontRatio: { key: "loom_romanization_font_ratio", def: 0.58 },
  captionSizePct: { key: "loom_caption_size_pct", def: 100 },
  // per-layer font family ("auto" = cross-script Noto fallback stack)
  topFontFamily: { key: "loom_top_font_family", def: "auto" },
  bottomFontFamily: { key: "loom_bottom_font_family", def: "auto" },
  annotationFontFamily: { key: "loom_annotation_font_family", def: "auto" },
  romanizationFontFamily: { key: "loom_romanization_font_family", def: "auto" },
  // per-layer opacity (0–100)
  topAlpha: { key: "loom_top_alpha", def: 100 },
  bottomAlpha: { key: "loom_bottom_alpha", def: 100 },
  annotationAlpha: { key: "loom_annotation_alpha", def: 100 },
  romanizationAlpha: { key: "loom_romanization_alpha", def: 100 },
  // per-layer outline
  topOutlineColor: { key: "loom_top_outline_color", def: "#000000" },
  bottomOutlineColor: { key: "loom_bottom_outline_color", def: "#000000" },
  annotationOutlineColor: { key: "loom_annotation_outline_color", def: "#000000" },
  romanizationOutlineColor: { key: "loom_romanization_outline_color", def: "#000000" },
  topOutlineAlpha: { key: "loom_top_outline_alpha", def: 100 },
  bottomOutlineAlpha: { key: "loom_bottom_outline_alpha", def: 100 },
  annotationOutlineAlpha: { key: "loom_annotation_outline_alpha", def: 100 },
  romanizationOutlineAlpha: { key: "loom_romanization_outline_alpha", def: 100 },
  // per-layer glow
  topGlowRadius: { key: "loom_top_glow_radius", def: 0 },
  bottomGlowRadius: { key: "loom_bottom_glow_radius", def: 0 },
  annotationGlowRadius: { key: "loom_annotation_glow_radius", def: 0 },
  romanizationGlowRadius: { key: "loom_romanization_glow_radius", def: 0 },
  topGlowColor: { key: "loom_top_glow_color", def: "#ffff88" },
  bottomGlowColor: { key: "loom_bottom_glow_color", def: "#ffff88" },
  annotationGlowColor: { key: "loom_annotation_glow_color", def: "#ffff88" },
  romanizationGlowColor: { key: "loom_romanization_glow_color", def: "#ffff88" },
  topGlowAlpha: { key: "loom_top_glow_alpha", def: 100 },
  bottomGlowAlpha: { key: "loom_bottom_glow_alpha", def: 100 },
  annotationGlowAlpha: { key: "loom_annotation_glow_alpha", def: 100 },
  romanizationGlowAlpha: { key: "loom_romanization_glow_alpha", def: 100 },
  // per-line show/hide
  topLineEnabled: { key: "loom_top_line_enabled", def: true },
  bottomLineEnabled: { key: "loom_bottom_line_enabled", def: true },
  // phonetic + toggles
  targetAnnotateEnabled: { key: "loom_target_annotate_enabled", def: true },
  targetRomanizeEnabled: { key: "loom_target_romanize_enabled", def: true },
  targetPhoneticSystem: { key: "loom_target_phonetic_system", def: null as string | null },
  longVowelMode: { key: "loom_long_vowel_mode", def: "macrons" as LongVowelMode },
  // layout / position
  targetPosition: { key: "loom_target_position", def: "top-1" as CaptionPosition },
  nativePosition: { key: "loom_native_position", def: "bottom-2" as CaptionPosition },
  topPositionOffsetPct: { key: "loom_top_position_offset_pct", def: 0 },
  bottomPositionOffsetPct: { key: "loom_bottom_position_offset_pct", def: 0 },
  lineSpacingPx: { key: "loom_line_spacing_px", def: 0 },
  // track selection (player ⇄ panel via the shared store; ids are valid for
  // the CURRENTLY loaded file — the player resets them to its auto-pick on
  // every media load, so a stale id from a previous file never leaks)
  targetTrackId: { key: "loom_target_track_id", def: null as string | null },
  nativeTrackId: { key: "loom_native_track_id", def: null as string | null },
  // the user's own language (auto-pick base for the Bottom track).  "" =
  // follow navigator.language.
  nativeLangPref: { key: "loom_native_lang_pref", def: "" as string },
} as const;

export type SettingName = keyof typeof SETTINGS;
// Widen literal defaults (38 → number, "#fff" → string, true → boolean) so
// setters accept any value of the type; preserve declared unions
// (CaptionPosition, LongVowelMode, string | null) which are already widened
// via explicit `as` annotations on their defs.
type Widen<T> = [T] extends [CaptionPosition]
  ? CaptionPosition
  : [T] extends [LongVowelMode]
    ? LongVowelMode
    : T extends number
      ? number
      : T extends boolean
        ? boolean
        : null extends T
          ? string | null
          : T extends string
            ? string
            : T;
type ValOf<K extends SettingName> = Widen<(typeof SETTINGS)[K]["def"]>;

/** Synchronous current value from the warm cache (falls back to default). */
export function getSetting<K extends SettingName>(name: K): ValOf<K> {
  const { key, def } = SETTINGS[name];
  return readCached(key as string, def as ValOf<K>);
}

/** Reactive setting: [value, set] backed by the shared store; updates when
    ANY window changes it (cross-window sync). */
export function useSetting<K extends SettingName>(
  name: K,
): [ValOf<K>, (v: ValOf<K>) => void] {
  const key = SETTINGS[name].key as string;
  const def = SETTINGS[name].def as ValOf<K>;
  const [value, setValue] = useState<ValOf<K>>(() => readCached(key, def));

  useEffect(() => {
    // Re-sync on mount (cache may have warmed after first render).
    setValue(readCached(key, def));
    return storage.onChanged((changes: Record<string, unknown>) => {
      if (key in changes) setValue(readCached(key, def));
    });
  }, [key]);

  const set = useCallback(
    (v: ValOf<K>) => {
      setValue(v);
      void storage.set({ [key]: v as unknown });
    },
    [key],
  );
  return [value, set];
}

// ---- player → panel track publishing ------------------------------------
// The player window loads the media and knows its tracks; the settings panel
// (a separate window) renders the pickers.  The player publishes a lightweight
// serialization of the loaded file's tracks to the shared store; the panel
// reads it reactively.  Ephemeral: overwritten on each media load.
export interface PublishedTrack {
  id: string;
  name: string;
  languageCode: string;
  kind: string; // "manual" | "asr" | …
}
const TRACKS_KEY = "loom_player_tracks";

/** Player window: publish the loaded file's tracks for the panel's pickers. */
export function publishTracks(tracks: PublishedTrack[]): void {
  void storage.set({ [TRACKS_KEY]: tracks });
}

/** Panel: the loaded file's tracks, live (empty until a file is open). */
export function usePlayerTracks(): PublishedTrack[] {
  const [tracks, setTracks] = useState<PublishedTrack[]>(() =>
    readCached<PublishedTrack[]>(TRACKS_KEY, []),
  );
  useEffect(() => {
    setTracks(readCached<PublishedTrack[]>(TRACKS_KEY, []));
    return storage.onChanged((c: Record<string, unknown>) => {
      if (TRACKS_KEY in c) setTracks(readCached<PublishedTrack[]>(TRACKS_KEY, []));
    });
  }, []);
  return tracks;
}

/** Apply a whole preset's layer colors at once (used by the preset grid). */
export async function applyLayerColors(colors: {
  top?: string;
  bottom?: string;
  annotation?: string;
  romanization?: string;
}): Promise<void> {
  const items: Record<string, unknown> = {};
  if (colors.top) items[SETTINGS.topColor.key] = colors.top;
  if (colors.bottom) items[SETTINGS.bottomColor.key] = colors.bottom;
  if (colors.annotation) items[SETTINGS.annotationColor.key] = colors.annotation;
  if (colors.romanization)
    items[SETTINGS.romanizationColor.key] = colors.romanization;
  await storage.set(items);
}

// ---- computed styles the player applies --------------------------------

function hexToRgba(hex: string, alphaPct: number): string {
  const h = hex.replace("#", "");
  const n =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.padEnd(6, "0").slice(0, 6);
  const r = parseInt(n.slice(0, 2), 16) || 0;
  const g = parseInt(n.slice(2, 4), 16) || 0;
  const b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alphaPct / 100))})`;
}

/** 8-direction outline ring + optional glow blur, alpha-scaled by the
    layer's master opacity (mirrors the extension overlay's buildTextShadow). */
function layerShadow(o: {
  outlineColor: string;
  outlineAlpha: number;
  glowRadius: number;
  glowColor: string;
  glowAlpha: number;
  masterAlpha: number;
}): string {
  const parts: string[] = [];
  const oc = hexToRgba(o.outlineColor, (o.outlineAlpha * o.masterAlpha) / 100);
  const d = 1.5;
  for (const [dx, dy] of [
    [-d, -d], [0, -d], [d, -d], [d, 0], [d, d], [0, d], [-d, d], [-d, 0],
  ]) {
    parts.push(`${dx}px ${dy}px 0 ${oc}`);
  }
  if (o.glowRadius > 0) {
    const gc = hexToRgba(o.glowColor, (o.glowAlpha * o.masterAlpha) / 100);
    parts.push(`0 0 ${o.glowRadius}px ${gc}`);
    parts.push(`0 0 ${o.glowRadius * 2}px ${gc}`);
  }
  return parts.join(", ");
}

// "auto" → the cross-script Noto fallback stack the overlay has always used;
// any other value is a full CSS font-family string applied verbatim.
const AUTO_FONT_STACK =
  "'Noto Sans CJK JP','Noto Sans JP','Noto Sans SC','Noto Sans KR',sans-serif";
function resolveFont(family: string): string {
  return !family || family === "auto" ? AUTO_FONT_STACK : family;
}

export interface LayerStyle {
  color: string;
  opacity: number; // 0–1, for fill alpha
  shadow: string;
  fontFamily: string;
}

export interface PlayerStyles {
  annotateEnabled: boolean;
  romanizeEnabled: boolean;
  phoneticSystem: string | null;
  longVowelMode: LongVowelMode;
  captionScale: number; // captionSizePct/100
  lineSpacingPx: number;
  topSlot: CaptionPosition;
  nativeSlot: CaptionPosition;
  topLineEnabled: boolean;
  bottomLineEnabled: boolean;
  topFontSizePx: number;
  bottomFontSizePx: number;
  annotationFontRatio: number;
  romanizationFontRatio: number;
  top: LayerStyle;
  bottom: LayerStyle;
  annotation: LayerStyle;
  romanization: LayerStyle;
}

/** One hook the player calls to get every settings-driven style, live. */
export function usePlayerStyles(): PlayerStyles {
  const [annotateEnabled] = useSetting("targetAnnotateEnabled");
  const [romanizeEnabled] = useSetting("targetRomanizeEnabled");
  const [phoneticSystem] = useSetting("targetPhoneticSystem");
  const [longVowelMode] = useSetting("longVowelMode");
  const [captionSizePct] = useSetting("captionSizePct");
  const [lineSpacingPx] = useSetting("lineSpacingPx");
  const [topSlot] = useSetting("targetPosition");
  const [nativeSlot] = useSetting("nativePosition");
  const [topLineEnabled] = useSetting("topLineEnabled");
  const [bottomLineEnabled] = useSetting("bottomLineEnabled");
  const [topFontSizePx] = useSetting("topFontSizePx");
  const [bottomFontSizePx] = useSetting("bottomFontSizePx");
  const [annotationFontRatio] = useSetting("annotationFontRatio");
  const [romanizationFontRatio] = useSetting("romanizationFontRatio");
  const [topFontFamily] = useSetting("topFontFamily");
  const [bottomFontFamily] = useSetting("bottomFontFamily");
  const [annotationFontFamily] = useSetting("annotationFontFamily");
  const [romanizationFontFamily] = useSetting("romanizationFontFamily");

  const [topColor] = useSetting("topColor");
  const [bottomColor] = useSetting("bottomColor");
  const [annotationColor] = useSetting("annotationColor");
  const [romanizationColor] = useSetting("romanizationColor");
  const [topAlpha] = useSetting("topAlpha");
  const [bottomAlpha] = useSetting("bottomAlpha");
  const [annotationAlpha] = useSetting("annotationAlpha");
  const [romanizationAlpha] = useSetting("romanizationAlpha");
  const [topOutlineColor] = useSetting("topOutlineColor");
  const [bottomOutlineColor] = useSetting("bottomOutlineColor");
  const [annotationOutlineColor] = useSetting("annotationOutlineColor");
  const [topOutlineAlpha] = useSetting("topOutlineAlpha");
  const [bottomOutlineAlpha] = useSetting("bottomOutlineAlpha");
  const [annotationOutlineAlpha] = useSetting("annotationOutlineAlpha");
  const [topGlowRadius] = useSetting("topGlowRadius");
  const [bottomGlowRadius] = useSetting("bottomGlowRadius");
  const [annotationGlowRadius] = useSetting("annotationGlowRadius");
  const [topGlowColor] = useSetting("topGlowColor");
  const [bottomGlowColor] = useSetting("bottomGlowColor");
  const [annotationGlowColor] = useSetting("annotationGlowColor");
  const [topGlowAlpha] = useSetting("topGlowAlpha");
  const [bottomGlowAlpha] = useSetting("bottomGlowAlpha");
  const [annotationGlowAlpha] = useSetting("annotationGlowAlpha");
  const [romanizationOutlineColor] = useSetting("romanizationOutlineColor");
  const [romanizationOutlineAlpha] = useSetting("romanizationOutlineAlpha");
  const [romanizationGlowRadius] = useSetting("romanizationGlowRadius");
  const [romanizationGlowColor] = useSetting("romanizationGlowColor");
  const [romanizationGlowAlpha] = useSetting("romanizationGlowAlpha");

  const topL: LayerStyle = {
    color: topColor,
    opacity: topAlpha / 100,
    fontFamily: resolveFont(topFontFamily),
    shadow: layerShadow({
      outlineColor: topOutlineColor, outlineAlpha: topOutlineAlpha,
      glowRadius: topGlowRadius, glowColor: topGlowColor, glowAlpha: topGlowAlpha,
      masterAlpha: topAlpha,
    }),
  };
  const bottomL: LayerStyle = {
    color: bottomColor,
    opacity: bottomAlpha / 100,
    fontFamily: resolveFont(bottomFontFamily),
    shadow: layerShadow({
      outlineColor: bottomOutlineColor, outlineAlpha: bottomOutlineAlpha,
      glowRadius: bottomGlowRadius, glowColor: bottomGlowColor, glowAlpha: bottomGlowAlpha,
      masterAlpha: bottomAlpha,
    }),
  };
  const annotationL: LayerStyle = {
    color: annotationColor,
    opacity: annotationAlpha / 100,
    fontFamily: resolveFont(annotationFontFamily),
    shadow: layerShadow({
      outlineColor: annotationOutlineColor, outlineAlpha: annotationOutlineAlpha,
      glowRadius: annotationGlowRadius, glowColor: annotationGlowColor, glowAlpha: annotationGlowAlpha,
      masterAlpha: annotationAlpha,
    }),
  };
  const romanizationL: LayerStyle = {
    color: romanizationColor,
    opacity: romanizationAlpha / 100,
    fontFamily: resolveFont(romanizationFontFamily),
    shadow: layerShadow({
      outlineColor: romanizationOutlineColor, outlineAlpha: romanizationOutlineAlpha,
      glowRadius: romanizationGlowRadius, glowColor: romanizationGlowColor, glowAlpha: romanizationGlowAlpha,
      masterAlpha: romanizationAlpha,
    }),
  };

  return {
    annotateEnabled, romanizeEnabled, phoneticSystem, longVowelMode,
    captionScale: captionSizePct / 100,
    lineSpacingPx,
    topSlot, nativeSlot, topLineEnabled, bottomLineEnabled,
    topFontSizePx, bottomFontSizePx, annotationFontRatio, romanizationFontRatio,
    top: topL, bottom: bottomL, annotation: annotationL, romanization: romanizationL,
  };
}

export { getApiClient };
