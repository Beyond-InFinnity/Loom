"""Tests for the color preset system (R6b)."""

import os
import sys
import copy

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from app.color_presets import (
    PRESETS,
    ColorPreset,
    LayerColors,
    get_preset_styles,
    get_presets_for_lang,
    build_preset_selectbox_options,
    preset_swatch_colors,
    _normalize_lang,
    _lang_matches,
)

# Try to import pysubs2 for style-dict tests
try:
    import pysubs2
    _HAS_PYSUBS2 = True
except ImportError:
    _HAS_PYSUBS2 = False


# ── Helpers ───────────────────────────────────────────────────────────

_ALL_PRESET_IDS = [
    "classic_white", "classic_yellow", "classic_two_tone", "classic_soft",
    "classic_high_contrast",
    "ja_ukiyo_e", "ja_neon_tokyo", "ja_wabi_sabi", "ja_ink_wash",
    "ja_nerv_command", "ja_unit_01", "ja_cine_sub", "ja_angelic",
    "zh_hans_lacquer", "zh_hans_celadon",
    "zh_hant_porcelain",
    "yue_neon_hk",
    "ko_joseon", "ko_kpop",
    "th_temple_gold", "th_lotus",
    "ru_constructivist", "ru_blue_frost",
    "cinema_amber", "cinema_teal_orange", "cinema_monochrome", "cinema_deep_blue",
    "adaptive_auto",
]


def _make_styles_dict():
    """Create a realistic styles dict matching the app's structure."""
    if not _HAS_PYSUBS2:
        pytest.skip("pysubs2 not installed")

    return {
        "Bottom": {
            "enabled": True, "fontname": "Georgia", "fontsize": 48,
            "bold": False, "italic": False,
            "primarycolor": pysubs2.Color(255, 255, 255, 0),
            "outlinecolor": pysubs2.Color(0, 0, 0, 0),
            "backcolor": pysubs2.Color(0, 0, 0, 128),
            "outline": 3.0, "shadow": 1.5,
            "outline_opacity": 100, "opacity": 100,
            "alignment": 2, "marginv": 40,
            "back_none": True, "outline_none": False, "shadow_none": True,
            "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
        },
        "Top": {
            "enabled": True, "fontname": "Noto Sans CJK JP", "fontsize": 52,
            "bold": False, "italic": False,
            "primarycolor": pysubs2.Color(255, 255, 255, 0),
            "outlinecolor": pysubs2.Color(0, 0, 0, 0),
            "backcolor": pysubs2.Color(0, 0, 0, 128),
            "outline": 2.5, "shadow": 1.5,
            "outline_opacity": 100, "opacity": 100,
            "alignment": 8, "marginv": 90,
            "back_none": True, "outline_none": False, "shadow_none": True,
            "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
        },
        "Romanized": {
            "enabled": True, "fontname": "Times New Roman", "fontsize": 30,
            "bold": False, "italic": True,
            "primarycolor": pysubs2.Color(200, 200, 200, 0),
            "outlinecolor": pysubs2.Color(0, 0, 0, 0),
            "backcolor": pysubs2.Color(0, 0, 0, 128),
            "outline": 1.5, "shadow": 1.5,
            "outline_opacity": 100, "opacity": 100,
            "alignment": 8, "marginv": 10,
            "back_none": True, "outline_none": False, "shadow_none": True,
            "long_vowel_mode": "macrons",
            "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
        },
        "Annotation": {
            "enabled": True, "fontname": "Noto Sans CJK JP", "fontsize": 22,
            "bold": False, "italic": False,
            "primarycolor": pysubs2.Color(255, 255, 255, 0),
            "outlinecolor": pysubs2.Color(0, 0, 0, 0),
            "backcolor": pysubs2.Color(0, 0, 0, 128),
            "outline": 1.0, "shadow": 1.5,
            "outline_opacity": 100, "opacity": 100,
            "alignment": 8, "marginv": 10,
            "back_none": True, "outline_none": False, "shadow_none": True,
            "glow_none": True, "glow_radius": 5, "glow_color_hex": "#ffff00",
        },
        "vertical_offset": 0,
        "annotation_gap": 2,
        "romanized_gap": 0,
    }


# ── Test 1: All 23 preset IDs exist ──────────────────────────────────

def test_all_preset_ids_exist():
    assert len(PRESETS) == 28, f"Expected 28 presets, got {len(PRESETS)}"
    for pid in _ALL_PRESET_IDS:
        assert pid in PRESETS, f"Missing preset: {pid}"


# ── Test 2: Japanese presets ──────────────────────────────────────────

