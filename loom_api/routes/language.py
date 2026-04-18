from fastapi import APIRouter

from loom_core.models import LanguageMetadata
from loom_core.styles import get_lang_config

router = APIRouter(prefix="/language", tags=["language"])


@router.get("/config/{code}", response_model=LanguageMetadata)
def language_config(code: str, phonetic_system: str | None = None) -> LanguageMetadata:
    """Wire-safe view of ``loom_core.styles.get_lang_config()``.

    Drops the callable fields (``romanize_func``, ``annotation_func``, etc.)
    which can't cross the wire. The engine reconstructs them server-side
    from ``code`` + ``phonetic_system`` on each request that needs them.
    """
    cfg = get_lang_config(code, phonetic_system=phonetic_system)
    return LanguageMetadata(
        code=code,
        chinese_variant=cfg.get("chinese_variant"),
        phonetic_system=phonetic_system,
        has_phonetic_layer=cfg["has_phonetic_layer"],
        supports_ass_annotation=cfg["supports_ass_annotation"],
        annotation_default_enabled=cfg["annotation_default_enabled"],
        annotation_system_name=cfg.get("annotation_system_name", "Annotation"),
        annotation_render_mode=cfg.get("annotation_render_mode", "ruby"),
        annotation_font_ratio=cfg.get("annotation_font_ratio", 0.5),
        romanization_name=cfg.get("romanization_name", "N/A"),
        romanization_confidence=cfg.get("romanization_confidence", "none"),
        default_font=cfg.get("default_font", "Arial"),
        rtl=cfg.get("rtl", False),
    )
