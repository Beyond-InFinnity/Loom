"""Color preset system for Loom subtitle layers.

Pure data + logic module — no Streamlit imports.

Layer semantics (from CLAUDE.md — authoritative):
  Bottom     = user's native language (e.g. English). Lowest on screen.
  Top        = foreign / media language (e.g. Japanese). Above Bottom.
  Annotation = per-token readings (furigana, zhuyin). Above Top tokens.
  Romanized  = phonetic block (romaji, pinyin). Highest on screen.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Optional


# ── Data model ────────────────────────────────────────────────────────

@dataclass
class LayerColors:
    color: str                                  # CSS hex #RRGGBB
    opacity: int = 100                          # 0–100
    outline_color: str = "#000000"
    outline_opacity: int = 90
    glow_color: Optional[str] = None            # None = don't set
    glow_opacity: Optional[int] = None


@dataclass
class ColorPreset:
    id: str
    label: str
    description: str
    group: str                                  # "classic" | "cultural" | "dark" | "adaptive"
    layers: dict[str, LayerColors]              # keys: "Bottom","Top","Romanized","Annotation"
    languages: Optional[list[str]] = None       # None = universal
    lang_overrides: dict[str, dict[str, LayerColors]] = field(default_factory=dict)


# ── Preset groups (display order) ────────────────────────────────────

PRESET_GROUPS = [
    {"key": "classic",  "label": "\u2b1c Classic"},
    {"key": "cultural", "label": "\U0001f3ee Cultural"},
    {"key": "dark",     "label": "\U0001f319 Dark / Cinema"},
    {"key": "adaptive", "label": "\U0001f3a8 Adaptive (coming soon)"},
]


# ── Helper ────────────────────────────────────────────────────────────

def _L(color, opacity=100, outline="#000000", outline_op=90,
       glow=None, glow_op=None) -> LayerColors:
    return LayerColors(
        color=color, opacity=opacity,
        outline_color=outline, outline_opacity=outline_op,
        glow_color=glow, glow_opacity=glow_op,
    )


# ── Preset definitions ───────────────────────────────────────────────
# Ordered within each group. Keys must match ColorPreset.id.

_PRESET_LIST: list[ColorPreset] = [
    # ── Classic (universal) ───────────────────────────────────────────
    ColorPreset(
        id="classic_white", label="Classic White",
        description="Clean white text on all layers.",
        group="classic", languages=None,
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#000000", 90),
            "Top":        _L("#FFFFFF", 100, "#000000", 90),
            "Romanized":  _L("#E0E0E0", 95,  "#000000", 85),
            "Annotation": _L("#CCCCCC", 90,  "#000000", 80),
        },
    ),
    ColorPreset(
        id="classic_yellow", label="Classic Yellow",
        description="Yellow bottom with white top.",
        group="classic", languages=None,
        layers={
            "Bottom":     _L("#FFE566", 100, "#000000", 92),
            "Top":        _L("#FFFFFF", 100, "#000000", 90),
            "Romanized":  _L("#FFD700", 95,  "#000000", 85),
            "Annotation": _L("#FFC44D", 90,  "#000000", 80),
        },
    ),
    ColorPreset(
        id="classic_two_tone", label="Two-Tone (White / Cyan)",
        description="White bottom, cyan top.",
        group="classic", languages=None,
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#000000", 90),
            "Top":        _L("#66EEFF", 100, "#003344", 90),
            "Romanized":  _L("#AADDEE", 90,  "#002233", 85),
            "Annotation": _L("#88CCDD", 85,  "#001122", 80),
        },
    ),
    ColorPreset(
        id="classic_soft", label="Soft Cream",
        description="Warm cream tones for comfortable reading.",
        group="classic", languages=None,
        layers={
            "Bottom":     _L("#FFF8E7", 100, "#1A1008", 88),
            "Top":        _L("#EEF4FF", 100, "#080810", 85),
            "Romanized":  _L("#D4EAD4", 95,  "#081208", 82),
            "Annotation": _L("#E8D8C0", 90,  "#180C00", 78),
        },
    ),
    ColorPreset(
        id="classic_high_contrast", label="High Contrast",
        description="Maximum readability with glow.",
        group="classic", languages=None,
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#000000", 100, "#000000", 100),
            "Top":        _L("#FFFFFF", 100, "#000000", 100, "#000000", 100),
            "Romanized":  _L("#F0F0F0", 100, "#000000", 100, "#000000", 90),
            "Annotation": _L("#E8E8E8", 100, "#000000", 100, "#000000", 85),
        },
    ),

    # ── Cultural — Japanese ───────────────────────────────────────────
    ColorPreset(
        id="ja_ukiyo_e", label="Ukiyo-e",
        description="Woodblock print palette.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#C8273A", 100, "#1A0A08", 92),
            "Top":        _L("#E8E4D8", 100, "#1A1610", 90),
            "Romanized":  _L("#3B6EA8", 98,  "#0A1020", 88),
            "Annotation": _L("#D4748A", 90,  "#300010", 82),
        },
    ),
    ColorPreset(
        id="ja_neon_tokyo", label="Neon Tokyo",
        description="Electric neon glow.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#FF2D78", 100, "#220010", 92, "#FF2D78", 60),
            "Top":        _L("#00FFEE", 100, "#002222", 90, "#00CCDD", 40),
            "Romanized":  _L("#CCFF00", 98,  "#141800", 88, "#AADD00", 35),
            "Annotation": _L("#FF9900", 92,  "#1A0800", 85, "#DD7700", 30),
        },
    ),
    ColorPreset(
        id="ja_wabi_sabi", label="Wabi-sabi",
        description="Muted earth tones.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#E8D5B0", 100, "#2A1F08", 90),
            "Top":        _L("#D8DCE0", 100, "#101418", 88),
            "Romanized":  _L("#7A9068", 98,  "#0A1208", 85),
            "Annotation": _L("#C4A882", 88,  "#201408", 80),
        },
    ),
    ColorPreset(
        id="ja_ink_wash", label="Ink Wash",
        description="Sumi-e ink wash palette.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#F5F0E8", 100, "#181410", 90),
            "Top":        _L("#E8EDF2", 100, "#101418", 88),
            "Romanized":  _L("#B8B4AC", 95,  "#181410", 84),
            "Annotation": _L("#989490", 88,  "#181410", 78),
        },
    ),

    # ── Cultural — Japanese (Evangelion) ────────────────────────────────
    ColorPreset(
        id="ja_nerv_command", label="NERV Command",
        description="Maximum contrast HUD orange inspired by NERV interfaces.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#1A1A1A", 94, "#FF9500", 40),
            "Top":        _L("#FF9500", 100, "#000000", 95),
            "Romanized":  _L("#D1D1D1", 95,  "#000000", 90),
            "Annotation": _L("#FFF4BC", 92,  "#3D1F00", 88),
        },
    ),
    ColorPreset(
        id="ja_unit_01", label="Unit-01",
        description="EVA-01 neon green and deep purple.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#A6FF00", 100, "#4B0082", 94, "#A6FF00", 45),
            "Top":        _L("#6A0DAD", 100, "#FFFFFF", 95, "#9B59B6", 40),
            "Romanized":  _L("#CCFFCC", 95,  "#000000", 90),
            "Annotation": _L("#FFFFFF", 92,  "#4B0082", 88),
        },
    ),
    ColorPreset(
        id="ja_cine_sub", label="Cine-Sub",
        description="Modern professional cyan-blue streaming aesthetic.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#000000", 95),
            "Top":        _L("#00E5FF", 100, "#001B3D", 94, "#00E5FF", 35),
            "Romanized":  _L("#A9D6E5", 95,  "#000000", 90),
            "Annotation": _L("#F0F0F0", 92,  "#001B3D", 88),
        },
    ),
    ColorPreset(
        id="ja_angelic", label="Angelic",
        description="Minimalist gold and cream inspired by Tree of Life motifs.",
        group="cultural", languages=["ja"],
        layers={
            "Bottom":     _L("#F5F5FF", 100, "#2C3E50", 92),
            "Top":        _L("#FFD700", 100, "#703010", 94, "#FFD700", 40),
            "Romanized":  _L("#95A5A6", 95,  "#000000", 90),
            "Annotation": _L("#FFFDD0", 92,  "#703010", 88),
        },
    ),

    # ── Cultural — zh-Hans ────────────────────────────────────────────
    ColorPreset(
        id="zh_hans_lacquer", label="Red Lacquer",
        description="Imperial red and gold.",
        group="cultural", languages=["zh-Hans", "zh-CN", "zh"],
        layers={
            "Bottom":     _L("#D4271A", 100, "#1A0800", 92),
            "Top":        _L("#F5F0E8", 100, "#1A1410", 90),
            "Romanized":  _L("#D4A017", 100, "#1A0C00", 88),
            "Annotation": _L("#E8C060", 90,  "#180A00", 82),
        },
    ),
    ColorPreset(
        id="zh_hans_celadon", label="Celadon",
        description="Jade green ceramic glaze.",
        group="cultural", languages=["zh-Hans", "zh-CN", "zh"],
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#0A1A10", 90),
            "Top":        _L("#D8EED8", 100, "#0A1A0A", 88),
            "Romanized":  _L("#7DB87A", 98,  "#0A1A08", 86),
            "Annotation": _L("#A8D0A4", 88,  "#0A1A08", 80),
        },
    ),

    # ── Cultural — zh-Hant ────────────────────────────────────────────
    ColorPreset(
        id="zh_hant_porcelain", label="Blue-and-White Porcelain",
        description="Classic blue-and-white ceramic palette.",
        group="cultural", languages=["zh-Hant", "zh-TW", "zh-HK"],
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#0A1A40", 92),
            "Top":        _L("#D8E8F8", 100, "#0A1030", 88),
            "Romanized":  _L("#2A5FAC", 100, "#0A1840", 88),
            "Annotation": _L("#6890C8", 90,  "#0A1030", 82),
        },
    ),

    # ── Cultural — Cantonese ──────────────────────────────────────────
    ColorPreset(
        id="yue_neon_hk", label="Neon Hong Kong",
        description="Hong Kong neon signage.",
        group="cultural", languages=["yue", "zh-yue"],
        layers={
            "Bottom":     _L("#00E87A", 100, "#001A10", 92, "#00CC66", 40),
            "Top":        _L("#F0ECE4", 100, "#1A1610", 88),
            "Romanized":  _L("#FF3A8C", 100, "#220010", 88, "#DD1A6A", 35),
            "Annotation": _L("#FFB830", 90,  "#1A0800", 82, "#DD9010", 30),
        },
    ),

    # ── Cultural — Korean ─────────────────────────────────────────────
    ColorPreset(
        id="ko_joseon", label="Joseon Court",
        description="Traditional Korean court palette.",
        group="cultural", languages=["ko"],
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#0A1A20", 90),
            "Top":        _L("#E8EEF4", 100, "#0A1018", 88),
            "Romanized":  _L("#4AA8A0", 100, "#081818", 86),
            "Annotation": _L("#C84830", 90,  "#1A0800", 82),
        },
    ),
    ColorPreset(
        id="ko_kpop", label="K-Pop Pastel",
        description="Soft pastel pop palette.",
        group="cultural", languages=["ko"],
        layers={
            "Bottom":     _L("#C8B4E8", 100, "#18103A", 90),
            "Top":        _L("#F0EEF8", 100, "#18103A", 88),
            "Romanized":  _L("#F4B8CC", 100, "#3A1020", 86),
            "Annotation": _L("#A8D4F0", 90,  "#101830", 82),
        },
    ),

    # ── Cultural — Thai ───────────────────────────────────────────────
    ColorPreset(
        id="th_temple_gold", label="Temple Gold",
        description="Thai temple gold and red.",
        group="cultural", languages=["th"],
        layers={
            "Bottom":     _L("#F0C040", 100, "#1A0C00", 92),
            "Top":        _L("#F8F0E0", 100, "#1A1408", 90),
            "Romanized":  _L("#C84030", 100, "#1A0800", 88),
            "Annotation": _L("#E8A020", 90,  "#1A0800", 82),
        },
    ),
    ColorPreset(
        id="th_lotus", label="Lotus",
        description="Soft lotus pink and green.",
        group="cultural", languages=["th"],
        layers={
            "Bottom":     _L("#D8A8D8", 100, "#180820", 90),
            "Top":        _L("#F0F4F0", 100, "#101810", 88),
            "Romanized":  _L("#88C8A8", 98,  "#081A10", 85),
            "Annotation": _L("#C090C0", 88,  "#180818", 80),
        },
    ),

    # ── Cultural — Cyrillic ───────────────────────────────────────────
    ColorPreset(
        id="ru_constructivist", label="Constructivist",
        description="Soviet avant-garde palette.",
        group="cultural", languages=["ru", "uk", "be", "sr", "bg", "mk", "mn"],
        layers={
            "Bottom":     _L("#E02020", 100, "#0A0A0A", 94),
            "Top":        _L("#F5F0E8", 100, "#0A0A0A", 90),
            "Romanized":  _L("#F0C020", 100, "#181000", 88),
            "Annotation": _L("#E88020", 90,  "#180800", 82),
        },
    ),
    ColorPreset(
        id="ru_blue_frost", label="Blue Frost",
        description="Icy blue winter palette.",
        group="cultural", languages=["ru", "uk", "be", "sr", "bg", "mk", "mn"],
        layers={
            "Bottom":     _L("#A8D0F0", 100, "#0A1820", 90),
            "Top":        _L("#EEF4F8", 100, "#0A1018", 88),
            "Romanized":  _L("#D0E8F8", 98,  "#0A1820", 85),
            "Annotation": _L("#88BCDC", 88,  "#0A1020", 80),
        },
    ),

    # ── Dark / Cinema (universal) ─────────────────────────────────────
    ColorPreset(
        id="cinema_amber", label="Cinema Amber",
        description="Warm amber for dark scenes.",
        group="dark", languages=None,
        layers={
            "Bottom":     _L("#F0C060", 100, "#0A0800", 92),
            "Top":        _L("#E8E0CC", 100, "#100E08", 90),
            "Romanized":  _L("#D4A840", 98,  "#0A0800", 86),
            "Annotation": _L("#C09030", 90,  "#0A0800", 80),
        },
    ),
    ColorPreset(
        id="cinema_teal_orange", label="Teal & Orange",
        description="Classic cinema color grading.",
        group="dark", languages=None,
        layers={
            "Bottom":     _L("#40C8C0", 100, "#041818", 92),
            "Top":        _L("#F0C080", 100, "#180A04", 90),
            "Romanized":  _L("#D0D8D4", 96,  "#0C1210", 86),
            "Annotation": _L("#60D0C8", 88,  "#041818", 80),
        },
    ),
    ColorPreset(
        id="cinema_monochrome", label="Monochrome Dark",
        description="Grayscale for black-and-white films.",
        group="dark", languages=None,
        layers={
            "Bottom":     _L("#E8E8E8", 100, "#000000", 94),
            "Top":        _L("#C8C8C8", 100, "#000000", 92),
            "Romanized":  _L("#A0A0A0", 95,  "#000000", 88),
            "Annotation": _L("#888888", 88,  "#000000", 84),
        },
    ),
    ColorPreset(
        id="cinema_deep_blue", label="Deep Blue Hour",
        description="Cool blue twilight palette.",
        group="dark", languages=None,
        layers={
            "Bottom":     _L("#8090D0", 100, "#080C1A", 92),
            "Top":        _L("#D8E4F4", 100, "#080C18", 90),
            "Romanized":  _L("#B0C4E4", 96,  "#080C18", 86),
            "Annotation": _L("#6880C0", 90,  "#080C1A", 82),
        },
    ),

    # ── Adaptive (placeholder) ────────────────────────────────────────
    ColorPreset(
        id="adaptive_auto", label="Auto-Contrast (coming soon)",
        description="Placeholder — auto-contrast based on video frame analysis.",
        group="adaptive", languages=None,
        layers={
            "Bottom":     _L("#FFFFFF", 100, "#000000", 92),
            "Top":        _L("#FFFFFF", 100, "#000000", 90),
            "Romanized":  _L("#E0E0E0", 95,  "#000000", 86),
            "Annotation": _L("#C8C8C8", 90,  "#000000", 82),
        },
    ),
]

# Keyed lookup by preset id.
PRESETS: dict[str, ColorPreset] = {p.id: p for p in _PRESET_LIST}


# ── Language matching ─────────────────────────────────────────────────

def _normalize_lang(lang_code: str) -> str:
    """Normalize a BCP-47 language code for matching.

    Preserves compound Chinese subtags (zh-Hans, zh-Hant, zh-CN, zh-TW, zh-HK).
    For all others: lowercase, primary subtag only.
    """
    if not lang_code:
        return ""
    lc = lang_code.strip().lower()
    # Preserve Chinese script/region subtags
    if lc.startswith("zh-") or lc.startswith("zh_"):
        # Normalize separator to hyphen
        return lc.replace("_", "-")
    # Everything else: primary subtag only
    return lc.split("-")[0].split("_")[0]


def _lang_matches(norm_code: str, scope: str) -> bool:
    """True if normalized lang code matches a preset scope entry."""
    ns = _normalize_lang(scope)
    if not norm_code or not ns:
        return False
    return norm_code == ns or norm_code.startswith(ns + "-")


# ── Public API ────────────────────────────────────────────────────────

def get_preset_styles(preset_id: str, lang_code: str,
                      current_styles: dict) -> dict:
    """Deep-copy current_styles and merge preset colors into it.

    Only writes: color, opacity, outline_color, outline_opacity,
    and (if not None) glow_color, glow_opacity.
    Never touches font sizes, gaps, outline thickness, font family, or any
    other non-color settings.
    Skips any layer key not present in current_styles.
    If preset.languages is set and lang_code doesn't match, returns
    current_styles unmodified.
    lang_overrides (if any) win over preset.layers for the active lang_code.
    """
    if not preset_id or preset_id not in PRESETS:
        return current_styles

    preset = PRESETS[preset_id]

    # Language gate
    if preset.languages is not None:
        norm = _normalize_lang(lang_code)
        if not any(_lang_matches(norm, s) for s in preset.languages):
            return current_styles

    result = copy.deepcopy(current_styles)

    # Resolve effective layer colors (lang_overrides win)
    norm = _normalize_lang(lang_code)
    effective_layers = dict(preset.layers)
    for override_lang, override_dict in preset.lang_overrides.items():
        if _lang_matches(norm, override_lang):
            effective_layers.update(override_dict)

    for layer_key, lc in effective_layers.items():
        if layer_key not in result:
            continue
        config = result[layer_key]
        if not isinstance(config, dict):
            continue

        # Import here to avoid top-level dependency on pysubs2 in tests
        # that don't have it installed.  The styles dict uses pysubs2.Color
        # objects for primarycolor / outlinecolor.
        try:
            import pysubs2
            _has_pysubs2 = True
        except ImportError:
            _has_pysubs2 = False

        # Text color + opacity
        r, g, b = _hex_to_rgb(lc.color)
        alpha = int((1 - lc.opacity / 100) * 255)
        if _has_pysubs2:
            config["primarycolor"] = pysubs2.Color(r, g, b, alpha)
        config["opacity"] = lc.opacity

        # Outline color + opacity
        or_, og, ob = _hex_to_rgb(lc.outline_color)
        o_alpha = int((1 - lc.outline_opacity / 100) * 255)
        if _has_pysubs2:
            config["outlinecolor"] = pysubs2.Color(or_, og, ob, o_alpha)
        config["outline_opacity"] = lc.outline_opacity

        # Glow (only if preset specifies it)
        if lc.glow_color is not None:
            config["glow_color_hex"] = lc.glow_color
            config["glow_none"] = False
            if lc.glow_opacity is not None:
                config["glow_opacity"] = lc.glow_opacity
        # If preset doesn't specify glow, leave existing glow settings alone

    return result


def get_presets_for_lang(lang_code: str) -> list[ColorPreset]:
    """Return all presets applicable to lang_code in catalogue order.

    Universal presets (languages=None) always included.
    Language-scoped presets included when lang_code matches via prefix.
    """
    norm = _normalize_lang(lang_code)
    result = []
    for p in _PRESET_LIST:
        if p.languages is None:
            result.append(p)
        elif any(_lang_matches(norm, s) for s in p.languages):
            result.append(p)
    return result


def build_preset_selectbox_options(lang_code: str) -> list[tuple[str | None, str]]:
    """Build (preset_id_or_None, display_label) pairs for a Streamlit selectbox.

    Layout:
      ("", "— No preset  (manual colors) —")
      (None, "──── ⬜ Classic ────")          ← group header (non-selectable)
      ("classic_white", "Classic White")
      ...
    None id = group header.  "" id = no preset active.
    Groups with zero applicable presets for lang_code are omitted.
    """
    applicable = get_presets_for_lang(lang_code)
    applicable_ids = {p.id for p in applicable}

    options: list[tuple[str | None, str]] = [
        ("", "\u2014 No preset  (manual colors) \u2014"),
    ]

    for group in PRESET_GROUPS:
        group_presets = [p for p in _PRESET_LIST
                         if p.group == group["key"] and p.id in applicable_ids]
        if not group_presets:
            continue
        # Group header
        options.append((None, f"\u2500\u2500\u2500\u2500 {group['label']} \u2500\u2500\u2500\u2500"))
        for p in group_presets:
            options.append((p.id, f"{p.label}  {_preset_emoji_strip(p)}"))

    return options


def preset_swatch_colors(preset_id: str, lang_code: str) -> list[tuple[str, str]]:
    """Return [(layer_key, hex_color), ...] for the 4 layers.

    Used to render a small swatch strip in the UI.
    Falls back to "#888888" for any layer not defined.
    """
    fallback = "#888888"
    layer_order = ["Bottom", "Top", "Romanized", "Annotation"]

    if preset_id not in PRESETS:
        return [(k, fallback) for k in layer_order]

    preset = PRESETS[preset_id]

    # Resolve effective layers with lang_overrides
    norm = _normalize_lang(lang_code)
    effective = dict(preset.layers)
    for override_lang, override_dict in preset.lang_overrides.items():
        if _lang_matches(norm, override_lang):
            effective.update(override_dict)

    return [
        (k, effective[k].color if k in effective else fallback)
        for k in layer_order
    ]


# ── Internal helpers ──────────────────────────────────────────────────

# Colored square emoji mapped to approximate RGB values for nearest-match.
_EMOJI_SQUARES = [
    ((255,   0,   0), "\U0001f7e5"),   # 🟥 red
    ((255, 165,   0), "\U0001f7e7"),   # 🟧 orange
    ((255, 255,   0), "\U0001f7e8"),   # 🟨 yellow
    ((  0, 128,   0), "\U0001f7e9"),   # 🟩 green
    ((  0,   0, 255), "\U0001f7e6"),   # 🟦 blue
    ((128,   0, 128), "\U0001f7ea"),   # 🟪 purple
    ((139,  69,  19), "\U0001f7eb"),   # 🟫 brown
    ((  0,   0,   0), "\u2b1b"),       # ⬛ black
    ((255, 255, 255), "\u2b1c"),       # ⬜ white
]


def _nearest_color_emoji(hex_color: str) -> str:
    """Map a hex color to the nearest Unicode colored square emoji."""
    r, g, b = _hex_to_rgb(hex_color)
    best_emoji = "\u2b1c"
    best_dist = float("inf")
    for (er, eg, eb), emoji in _EMOJI_SQUARES:
        dist = (r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2
        if dist < best_dist:
            best_dist = dist
            best_emoji = emoji
    return best_emoji


def _preset_emoji_strip(preset: ColorPreset) -> str:
    """Build a 4-emoji swatch string for a preset's layer colors."""
    return "".join(
        _nearest_color_emoji(preset.layers[k].color)
        for k in ["Bottom", "Top", "Romanized", "Annotation"]
        if k in preset.layers
    )


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    """Parse #RRGGBB to (r, g, b) ints."""
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
