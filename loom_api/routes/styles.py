"""Static style metadata: font catalogue + color preset catalogue.

Both endpoints return data the engine already knows about; the API exposes
them so the frontend has a single source of truth instead of mirroring
``FONT_LIST`` / ``CJK_FONT_LIST`` / ``PRESETS`` in TypeScript.
"""

from typing import Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from loom_core.color_presets import (
    PRESET_GROUPS,
    PRESETS,
    get_presets_for_lang,
)
from loom_core.styles import CJK_FONT_LIST, FONT_LIST

router = APIRouter(prefix="/styles", tags=["styles"])


class FontList(BaseModel):
    all: list[str]
    cjk: list[str]


class LayerColors(BaseModel):
    color: str
    opacity: int = 100
    outline_color: str = "#000000"
    outline_opacity: int = 90
    glow_color: Optional[str] = None
    glow_opacity: Optional[int] = None


class PresetGroup(BaseModel):
    key: str
    label: str


class Preset(BaseModel):
    id: str
    label: str
    description: str
    group: str
    layers: dict[str, LayerColors]
    languages: Optional[list[str]] = None


class PresetCatalog(BaseModel):
    groups: list[PresetGroup]
    presets: list[Preset]


@router.get("/fonts", response_model=FontList)
def fonts() -> FontList:
    return FontList(all=list(FONT_LIST), cjk=list(CJK_FONT_LIST))


@router.get("/presets", response_model=PresetCatalog)
def presets(lang: str = "") -> PresetCatalog:
    """Catalogue of color presets applicable to ``lang``.

    Universal presets (``languages=None``) are always included. Language-scoped
    presets are included when their scope matches ``lang`` via prefix.
    Empty ``lang`` returns universal presets only.
    """
    applicable = get_presets_for_lang(lang) if lang else [
        p for p in PRESETS.values() if p.languages is None
    ]
    return PresetCatalog(
        groups=[PresetGroup(key=g["key"], label=g["label"]) for g in PRESET_GROUPS],
        presets=[
            Preset(
                id=p.id,
                label=p.label,
                description=p.description,
                group=p.group,
                layers={
                    k: LayerColors(
                        color=lc.color,
                        opacity=lc.opacity,
                        outline_color=lc.outline_color,
                        outline_opacity=lc.outline_opacity,
                        glow_color=lc.glow_color,
                        glow_opacity=lc.glow_opacity,
                    )
                    for k, lc in p.layers.items()
                },
                languages=p.languages,
            )
            for p in applicable
        ],
    )
