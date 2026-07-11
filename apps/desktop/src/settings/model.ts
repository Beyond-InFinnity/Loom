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
import { readCached, storage } from "../player/host";

export type CaptionPosition = "top-1" | "top-2" | "bottom-1" | "bottom-2";
export type LongVowelMode = "macrons" | "doubled" | "unmarked";

// ---- keys + defaults ----------------------------------------------------
export const SETTINGS = {
  // presets
  activePresetId: { key: "loom_active_preset_id", def: "" as string },
  // per-layer color
  topColor: { key: "loom_top_color", def: "#f5f0e8" },
  bottomColor: { key: "loom_bottom_color", def: "#ffffff" },
  annotationColor: { key: "loom_annotation_color", def: "#cfe8ff" },
  romanizationColor: { key: "loom_romanization_color", def: "#e8dcc8" },
  // per-layer size
  topFontSizePx: { key: "loom_top_font_size_px", def: 38 },
  bottomFontSizePx: { key: "loom_bottom_font_size_px", def: 30 },
  annotationFontRatio: { key: "loom_annotation_font_ratio", def: 0.5 },
  romanizationFontRatio: { key: "loom_romanization_font_ratio", def: 0.58 },
  captionSizePct: { key: "loom_caption_size_pct", def: 100 },
  // per-layer opacity (0–100)
  topAlpha: { key: "loom_top_alpha", def: 100 },
  bottomAlpha: { key: "loom_bottom_alpha", def: 100 },
  annotationAlpha: { key: "loom_annotation_alpha", def: 100 },
  romanizationAlpha: { key: "loom_romanization_alpha", def: 100 },
  // per-layer outline
  topOutlineColor: { key: "loom_top_outline_color", def: "#000000" },
  bottomOutlineColor: { key: "loom_bottom_outline_color", def: "#000000" },
  annotationOutlineColor: { key: "loom_annotation_outline_color", def: "#000000" },
  topOutlineAlpha: { key: "loom_top_outline_alpha", def: 100 },
  bottomOutlineAlpha: { key: "loom_bottom_outline_alpha", def: 100 },
  annotationOutlineAlpha: { key: "loom_annotation_outline_alpha", def: 100 },
  // per-layer glow
  topGlowRadius: { key: "loom_top_glow_radius", def: 0 },
  bottomGlowRadius: { key: "loom_bottom_glow_radius", def: 0 },
  annotationGlowRadius: { key: "loom_annotation_glow_radius", def: 0 },
  topGlowColor: { key: "loom_top_glow_color", def: "#ffff88" },
  bottomGlowColor: { key: "loom_bottom_glow_color", def: "#ffff88" },
  annotationGlowColor: { key: "loom_annotation_glow_color", def: "#ffff88" },
  topGlowAlpha: { key: "loom_top_glow_alpha", def: 100 },
  bottomGlowAlpha: { key: "loom_bottom_glow_alpha", def: 100 },
  annotationGlowAlpha: { key: "loom_annotation_glow_alpha", def: 100 },
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

export interface LayerStyle {
  color: string;
  opacity: number; // 0–1, for fill alpha
  shadow: string;
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

  const topL: LayerStyle = {
    color: topColor,
    opacity: topAlpha / 100,
    shadow: layerShadow({
      outlineColor: topOutlineColor, outlineAlpha: topOutlineAlpha,
      glowRadius: topGlowRadius, glowColor: topGlowColor, glowAlpha: topGlowAlpha,
      masterAlpha: topAlpha,
    }),
  };
  const bottomL: LayerStyle = {
    color: bottomColor,
    opacity: bottomAlpha / 100,
    shadow: layerShadow({
      outlineColor: bottomOutlineColor, outlineAlpha: bottomOutlineAlpha,
      glowRadius: bottomGlowRadius, glowColor: bottomGlowColor, glowAlpha: bottomGlowAlpha,
      masterAlpha: bottomAlpha,
    }),
  };
  const annotationL: LayerStyle = {
    color: annotationColor,
    opacity: annotationAlpha / 100,
    shadow: layerShadow({
      outlineColor: annotationOutlineColor, outlineAlpha: annotationOutlineAlpha,
      glowRadius: annotationGlowRadius, glowColor: annotationGlowColor, glowAlpha: annotationGlowAlpha,
      masterAlpha: annotationAlpha,
    }),
  };
  const romanizationL: LayerStyle = {
    color: romanizationColor,
    opacity: romanizationAlpha / 100,
    shadow: topL.shadow,
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
