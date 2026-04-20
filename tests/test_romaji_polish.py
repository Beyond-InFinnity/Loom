"""Tests for the universal romanization polish pass.

Covers _polish_romaji() directly and its integration into each
language's romanizer factory.

The polish pass normalizes three things:
  1. CJK/fullwidth punctuation → ASCII/Latin equivalents.
  2. Whitespace before closing punctuation (word . → word.).
  3. Optional sentence-initial capitalization (line start + after .!?).

Capitalization is enabled for scripts without source case (ja, zh, yue,
ko) and disabled for Cyrillic (cyrtranslit preserves source case) and
Thai (no caps convention).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestCJKPunctuationConversion:
    """Fullwidth CJK punctuation → Latin equivalents."""

    def test_fullwidth_period(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello 。", capitalize=False) == "hello."

    def test_fullwidth_comma(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("a ， b", capitalize=False) == "a, b"

    def test_fullwidth_exclamation(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("yay ！", capitalize=False) == "yay!"

    def test_fullwidth_question(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("huh ？", capitalize=False) == "huh?"

    def test_ideographic_comma(self):
        """Japanese 、 (U+3001) — common in JP text."""
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("a 、 b", capitalize=False) == "a, b"

    def test_fullwidth_parens(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("（name）", capitalize=False) == "(name)"

    def test_cjk_corner_brackets(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("「hi」", capitalize=False) == '"hi"'

    def test_middle_dot_becomes_space(self):
        """ハリー・ポッター-style katakana name separator → space."""
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("harī・pottā", capitalize=False) == (
            "harī pottā"
        )


class TestWhitespaceBeforePunct:
    """Space-before-closing-punctuation stripping."""

    def test_space_before_period(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello .", capitalize=False) == "hello."

    def test_space_before_comma(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("a , b", capitalize=False) == "a, b"

    def test_multiple_spaces_before_punct(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello    !", capitalize=False) == "hello!"

    def test_no_false_hyphen_strip(self):
        """Hyphen is not closing punctuation — Thai Paiboon syllable
        separator must survive polish unchanged."""
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("sa-wat-di", capitalize=False) == "sa-wat-di"

    def test_no_space_between_words(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello world", capitalize=False) == (
            "hello world"
        )


class TestCapitalization:
    """Sentence-initial caps — opt-in via capitalize=True."""

    def test_line_start_capitalized(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello world", capitalize=True) == "Hello world"

    def test_after_period(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello. world", capitalize=True) == (
            "Hello. World"
        )

    def test_after_exclamation(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hi! there", capitalize=True) == "Hi! There"

    def test_after_question(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hi? yes", capitalize=True) == "Hi? Yes"

    def test_macron_capitalizes(self):
        """ōra → Ōra — Unicode-aware uppercasing."""
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("ōra", capitalize=True) == "Ōra"

    def test_leading_punct_skipped(self):
        """Polish skips leading punctuation to find the first alpha."""
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("(hello) world", capitalize=True) == (
            "(Hello) world"
        )

    def test_capitalize_false_preserves_case(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("hello world", capitalize=False) == (
            "hello world"
        )

    def test_capitalize_existing_caps_unchanged(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("Hello. Privet.", capitalize=True) == (
            "Hello. Privet."
        )

    def test_no_alpha_no_caps_applied(self):
        """Line with no cased chars skips the capitalization passes
        (punct-normalization still runs — whitespace before `?` is stripped
        regardless, which is the whole point of the normalization)."""
        from loom_core.romanize import _polish_romaji
        # Digits only — no punct-spacing to normalize, no alpha to cap.
        assert _polish_romaji("12345", capitalize=True) == "12345"


class TestIdempotence:
    def test_polish_twice_equal(self):
        from loom_core.romanize import _polish_romaji
        raw = "hello 。 世界 ？ hi ！"
        once = _polish_romaji(raw, capitalize=True)
        twice = _polish_romaji(once, capitalize=True)
        assert once == twice


class TestEmptyInput:
    def test_empty_string(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("", capitalize=True) == ""

    def test_whitespace_only_preserved(self):
        from loom_core.romanize import _polish_romaji
        assert _polish_romaji("   ", capitalize=False) == "   "


# ---------------------------------------------------------------------------
# End-to-end smoke tests — polish reaches each language's romanizer output.
# ---------------------------------------------------------------------------


class TestJapanesePolish:
    def test_no_fullwidth_punct(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ja')
        out = r('今日は暑いね。明日はどう？')
        assert '。' not in out and '？' not in out

    def test_no_space_before_punct(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ja')
        out = r('今日は暑いね。')
        assert ' .' not in out and ' ,' not in out

    def test_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ja')
        out = r('今日は暑い。明日はどう？')
        # First alpha char is capitalized
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()

    def test_post_period_capitalized(self):
        """Second sentence should start with a capital letter."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ja')
        out = r('今日は暑い。明日はどう？')
        idx = out.find('.')
        assert idx != -1
        tail = out[idx + 1:].lstrip()
        assert tail and tail[0].isupper(), f"Post-period not cap in: {out!r}"


