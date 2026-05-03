// Mirrors apps/desktop/src/styles.ts::StyleConfig — the same UI shape
// drives both engines.  Long-term this lives in a shared package once
// a third consumer exists; for now we accept bounded drift (the same
// drift risk noted in CLAUDE.md for the api-client backfill).
//
// PascalCase wire alias used for ASS style names (matches Python's
// loom_core/subs/processing.py::generate_ass_file output).

export type LayerKey = "bottom" | "top" | "romanized" | "annotation";

export const LAYER_WIRE: Record<LayerKey, string> = {
  bottom: "Bottom",
  top: "Top",
  romanized: "Romanized",
  annotation: "Annotation",
};

export type LongVowelMode = "macrons" | "doubled" | "unmarked";

export type LayerStyle = {
  enabled: boolean;
  fontname: string;
  fontsize: number;
  bold: boolean;
  italic: boolean;
  primarycolor: string;     // #RRGGBB
  primary_opacity: number;  // 0–100
  outlinecolor: string;
  outline_opacity: number;
  backcolor: string;
  back_opacity: number;
  outline_enabled: boolean;
  outline: number;          // px
  shadow_enabled: boolean;
  shadow: number;           // px
  background_enabled: boolean;
  glow_enabled: boolean;
  glow_radius: number;      // 1–20 px
  glow_color_hex: string;
  alignment: number;        // numpad: 1–9
  marginl: number;
  marginr: number;
  marginv: number;
};

export type StyleConfig = {
  bottom: LayerStyle;
  top: LayerStyle;
  romanized: LayerStyle & { long_vowel_mode: LongVowelMode };
  annotation: LayerStyle;
  vertical_offset: number;
  annotation_gap: number;
  romanized_gap: number;
};

function baseLayer(): LayerStyle {
  return {
    enabled: true,
    fontname: "Noto Sans",
    fontsize: 48,
    bold: false,
    italic: false,
    primarycolor: "#FFFFFF",
    primary_opacity: 100,
    outlinecolor: "#000000",
    outline_opacity: 100,
    backcolor: "#000000",
    back_opacity: 0,
    outline_enabled: true,
    outline: 2.5,
    shadow_enabled: false,
    shadow: 1.5,
    background_enabled: false,
    glow_enabled: false,
    glow_radius: 5,
    glow_color_hex: "#FFFF00",
    alignment: 2,
    marginl: 10,
    marginr: 10,
    marginv: 30,
  };
}

/** Same defaults as the desktop's defaultStyleConfig().  Top-stack
    layers (top/romanized/annotation) use alignment=8 so marginv is
    measured from the top of the frame. */
export function defaultStyleConfig(): StyleConfig {
  return {
    bottom: {
      ...baseLayer(),
      fontname: "Georgia",
      fontsize: 48, outline: 3.0, alignment: 2, marginv: 40,
    },
    top: {
      ...baseLayer(),
      fontsize: 52, outline: 2.5, alignment: 8, marginv: 90,
    },
    romanized: {
      ...baseLayer(),
      fontname: "Times New Roman",
      italic: true,
      fontsize: 30, outline: 1.5, alignment: 8, marginv: 10,
      long_vowel_mode: "macrons",
    },
    annotation: {
      ...baseLayer(),
      enabled: false,
      fontsize: 22, outline: 1.0, alignment: 8, marginv: 10,
    },
    vertical_offset: 0,
    annotation_gap: 2,
    romanized_gap: 0,
  };
}
