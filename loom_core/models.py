"""Typed contracts for the loom_core engine and the API layer.

The engine in ``loom_core/`` consumes a styles dict whose shape evolved
incrementally inside the Streamlit app — pysubs2-aligned attribute names
(``fontname``, ``fontsize``, ``primarycolor``), inverted-alpha colors, and
``*_none`` flags whose semantics are inverted ("True means disabled").

This module exposes a clean wire contract instead. Every layer and the
top-level config carry a ``to_engine_dict()`` method that produces the
exact dict shape the engine wants. Wire features:

  - Colors are ``#RRGGBB`` hex strings. Opacity is a 0-100 percentage.
    ``to_engine_dict()`` combines them into ``pysubs2.Color`` objects with
    pysubs2's inverted alpha (``100% opacity → alpha=0``).
  - Effect toggles read positively (``outline_enabled``, ``shadow_enabled``,
    ``background_enabled``, ``glow_enabled``); the adapter inverts to the
    engine's ``*_none`` semantics.
  - Layer-specific extras (``Annotation.phonetic_system``,
    ``Romanized.long_vowel_mode``) live on the matching subclass.

The engine signatures still take a plain dict — this file is the contract
the API layer uses, plus the bridge to call into the engine.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

import pysubs2
from pydantic import BaseModel, ConfigDict, Field


# ── Enumerations ───────────────────────────────────────────────────────

PhoneticSystem = Literal[
    "pinyin", "zhuyin", "jyutping",
    "rtgs", "paiboon", "ipa",
]

LongVowelMode = Literal["macrons", "doubled", "unmarked"]
AnnotationRenderMode = Literal["ruby", "interlinear", "inline"]
ScriptDisplay = Literal["original", "simplified", "traditional"]


# ── Color conversion ──────────────────────────────────────────────────

def _hex_to_color(hex_str: str, opacity: int) -> pysubs2.Color:
    """``#RRGGBB`` + opacity 0-100 → ``pysubs2.Color`` with inverted alpha.

    pysubs2 stores alpha inverted from the conventional sense:
    ``alpha=0`` is fully opaque, ``alpha=255`` is fully transparent.
    """
    s = hex_str.lstrip("#")
    alpha = round((1 - opacity / 100.0) * 255)
    return pysubs2.Color(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16), alpha)


# ── Layer styles ───────────────────────────────────────────────────────

class LayerStyle(BaseModel):
    """Per-layer visual style. Sizes/distances in 1080-scale units."""

    enabled: bool = True

    fontname: str = "Arial"
    fontsize: int = Field(48, ge=1)
    bold: bool = False
    italic: bool = False

    # Colors split into hex + opacity for wire ergonomics.
    primarycolor: str = "#FFFFFF"
    primary_opacity: int = Field(100, ge=0, le=100)
    outlinecolor: str = "#000000"
    outline_opacity: int = Field(100, ge=0, le=100)
    backcolor: str = "#000000"
    back_opacity: int = Field(0, ge=0, le=100)

    # Effects: positive-sense toggles. Adapter inverts to engine's ``*_none``.
    outline_enabled: bool = True
    outline: float = Field(2.5, ge=0)
    shadow_enabled: bool = False
    shadow: float = Field(1.5, ge=0)
    background_enabled: bool = False
    glow_enabled: bool = False
    glow_radius: int = Field(5, ge=0, le=20)
    glow_color_hex: str = "#FFFF00"

    # Layout (pysubs2 conventions: alignment 1-9 numpad-style).
    alignment: int = Field(2, ge=1, le=9)
    marginl: int = 10
    marginr: int = 10
    marginv: int = 30

    def to_engine_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "fontname": self.fontname,
            "fontsize": self.fontsize,
            "bold": self.bold,
            "italic": self.italic,
            "primarycolor": _hex_to_color(self.primarycolor, self.primary_opacity),
            "outlinecolor": _hex_to_color(self.outlinecolor, self.outline_opacity),
            "backcolor": _hex_to_color(self.backcolor, self.back_opacity),
            "outline": self.outline,
            "shadow": self.shadow,
            "outline_none": not self.outline_enabled,
            "shadow_none": not self.shadow_enabled,
            "back_none": not self.background_enabled,
            "glow_none": not self.glow_enabled,
            "glow_radius": self.glow_radius,
            "glow_color_hex": self.glow_color_hex,
            "alignment": self.alignment,
            "marginl": self.marginl,
            "marginr": self.marginr,
            "marginv": self.marginv,
        }


class BottomLayerStyle(LayerStyle):
    fontsize: int = Field(48, ge=1)
    outline: float = Field(3.0, ge=0)
    marginv: int = 30


class TopLayerStyle(LayerStyle):
    fontsize: int = Field(52, ge=1)
    outline: float = Field(2.5, ge=0)
    marginv: int = 100


class RomanizedLayerStyle(LayerStyle):
    fontsize: int = Field(30, ge=1)
    outline: float = Field(1.5, ge=0)
    marginv: int = 160
    long_vowel_mode: LongVowelMode = "macrons"

    def to_engine_dict(self) -> dict[str, Any]:
        d = super().to_engine_dict()
        d["long_vowel_mode"] = self.long_vowel_mode
        return d


class AnnotationLayerStyle(LayerStyle):
    enabled: bool = False
    fontsize: int = Field(22, ge=1)
    outline: float = Field(1.0, ge=0)
    marginv: int = 0
    phonetic_system: Optional[PhoneticSystem] = None

    def to_engine_dict(self) -> dict[str, Any]:
        d = super().to_engine_dict()
        if self.phonetic_system is not None:
            d["phonetic_system"] = self.phonetic_system
        return d


class StyleConfig(BaseModel):
    """The full styles dict the engine consumes.

    Mirrors the hybrid shape used in the codebase: layer dicts keyed by
    ``"Bottom"``/``"Top"``/``"Romanized"``/``"Annotation"`` plus a few
    top-level scalars. Field aliases preserve the layer-name casing so a
    JSON payload can use either the alias (``{"Bottom": {...}}``) or the
    snake_case attribute (``{"bottom": {...}}``).
    """

    model_config = ConfigDict(populate_by_name=True)

    bottom: BottomLayerStyle = Field(default_factory=BottomLayerStyle, alias="Bottom")
    top: TopLayerStyle = Field(default_factory=TopLayerStyle, alias="Top")
    romanized: RomanizedLayerStyle = Field(default_factory=RomanizedLayerStyle, alias="Romanized")
    annotation: AnnotationLayerStyle = Field(default_factory=AnnotationLayerStyle, alias="Annotation")

    vertical_offset: int = 0
    annotation_gap: int = 2
    romanized_gap: int = 0
    script_display: Optional[ScriptDisplay] = None

    def to_engine_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "Bottom": self.bottom.to_engine_dict(),
            "Top": self.top.to_engine_dict(),
            "Romanized": self.romanized.to_engine_dict(),
            "Annotation": self.annotation.to_engine_dict(),
            "vertical_offset": self.vertical_offset,
            "annotation_gap": self.annotation_gap,
            "romanized_gap": self.romanized_gap,
        }
        if self.script_display is not None:
            d["script_display"] = self.script_display
        return d


# ── Track / video metadata ─────────────────────────────────────────────

TrackSource = Literal["mkv", "external"]


class TrackInfo(BaseModel):
    """One subtitle track surfaced to the UI.

    Mirrors the dict shape returned by ``video/mkv_handler.scan_and_extract_tracks``.
    Image-based tracks (PGS, VobSub) carry ``selectable=False`` and ``path=None``.
    """

    id: int
    sub_num: Optional[int] = None
    label: str
    path: Optional[str] = None
    lang_code: Optional[str] = None
    source: TrackSource = "mkv"
    selectable: bool = True
    codec: Optional[str] = None
    metadata_lang: Optional[str] = None
    track_title: Optional[str] = None


class VideoMetadata(BaseModel):
    title: Optional[str] = None
    year: Optional[int] = None
    duration_seconds: float = 0.0
    width: int = 1920
    height: int = 1080


# ── Language config (wire-safe view of get_lang_config) ────────────────

RomanizationConfidence = Literal["very_high", "high", "good", "moderate", "low", "none"]
ChineseVariant = Literal["zh-Hans", "zh-Hant", "yue"]


class LanguageMetadata(BaseModel):
    """Serializable subset of ``styles.get_lang_config()``.

    Drops the callable fields (``romanize_func``, ``annotation_func``,
    ``resolve_spans_func``, ``spans_to_romaji_func``, ``word_boundary_func``)
    which can't cross the wire. The engine reconstructs them server-side
    from ``code`` + ``phonetic_system``.
    """

    code: str
    chinese_variant: Optional[ChineseVariant] = None
    phonetic_system: Optional[PhoneticSystem] = None

    has_phonetic_layer: bool
    supports_ass_annotation: bool
    annotation_default_enabled: bool

    annotation_system_name: str = "Annotation"
    annotation_render_mode: AnnotationRenderMode = "ruby"
    annotation_font_ratio: float = 0.5

    romanization_name: str = "N/A"
    romanization_confidence: RomanizationConfidence = "none"
    default_font: str = "Arial"
    rtl: bool = False


# ── Style mapping (multi-style ASS files) ──────────────────────────────

StyleRole = Literal["dialogue", "preserve", "exclude"]


class StyleInfo(BaseModel):
    """Per-style metadata from ``subs/processing.detect_ass_styles``."""

    name: str
    event_count: int
    has_animation: bool
    role: StyleRole


# ── Pipeline requests ──────────────────────────────────────────────────

class TimingOffsets(BaseModel):
    bottom_ms: int = 0
    top_ms: int = 0


class Resolution(BaseModel):
    width: int = Field(1920, ge=1)
    height: int = Field(1080, ge=1)


class GenerateRequestBase(BaseModel):
    """Common fields for ASS and PGS generation."""

    native_path: str
    target_path: str
    target_lang_code: str
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    source_resolution: Resolution = Resolution()
    output_resolution: Optional[Resolution] = None
    native_style_mapping: Optional[dict[str, StyleRole]] = None
    target_style_mapping: Optional[dict[str, StyleRole]] = None


class GenerateAssRequest(GenerateRequestBase):
    include_annotations: bool = False


class GeneratePgsRequest(GenerateRequestBase):
    pass


# ── Auto-alignment ─────────────────────────────────────────────────────

ReferenceLayer = Literal["bottom", "top"]


class AlignRequest(BaseModel):
    reference_path: str
    target_path: str
    compare_against: ReferenceLayer = "bottom"


class AlignResponse(BaseModel):
    offset_seconds: float
    warning: Optional[str] = None


# ── Preview ────────────────────────────────────────────────────────────

class PreviewRequest(BaseModel):
    native_path: str
    target_path: str
    timestamp_seconds: float
    target_lang_code: str
    styles: StyleConfig
    offsets: TimingOffsets = TimingOffsets()
    native_style_mapping: Optional[dict[str, StyleRole]] = None
    target_style_mapping: Optional[dict[str, StyleRole]] = None


class PreviewResponse(BaseModel):
    html: str


# ── Async jobs (PGS rasterization can take 30s–10min) ──────────────────

JobState = Literal["pending", "running", "completed", "failed"]
JobKind = Literal["ass", "pgs", "mux"]


class JobStatus(BaseModel):
    id: str
    kind: JobKind
    state: JobState
    progress: float = Field(0.0, ge=0.0, le=1.0)
    phase: Optional[str] = None
    result_path: Optional[str] = None
    error: Optional[str] = None


class JobAccepted(BaseModel):
    id: str
    kind: JobKind


# ── Mux ────────────────────────────────────────────────────────────────

class MuxRequest(BaseModel):
    input_path: str
    output_path: str
    ass_path: Optional[str] = None
    sup_path: Optional[str] = None
    native_lang: Optional[str] = None
    target_lang: Optional[str] = None
    default_audio_index: Optional[int] = None
    keep_existing_subs: bool = False
    keep_attachments: bool = True


class MuxResponse(BaseModel):
    output_path: str