class TestChinesePolish:
    def test_punctuation_converted_not_dropped(self):
        """Previous behavior dropped CJK punct entirely; polish converts it."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('zh-Hans')
        out = r('你好，世界。你好吗？')
        # Fullwidth punct gone, ASCII punct present.
        assert '，' not in out and '。' not in out and '？' not in out
        assert ',' in out and '.' in out and '?' in out

    def test_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('zh-Hans')
        out = r('你好，世界')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()

    def test_traditional_also_polished(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('zh-Hant')
        out = r('你好，世界。')
        assert '，' not in out and '。' not in out
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()


class TestCantonesePolish:
    def test_fullwidth_punct_converted(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('yue')
        out = r('你好，世界。')
        assert '，' not in out and '。' not in out
        assert ' ,' not in out and ' .' not in out

    def test_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('yue')
        out = r('你好')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()


class TestKoreanPolish:
    def test_sentence_initial_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ko')
        out = r('안녕하세요')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()

    def test_post_period_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ko')
        out = r('안녕하세요. 반갑습니다')
        idx = out.find('.')
        tail = out[idx + 1:].lstrip()
        assert tail and tail[0].isupper()


class TestCyrillicPolishPreservesSource:
    def test_sentence_initial_source_lowercase_stays_lowercase(self):
        """Cyrillic uses capitalize=False so continuation lines stay lower."""
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ru')
        out = r('и говорил, что всё хорошо')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.islower(), (
            f"Cyrillic continuation line must stay lowercase: {out!r}"
        )

    def test_sentence_initial_source_cap_stays_cap(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('ru')
        out = r('Привет, мир.')
        first_alpha = next(c for c in out if c.isalpha())
        assert first_alpha.isupper()


class TestThaiPolishNoCaps:
    def test_rtgs_not_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('th')  # RTGS default
        out = r('สวัสดีครับ')
        if out and any(c.isalpha() for c in out):
            first_alpha = next(c for c in out if c.isalpha())
            assert first_alpha.islower(), f"Thai RTGS lowercase: {out!r}"

    def test_paiboon_not_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('th', phonetic_system='paiboon')
        out = r('สวัสดีครับ')
        if out and any(c.isalpha() for c in out):
            first_alpha = next(c for c in out if c.isalpha())
            assert first_alpha.islower(), f"Thai Paiboon lowercase: {out!r}"

    def test_ipa_not_capitalized(self):
        from loom_core.romanize import get_romanizer
        r = get_romanizer('th', phonetic_system='ipa')
        out = r('สวัสดีครับ')
        if out and any(c.isalpha() for c in out):
            first_alpha = next(c for c in out if c.isalpha())
            assert first_alpha.islower(), f"Thai IPA lowercase: {out!r}"
