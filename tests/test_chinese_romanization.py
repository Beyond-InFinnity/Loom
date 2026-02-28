"""Tests for Chinese Pinyin word-segmented romanization and annotation.

Covers:
- jieba word grouping (Simplified + Traditional)
- CJK punctuation stripping
- Empty input / non-CJK passthrough / mixed content
- Cantonese annotation default enabled
- Per-character annotation spans for all three Chinese variants
"""
import pytest


# ---------------------------------------------------------------------------
# Word-segmented Pinyin romanization
# ---------------------------------------------------------------------------

class TestPinyinWordGrouping:
    """Verify that _make_pinyin_romanizer produces word-grouped output."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from app.romanize import _make_pinyin_romanizer
        self.romanize_hans = _make_pinyin_romanizer(variant='zh-Hans')
        self.romanize_hant = _make_pinyin_romanizer(variant='zh-Hant')

    def test_simplified_word_grouping(self):
        """Multi-character words should be joined without spaces."""
        result = self.romanize_hans("无论什么人都没有资格")
        # jieba should segment into multi-char words; syllables within a word
        # should be joined (e.g. "wúlùn" not "wú lùn")
        assert "wúlùn" in result or "wúlún" in result  # 论 can be lùn or lún
        # Should NOT be fully space-separated per character
        assert result.count(' ') < 8  # 9 chars → max 8 spaces if per-char

    def test_traditional_word_grouping(self):
        """Traditional text should also be word-grouped via Simplified bridge."""
        result = self.romanize_hant("無論什麼人都沒有資格")
        # Same segmentation quality as Simplified
        assert "wúlùn" in result or "wúlún" in result
        assert result.count(' ') < 8

    def test_simplified_and_traditional_same_pinyin(self):
        """Both variants should produce the same Pinyin for equivalent text."""
        hans = self.romanize_hans("你好世界")
        hant = self.romanize_hant("你好世界")
        # Characters are identical for this phrase, so output should match
        assert hans == hant

    def test_single_character_words(self):
        """Single-character words should be space-separated."""
        result = self.romanize_hans("人都")
        words = result.split()
        assert len(words) >= 2  # At least 2 separate words

    def test_empty_input(self):
        assert self.romanize_hans("") == ""

    def test_whitespace_only(self):
        result = self.romanize_hans("   ")
        assert result.strip() == ""


class TestPinyinPunctuationStripping:
    """Verify that CJK punctuation is stripped from romanization output."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from app.romanize import _make_pinyin_romanizer
        self.romanize = _make_pinyin_romanizer(variant='zh-Hans')

    def test_comma_stripped(self):
        """Full-width comma should not appear in output."""
        result = self.romanize("你好，世界")
        assert "，" not in result
        assert "nǐhǎo" in result
        assert "shìjiè" in result

    def test_period_stripped(self):
        result = self.romanize("你好。世界")
        assert "。" not in result

    def test_exclamation_stripped(self):
        result = self.romanize("你好！世界")
        assert "！" not in result

    def test_question_mark_stripped(self):
        result = self.romanize("你好？世界")
        assert "？" not in result

    def test_brackets_stripped(self):
        result = self.romanize("「你好」世界")
        assert "「" not in result
        assert "」" not in result

    def test_parentheses_stripped(self):
        result = self.romanize("（你好）世界")
        assert "（" not in result
        assert "）" not in result

    def test_multiple_punctuation(self):
        """Multiple punctuation marks should all be stripped."""
        result = self.romanize("你好，世界！再见。")
        assert "，" not in result
        assert "！" not in result
        assert "。" not in result


class TestPinyinNonCJK:
    """Verify non-CJK content handling."""

    @pytest.fixture(autouse=True)
    def _setup(self):
        from app.romanize import _make_pinyin_romanizer
        self.romanize = _make_pinyin_romanizer(variant='zh-Hans')

    def test_latin_passthrough(self):
        """Pure Latin text should pass through."""
        result = self.romanize("ABC")
        assert "ABC" in result

    def test_mixed_cjk_latin(self):
        """Mixed CJK and Latin should preserve Latin segments."""
        result = self.romanize("这是test")
        assert "test" in result

    def test_ass_tags_stripped(self):
        """ASS override tags should be stripped before processing."""
        result = self.romanize("{\\an8}你好")
        assert "{" not in result
        assert "\\an8" not in result
        assert "nǐhǎo" in result


