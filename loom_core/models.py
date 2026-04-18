"""Typed contracts for the loom_core engine and the API layer.

Field names match the dict keys used in the engine today (e.g. ``"Bottom"``,
``"Top"``), so ``StyleConfig.model_dump(by_alias=True)`` produces a dict that
existing functions in ``subs/processing.py``, ``rasterize/pgs.py``, and
``subs/preview.py`` consume unchanged. The engine keeps its current dict
contract; this file is the wire/validation contract for FastAPI and the
typed TS client generated from the OpenAPI schema.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field


# ── Layer styles ───────────────────────────────────────────────────────
# Field names use the casing the engine expects when keyed into the
# ``styles`` dict (Bottom, Top, Romanized, Annotation).

PhoneticSystem = Literal[
    "pinyin", "zhuyin", "jyutping",
    "rtgs", "paiboon", "ipa",
]

LongVowelMode = Literal["macrons", "doubled", "unmarked"]
AnnotationRenderMode = Literal["ruby", "interlinear", "inline"]
ScriptDisplay = Literal["original", "simplified", "traditional"]


class LayerStyle(BaseModel):
    """Per-layer visual style. All sizes/distances in 1080-scale units."""

    enabled: bool = True
    color: str = "#FFFFFF"
    opacity: int = Field(100, ge=0, le=100)
    font_family: str = "Arial"
    font_size: int = Field(..., ge=1)

    outline_enabled: bool = True
    outline_thickness: float = Field(2.5, ge=0)
    outline_color: str = "#000000"
    outline_opacity: int = Field(90, ge=0, le=100)

    shadow_enabled: bool = False
    shadow_distance: float = Field(1.5, ge=0)

    glow_radius: int = Field(0, ge=0, le=20)
    glow_color: str = "#000000"


class AnnotationLayerStyle(LayerStyle):
    font_size: int = Field(22, ge=1)
    outline_thickness: float = Field(1.0, ge=0)
    phonetic_system: Optional[PhoneticSystem] = None
    font_ratio: float = Field(0.5, gt=0, le=1.0)


class RomanizedLayerStyle(LayerStyle):
    font_size: int = Field(30, ge=1)
    outline_thickness: float = Field(1.5, ge=0)
    long_vowel_mode: LongVowelMode = "macrons"


class BottomLayerStyle(LayerStyle):
    font_size: int = Field(48, ge=1)
    outline_thickness: float = Field(3.0, ge=0)


class TopLayerStyle(LayerStyle):
    font_size: int = Field(52, ge=1)
    outline_thickness: float = Field(2.5, ge=0)


class StyleConfig(BaseModel):
    """The full styles dict the engine consumes.

    Mirrors the hybrid shape of ``st.session_state.styles``: layer dicts
    keyed by layer name, plus a few top-level scalars. Field aliases
    preserve the layer-name casing the engine reads with ``styles[name]``.
    """

    model_config = ConfigDict(populate_by_name=True)

    bottom: BottomLayerStyle = Field(..., alias="Bottom")
    top: TopLayerStyle = Field(..., alias="Top")
    romanized: RomanizedLayerStyle = Field(..., alias="Romanized")
    annotation: AnnotationLayerStyle = Field(..., alias="Annotation")

    top_offset_y: int = 0
    annotation_gap: int = 2
    romanized_gap: int = 0
    script_display: Optional[ScriptDisplay] = None


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
    """Output of ``video/mkv_handler.get_video_metadata``."""

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
