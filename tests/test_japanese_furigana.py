"""Tests for Japanese inline furigana extraction and the tier-1 author
reading pipeline.

Covers:
  - Hiragana inline furigana (baseline — existing behavior)
  - Katakana inline furigana (R5-1 — loanword / slang glosses)
  - Mixed hiragana + katakana readings in the same line
  - False-positive guards: speaker labels, reverse (kanji-in-parens)
  - End-to-end: katakana author reading flows through resolve_spans +
    spans_to_romaji to produce the expected romaji gloss.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestInlineFuriganaExtraction:
    """Direct tests of _extract_inline_furigana / _strip_inline_furigana."""

    def test_hiragana_reading_extracted(self):
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("奴(やつ)らに支配(しはい)された") == {
            "奴": "やつ", "支配": "しはい",
        }

    def test_katakana_reading_extracted(self):
        """重力(グラビティ) — katakana gloss for a loanword reading."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("重力(グラビティ)を操る") == {
            "重力": "グラビティ",
        }

    def test_katakana_slang_reading(self):
        """本気(マジ) — katakana gloss for a slang reading."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("本気(マジ)で言ってる") == {
            "本気": "マジ",
        }

    def test_mixed_hira_and_kata_in_one_line(self):
        from loom_core.romanize import _extract_inline_furigana
        result = _extract_inline_furigana("本気(マジ)で支配(しはい)する")
        assert result == {"本気": "マジ", "支配": "しはい"}

    def test_fullwidth_parens_katakana(self):
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("宇宙（スペース）の果て") == {
            "宇宙": "スペース",
        }

    def test_chouon_in_katakana_reading(self):
        """Katakana readings often include ー — must be accepted."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("心(ハート)を込めて") == {
            "心": "ハート",
        }

    def test_strip_removes_katakana_paren(self):
        from loom_core.romanize import _strip_inline_furigana
        assert _strip_inline_furigana("重力(グラビティ)を操る") == "重力を操る"

    def test_strip_removes_mixed_parens(self):
        from loom_core.romanize import _strip_inline_furigana
        assert _strip_inline_furigana("本気(マジ)で支配(しはい)する") == (
            "本気で支配する"
        )


class TestFalsePositiveGuards:
    """Patterns that LOOK similar but must not be treated as furigana."""

    def test_speaker_label_not_extracted(self):
        """Speaker label （アルミン） has whitespace / no kanji glued before
        the paren — must not match."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("（アルミン）その日は") == {}
        assert _extract_inline_furigana("ねえ （アルミン） 聞いて") == {}

    def test_laugh_marker_not_extracted(self):
        """（笑）is kanji-in-parens — rejected by the kana-only inner class."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("面白い（笑）") == {}

    def test_reverse_furigana_not_captured_as_forward(self):
        """とりかご(鳥籠) — kanji inside parens, hiragana outside.  The
        forward regex requires kana inside and kanji outside, so it must
        not match this reverse pattern."""
        from loom_core.romanize import _extract_inline_furigana
        assert _extract_inline_furigana("とりかご(鳥籠)") == {}


class TestTier1RomajiPipeline:
    """End-to-end: katakana author reading reaches spans_to_romaji
    as-is and produces the expected romaji gloss."""

    def test_katakana_author_reading_romanizes(self):
        """重力(グラビティ) → romaji should reflect 'gurabiti', not
        MeCab's default 'jūryoku' reading of 重力."""
        from loom_core.romanize import get_japanese_pipeline
        resolve_spans, spans_to_romaji = get_japanese_pipeline()
        spans = resolve_spans("重力(グラビティ)")
        kanji_spans = [s for s in spans if s[0] == "重力"]
        assert kanji_spans, f"Expected 重力 span, got {spans}"
        surface, reading = kanji_spans[0]
        # Tier-1 author wins: reading is the author's katakana gloss, not
        # a MeCab-derived hiragana fallback.
        assert reading == "グラビティ"

        romaji = spans_to_romaji(spans)
        # gurabiti / gurabitei — allow either; what matters is that it is
        # NOT the MeCab default 'jūryoku' / 'juuryoku'.
        assert "gurabiti" in romaji or "gurabitei" in romaji
        assert "jūryoku" not in romaji and "juuryoku" not in romaji

    def test_hiragana_author_reading_still_wins(self):
        """Regression guard: hiragana inline still takes tier-1 priority."""
        from loom_core.romanize import get_japanese_pipeline
        resolve_spans, _ = get_japanese_pipeline()
        spans = resolve_spans("支配(しはい)")
        kanji_spans = [s for s in spans if s[0] == "支配"]
        assert kanji_spans, f"Expected 支配 span, got {spans}"
        _, reading = kanji_spans[0]
        assert reading == "しはい"
