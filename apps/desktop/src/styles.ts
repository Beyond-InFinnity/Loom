// Style domain: types mirror loom_core/models.py (StyleConfig + LayerStyle),
// defaults match the pydantic field defaults, API helpers hit /styles/*.

import { API_BASE } from "./api";

export type LayerKey = "bottom" | "top" | "romanized" | "annotation";
export const LAYER_KEYS: LayerKey[] = ["bottom", "top", "romanized", "annotation"];

// Wire alias used by the engine + presets (PascalCase).
export const LAYER_WIRE: Record<LayerKey, string> = {
  bottom: "Bottom",
  top: "Top",
  romanized: "Romanized",
  annotation: "Annotation",
};

export const LAYER_LABEL: Record<LayerKey, string> = {
  bottom: "Bottom",
  top: "Top",
  romanized: "Romanized",
  annotation: "Annotation",
};

export type LayerStyle = {
  enabled: boolean;
  fontname: string;
  fontsize: number;
  bold: boolean;
  italic: boolean;
  primarycolor: string;
  primary_opacity: number;
  outlinecolor: string;
  outline_opacity: number;
  backcolor: string;
  back_opacity: number;
  outline_enabled: boolean;
  outline: number;
  shadow_enabled: boolean;
  shadow: number;
  background_enabled: boolean;
  glow_enabled: boolean;
  glow_radius: number;
  glow_color_hex: string;
  alignment: number;
  marginl: number;
  marginr: number;
  marginv: number;
};

export type LongVowelMode = "macrons" | "doubled" | "unmarked";
export type PhoneticSystem =
  | "pinyin" | "zhuyin" | "jyutping"
  | "rtgs" | "paiboon" | "ipa";

export type StyleConfig = {
  bottom: LayerStyle;
  top: LayerStyle;
  romanized: LayerStyle & { long_vowel_mode: LongVowelMode };
  annotation: LayerStyle & { phonetic_system?: PhoneticSystem | null };
  vertical_offset: number;
  annotation_gap: number;
  romanized_gap: number;
};

// Layer defaults — keep in sync with loom_core/models.py LayerStyle subclasses.
// Fonts here are Latin-fallbacks; App.tsx overrides Top/Annotation per
// target-language via GET /language/config/{code} once a track is loaded.
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

export function defaultStyleConfig(): StyleConfig {
  // Top-stack layers (top / romanized / annotation) use alignment=8 so
  // marginv is measured from the top of the frame; the engine + preview
  // rely on this to stack romanized ≤ annotation ≤ top.
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
      phonetic_system: null,
    },
    vertical_offset: 0,
    annotation_gap: 2,
    romanized_gap: 0,
  };
}

// Known factory-default font names — used by the lang-aware override in
// App.tsx to avoid stomping on fonts the user has manually picked. If the
// current fontname is in this set, the field is treated as "untouched".
export const FACTORY_DEFAULT_FONTS: ReadonlySet<string> = new Set([
  "Noto Sans", "Georgia", "Times New Roman", "Arial",
  "Noto Sans CJK JP", "Noto Sans CJK SC", "Noto Sans CJK KR",
  "Noto Sans CJK TC", "Noto Sans CJK HK",
  "Noto Sans Thai", "Noto Naskh Arabic", "Noto Sans Hebrew",
  "Noto Nastaliq Urdu", "Noto Sans Devanagari", "Noto Sans Bengali",
  "Noto Sans Tamil", "Noto Sans Telugu", "Noto Sans Gujarati",
  "Noto Sans Gurmukhi", "Be Vietnam Pro", "Amiri",
]);

// ── Font + preset wire types ──────────────────────────────────────────

export type FontList = {
  all: string[];
  cjk: string[];
};

export type PresetLayerColors = {
  color: string;
  opacity: number;
  outline_color: string;
  outline_opacity: number;
  glow_color: string | null;
  glow_opacity: number | null;
};

export type PresetGroup = {
  key: string;
  label: string;
};

export type Preset = {
  id: string;
  label: string;
  description: string;
  group: string;
  layers: Record<string, PresetLayerColors>;
  languages: string[] | null;
};

export type PresetCatalog = {
  groups: PresetGroup[];
  presets: Preset[];
};

// ── Language-scoped extras ────────────────────────────────────────────
// Mirrors loom_core/styles.py::_chinese_variant and the option lists in
// loom_app.py (phonetic + long vowel selectors).

export function primaryLang(code: string | undefined | null): string {
  return (code || "").toLowerCase().split("-")[0].split("_")[0];
}

export function isJapanese(code: string | undefined | null): boolean {
  return primaryLang(code) === "ja";
}

export type PhoneticOption = { value: PhoneticSystem; label: string };

// Cantonese → Jyutping-only; zh-Hant → Zhuyin-first; zh-Hans → Pinyin-first;
// Thai → Paiboon+/RTGS/IPA. Empty list ⇒ no selector for this language.
export function phoneticOptions(code: string | undefined | null): PhoneticOption[] {
  const primary = primaryLang(code);
  const lc = (code || "").toLowerCase();
  if (primary === "yue") return [{ value: "jyutping", label: "Jyutping" }];
  if (primary === "zh") {
    const hant = lc === "zh-hant" || lc === "zh-tw" || lc === "zh-hk";
    return hant
      ? [
          { value: "zhuyin", label: "Zhuyin" },
          { value: "pinyin", label: "Pinyin" },
        ]
      : [
          { value: "pinyin", label: "Pinyin" },
          { value: "zhuyin", label: "Zhuyin" },
        ];
  }
  if (primary === "th") {
    return [
      { value: "paiboon", label: "Paiboon+" },
      { value: "rtgs", label: "RTGS" },
      { value: "ipa", label: "IPA" },
    ];
  }
  return [];
}

export const LONG_VOWEL_MODES: { value: LongVowelMode; label: string }[] = [
  { value: "macrons", label: "Macrons (tōkyō, kōhī)" },
  { value: "doubled", label: "Doubled (toukyou, koohii)" },
  { value: "unmarked", label: "Unmarked (tokyo, kohi)" },
];

export async function fetchFonts(): Promise<FontList> {
  const res = await fetch(`${API_BASE}/styles/fonts`);
  if (!res.ok) throw new Error(`/styles/fonts → HTTP ${res.status}`);
  return res.json();
}

export async function fetchPresets(lang: string): Promise<PresetCatalog> {
  const url = lang
    ? `${API_BASE}/styles/presets?lang=${encodeURIComponent(lang)}`
    : `${API_BASE}/styles/presets`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`/styles/presets → HTTP ${res.status}`);
  return res.json();
}

// Apply a preset to a StyleConfig — only color-related fields, leaves
// font/sizes/effects alone. Mirrors loom_core.color_presets.get_preset_styles.
export function applyPreset(styles: StyleConfig, preset: Preset): StyleConfig {
  const next = structuredClone(styles);
  for (const wireKey of Object.keys(preset.layers)) {
    const layerKey = (Object.entries(LAYER_WIRE).find(([, w]) => w === wireKey)?.[0]) as LayerKey | undefined;
    if (!layerKey) continue;
    const lc = preset.layers[wireKey];
    const layer = next[layerKey];
    layer.primarycolor = lc.color;
    layer.primary_opacity = lc.opacity;
    layer.outlinecolor = lc.outline_color;
    layer.outline_opacity = lc.outline_opacity;
    if (lc.glow_color) {
      layer.glow_color_hex = lc.glow_color;
      layer.glow_enabled = true;
    }
  }
  return next;
}