# ---------------------------------------------------------------------------
# get_romanizer() variant detection
# ---------------------------------------------------------------------------

class TestGetRomanizerVariant:
    """Verify that get_romanizer passes the correct variant."""

    def test_zh_hans_returns_romanizer(self):
        from app.romanize import get_romanizer
        rom = get_romanizer('zh-Hans')
        assert rom is not None
        result = rom("你好")
        assert "nǐhǎo" in result

    def test_zh_hant_returns_romanizer(self):
        from app.romanize import get_romanizer
        rom = get_romanizer('zh-Hant')
        assert rom is not None
        result = rom("你好")
        assert "nǐhǎo" in result

    def test_bare_zh_returns_romanizer(self):
        from app.romanize import get_romanizer
        rom = get_romanizer('zh')
        assert rom is not None

    def test_zh_tw_returns_romanizer(self):
        from app.romanize import get_romanizer
        rom = get_romanizer('zh-TW')
        assert rom is not None


# ---------------------------------------------------------------------------
# Cantonese annotation default
# ---------------------------------------------------------------------------

class TestCantoneseAnnotationDefault:
    """Verify Cantonese annotation is enabled by default."""

    def test_yue_annotation_default_enabled(self):
        from app.styles import get_lang_config
        config = get_lang_config('yue')
        assert config['annotation_default_enabled'] is True

    def test_yue_has_annotation_func(self):
        from app.styles import get_lang_config
        config = get_lang_config('yue')
        assert config['annotation_func'] is not None

    def test_thai_annotation_still_disabled(self):
        """Thai should still have annotation off by default."""
        from app.styles import get_lang_config
        config = get_lang_config('th')
        assert config['annotation_default_enabled'] is False


# ---------------------------------------------------------------------------
# Per-character annotation spans
# ---------------------------------------------------------------------------

class TestChineseAnnotationSpans:
    """Verify per-character annotation spans for all three Chinese variants."""

    def test_simplified_pinyin_annotation(self):
        from app.romanize import get_annotation_func
        func = get_annotation_func('zh-Hans')
        assert func is not None
        spans = func("你好")
        assert len(spans) == 2
        # Each CJK char should have a reading
        assert spans[0][1] is not None  # 你 → nǐ
        assert spans[1][1] is not None  # 好 → hǎo

    def test_traditional_zhuyin_annotation(self):
        from app.romanize import get_annotation_func
        func = get_annotation_func('zh-Hant')
        assert func is not None
        spans = func("你好")
        assert len(spans) == 2
        # Zhuyin should have bopomofo readings
        assert spans[0][1] is not None
        assert spans[1][1] is not None

    def test_cantonese_jyutping_annotation(self):
        from app.romanize import get_annotation_func
        func = get_annotation_func('yue')
        assert func is not None
        spans = func("你好")
        assert len(spans) == 2
        assert spans[0][1] is not None
        assert spans[1][1] is not None

    def test_punctuation_no_reading(self):
        """Punctuation characters should have reading=None."""
        from app.romanize import get_annotation_func
        func = get_annotation_func('zh-Hans')
        spans = func("你，好")
        # 你, ，, 好 → 3 spans
        assert len(spans) == 3
        assert spans[1][1] is None  # comma has no reading


# ---------------------------------------------------------------------------
# CJK punctuation detection helpers
# ---------------------------------------------------------------------------

class TestCJKPunctuationHelpers:
    """Test the _is_cjk_punct and _is_cjk_punct_segment helpers."""

    def test_fullwidth_comma(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("，") is True

    def test_fullwidth_period(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("。") is True

    def test_ideographic_comma(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("、") is True

    def test_corner_brackets(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("「") is True
        assert _is_cjk_punct("」") is True

    def test_fullwidth_exclamation(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("！") is True

    def test_regular_ascii_not_cjk_punct(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("a") is False
        assert _is_cjk_punct("1") is False

    def test_cjk_char_not_punct(self):
        from app.romanize import _is_cjk_punct
        assert _is_cjk_punct("你") is False

    def test_segment_all_punct(self):
        from app.romanize import _is_cjk_punct_segment
        assert _is_cjk_punct_segment("，。") is True

    def test_segment_mixed_not_all_punct(self):
        from app.romanize import _is_cjk_punct_segment
        assert _is_cjk_punct_segment("你好") is False