def test_presets_for_lang_ja():
    presets = get_presets_for_lang("ja")
    ids = [p.id for p in presets]
    # Must include ja_* cultural presets
    for ja_id in ["ja_ukiyo_e", "ja_neon_tokyo", "ja_wabi_sabi", "ja_ink_wash"]:
        assert ja_id in ids, f"Missing {ja_id} for ja"
    # Must include universal presets
    assert "classic_white" in ids
    assert "cinema_amber" in ids
    # Must NOT include other cultural presets
    for excluded in ["ko_joseon", "zh_hans_lacquer", "th_temple_gold",
                     "ru_constructivist", "yue_neon_hk", "zh_hant_porcelain"]:
        assert excluded not in ids, f"Should not include {excluded} for ja"


# ── Test 3: zh-Hans presets ───────────────────────────────────────────

def test_presets_for_lang_zh_hans():
    presets = get_presets_for_lang("zh-Hans")
    ids = [p.id for p in presets]
    assert "zh_hans_lacquer" in ids
    assert "zh_hans_celadon" in ids
    assert "classic_white" in ids
    # Must NOT include ja or yue cultural
    for excluded in ["ja_ukiyo_e", "yue_neon_hk", "zh_hant_porcelain"]:
        assert excluded not in ids, f"Should not include {excluded} for zh-Hans"


# ── Test 4: zh-CN prefix matches zh-Hans presets ─────────────────────

def test_presets_for_lang_zh_cn_prefix():
    presets = get_presets_for_lang("zh-CN")
    ids = [p.id for p in presets]
    # zh-CN starts with "zh" which matches the "zh" in zh_hans_lacquer's languages
    assert "zh_hans_lacquer" in ids
    assert "zh_hans_celadon" in ids


# ── Test 5: Korean presets ────────────────────────────────────────────

def test_presets_for_lang_ko():
    presets = get_presets_for_lang("ko")
    ids = [p.id for p in presets]
    assert "ko_joseon" in ids
    assert "ko_kpop" in ids
    assert "classic_white" in ids
    for excluded in ["ja_ukiyo_e", "zh_hans_lacquer", "th_temple_gold"]:
        assert excluded not in ids


# ── Test 6: Preset only modifies color fields ────────────────────────

def test_preset_only_modifies_color_fields():
    styles = _make_styles_dict()
    original = copy.deepcopy(styles)

    result = get_preset_styles("classic_white", "ja", styles)

    # These fields must NOT be touched
    _PROTECTED_KEYS = [
        "fontsize", "fontname", "bold", "italic", "outline", "shadow",
        "alignment", "marginv", "back_none", "shadow_none", "backcolor",
        "enabled", "long_vowel_mode", "glow_radius",
    ]

    for layer in ["Bottom", "Top", "Romanized", "Annotation"]:
        for key in _PROTECTED_KEYS:
            if key in original[layer]:
                assert result[layer][key] == original[layer][key], \
                    f"{layer}.{key} was modified by preset"

    # Non-layer top-level keys must be untouched
    assert result["vertical_offset"] == 0
    assert result["annotation_gap"] == 2
    assert result["romanized_gap"] == 0


# ── Test 7: Unknown preset returns styles unchanged ──────────────────

def test_unknown_preset_returns_unchanged():
    styles = _make_styles_dict()
    original = copy.deepcopy(styles)
    result = get_preset_styles("nonexistent_preset", "ja", styles)
    # Should be a deep copy of original (unchanged)
    for layer in ["Bottom", "Top", "Romanized", "Annotation"]:
        for key in original[layer]:
            assert result[layer][key] == original[layer][key]


# ── Test 8: Language-scoped preset applied to wrong lang ─────────────

def test_wrong_lang_returns_unchanged():
    styles = _make_styles_dict()
    original = copy.deepcopy(styles)
    # ja_ukiyo_e is scoped to ["ja"], applying with lang_code="ko" should no-op
    result = get_preset_styles("ja_ukiyo_e", "ko", styles)
    for layer in ["Bottom", "Top", "Romanized", "Annotation"]:
        for key in original[layer]:
            assert result[layer][key] == original[layer][key]


# ── Test 9: Missing annotation layer handled gracefully ──────────────

def test_missing_annotation_layer_skipped():
    styles = _make_styles_dict()
    del styles["Annotation"]
    # Should not raise
    result = get_preset_styles("classic_white", "ja", styles)
    assert "Annotation" not in result
    # Other layers should still be modified
    assert result["Bottom"]["opacity"] == 100


# ── Test 10: Selectbox first entry ────────────────────────────────────

def test_selectbox_first_entry():
    options = build_preset_selectbox_options("ja")
    pid, label = options[0]
    assert pid == ""
    assert "No preset" in label


# ── Test 11: No empty group headers ──────────────────────────────────

def test_no_empty_group_headers():
    options = build_preset_selectbox_options("ja")
    # Find group headers (pid is None)
    headers = [label for pid, label in options if pid is None]
    # Each header should be followed by at least one preset
    for i, (pid, label) in enumerate(options):
        if pid is None:
            # Next entry should be a real preset (not another header or end)
            assert i + 1 < len(options), f"Group header '{label}' at end of list"
            next_pid, _ = options[i + 1]
            assert next_pid is not None and next_pid != "", \
                f"Group header '{label}' has no presets after it"


# ── Test 12: Swatch colors ───────────────────────────────────────────

def test_swatch_colors():
    swatches = preset_swatch_colors("classic_white", "ja")
    assert len(swatches) == 4
    layer_keys = [k for k, _ in swatches]
    assert layer_keys == ["Bottom", "Top", "Romanized", "Annotation"]
    for _, hex_color in swatches:
        assert hex_color.startswith("#")
        assert len(hex_color) == 7


# ── Additional coverage ──────────────────────────────────────────────

def test_normalize_lang():
    assert _normalize_lang("ja-JP") == "ja"
    assert _normalize_lang("zh-Hans") == "zh-hans"
    assert _normalize_lang("zh-Hant") == "zh-hant"
    assert _normalize_lang("zh-CN") == "zh-cn"
    assert _normalize_lang("zh-TW") == "zh-tw"
    assert _normalize_lang("ru") == "ru"
    assert _normalize_lang("ko-KR") == "ko"
    assert _normalize_lang("") == ""


def test_lang_matches():
    assert _lang_matches("zh-hans", "zh") is True
    assert _lang_matches("zh-cn", "zh") is True
    assert _lang_matches("ja", "zh") is False
    assert _lang_matches("ko", "ko") is True
    assert _lang_matches("zh-hans", "zh-Hans") is True


def test_preset_modifies_colors():
    """Verify that applying a preset actually changes the color values."""
    styles = _make_styles_dict()
    result = get_preset_styles("classic_yellow", "ja", styles)
    # classic_yellow bottom is #FFE566, not white
    pc = result["Bottom"]["primarycolor"]
    assert pc.r == 0xFF
    assert pc.g == 0xE5
    assert pc.b == 0x66


def test_preset_with_glow():
    """Verify glow presets set glow fields."""
    styles = _make_styles_dict()
    result = get_preset_styles("classic_high_contrast", "en", styles)
    assert result["Bottom"]["glow_none"] is False
    assert result["Bottom"]["glow_color_hex"] == "#000000"


def test_preset_without_glow_preserves_existing():
    """Presets without glow should leave existing glow settings alone."""
    styles = _make_styles_dict()
    styles["Bottom"]["glow_none"] = False
    styles["Bottom"]["glow_color_hex"] = "#FF0000"
    styles["Bottom"]["glow_radius"] = 10

    result = get_preset_styles("classic_white", "en", styles)
    # classic_white has no glow, so existing glow settings preserved
    assert result["Bottom"]["glow_radius"] == 10


def test_empty_preset_id_returns_unchanged():
    styles = _make_styles_dict()
    original = copy.deepcopy(styles)
    result = get_preset_styles("", "ja", styles)
    for layer in ["Bottom", "Top", "Romanized", "Annotation"]:
        assert result[layer]["fontsize"] == original[layer]["fontsize"]


def test_all_presets_have_four_layers():
    """Every preset should define all 4 layers."""
    for pid, preset in PRESETS.items():
        for layer in ["Bottom", "Top", "Romanized", "Annotation"]:
            assert layer in preset.layers, \
                f"Preset {pid} missing layer {layer}"


def test_all_presets_belong_to_valid_group():
    valid_groups = {g["key"] for g in [
        {"key": "classic"}, {"key": "cultural"},
        {"key": "dark"}, {"key": "adaptive"},
    ]}
    for pid, preset in PRESETS.items():
        assert preset.group in valid_groups, \
            f"Preset {pid} has invalid group {preset.group}"


def test_selectbox_options_for_thai():
    """Thai should get th_* cultural + all universal, no ja_*/ko_*/zh_*."""
    options = build_preset_selectbox_options("th")
    ids = [pid for pid, _ in options if pid is not None and pid != ""]
    assert "th_temple_gold" in ids
    assert "th_lotus" in ids
    assert "classic_white" in ids
    assert "ja_ukiyo_e" not in ids
    assert "ko_joseon" not in ids


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
