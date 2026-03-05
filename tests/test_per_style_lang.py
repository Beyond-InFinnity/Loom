"""Tests for per-style language detection in multi-language ASS files.

Tests:
  - detect_language_from_text(): parity with detect_language for simple cases
  - detect_languages_by_style(): multi-language detection, single-language,
    excluded-style filtering, comment/drawing exclusion
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pysubs2

from app.language import (
    detect_language,
    detect_language_from_text,
    detect_languages_by_style,
)


def _write_multi_lang_ass(path, style_events):
    """Create an ASS file with multiple styles containing different languages.

    Parameters
    ----------
    path : str
        Output file path.
    style_events : list[tuple[str, list[str]]]
        ``(style_name, [event_text, ...])`` pairs.
    """
    subs = pysubs2.SSAFile()
    for style_name, texts in style_events:
        subs.styles[style_name] = pysubs2.SSAStyle()
        for i, text in enumerate(texts):
            ev = pysubs2.SSAEvent(
                start=i * 2000, end=(i + 1) * 2000,
                text=text, style=style_name,
            )
            subs.events.append(ev)
    subs.save(path)
    return path


# --- Japanese and Chinese text samples ---
# Enough lines to give langdetect a reliable signal.
_JA_LINES = [
    "お前はもう死んでいる",
    "何をしているの？早く逃げなさい！",
    "私たちの戦いはこれからだ",
    "すみません、道を教えてください",
    "今日はとても暑いですね",
    "彼女は学校に行きました",
    "明日の天気はどうですか",
    "この映画はとても面白かった",
    "新しい技術が世界を変える",
    "友達と一緒に公園で遊んだ",
    "あの人は誰ですか？知っていますか？",
    "日本語の勉強は楽しいです",
]

_ZH_LINES = [
    "你好，世界！欢迎来到这里",
    "我们一起去吃饭吧",
    "今天天气真好啊",
    "这部电影非常精彩",
    "请问洗手间在哪里？",
    "我喜欢学习中文",
    "他们已经到达目的地了",
    "明天我要去北京出差",
    "这个问题很难回答",
    "春天是最美的季节",
    "我的朋友住在上海",
    "谢谢你的帮助！",
]

_EN_LINES = [
    "Hello, welcome to the show",
    "I can't believe what just happened",
    "Let's go find the treasure together",
    "The weather is beautiful today",
    "She ran as fast as she could",
    "Have you ever been to London?",
    "The book was absolutely fascinating",
    "We need to leave before midnight",
    "I forgot my keys at the office",
    "This is the best day of my life",
    "Can you help me with this problem?",
    "They arrived just in time for dinner",
]


# ---------------------------------------------------------------------------
# detect_language_from_text() tests
# ---------------------------------------------------------------------------

def test_from_text_japanese():
    """Japanese text correctly detected from text sample."""
    text = " ".join(_JA_LINES)
    result = detect_language_from_text(text)
    assert result == "ja", f"Expected 'ja', got '{result}'"


def test_from_text_chinese():
    """Simplified Chinese text correctly detected from text sample."""
    text = " ".join(_ZH_LINES)
    result = detect_language_from_text(text)
    assert result is not None
    assert result.startswith("zh"), f"Expected zh variant, got '{result}'"


def test_from_text_english():
    """English text correctly detected from text sample."""
    text = " ".join(_EN_LINES)
    result = detect_language_from_text(text)
    assert result == "en", f"Expected 'en', got '{result}'"


def test_from_text_empty():
    """Empty/blank text returns None."""
    assert detect_language_from_text("") is None
    assert detect_language_from_text("   ") is None
    assert detect_language_from_text(None) is None


def test_from_text_parity_with_detect_language():
    """detect_language_from_text gives same result as detect_language on a
    single-style file (i.e. the refactoring preserved behavior)."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = os.path.join(tmpdir, "ja.ass")
        _write_multi_lang_ass(path, [("Default", _JA_LINES)])

        file_result = detect_language(path)
        text = " ".join(_JA_LINES)
        text_result = detect_language_from_text(text)

        assert file_result == text_result, (
            f"File detection: {file_result}, text detection: {text_result}")


# ---------------------------------------------------------------------------
# detect_languages_by_style() tests
# ---------------------------------------------------------------------------

def test_multi_lang_per_style():
    """Different styles correctly detected as different languages."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Dial_JP", _JA_LINES), ("Dial_CH", _ZH_LINES)],
        )
        result = detect_languages_by_style(path)

        assert "Dial_JP" in result
        assert "Dial_CH" in result
        assert result["Dial_JP"] == "ja", f"JP got: {result['Dial_JP']}"
        assert result["Dial_CH"] is not None
        assert result["Dial_CH"].startswith("zh"), f"CH got: {result['Dial_CH']}"


def test_single_lang_passthrough():
    """All styles with same language → all entries have same code."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "single.ass"),
            [("Default", _JA_LINES), ("Alt", _JA_LINES[:6])],
        )
        result = detect_languages_by_style(path)

        assert len(result) == 2
        assert result["Default"] == "ja"
        assert result["Alt"] == "ja"


def test_excluded_styles_filtered():
    """Styles mapped to 'exclude' are not in the result."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "excl.ass"),
            [("Dial_JP", _JA_LINES), ("Dial_CH", _ZH_LINES),
             ("Signs", _EN_LINES[:3])],
        )
        mapping = {
            "Dial_JP": "dialogue",
            "Dial_CH": "exclude",
            "Signs": "preserve",
        }
        result = detect_languages_by_style(path, style_mapping=mapping)

        assert "Dial_JP" in result
        assert "Signs" in result
        assert "Dial_CH" not in result, (
            "Excluded style should not appear in result")


def test_excluded_styles_dont_influence_unique_langs():
    """When excluded styles are filtered, unique language set shrinks."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "multi.ass"),
            [("Dial_JP", _JA_LINES), ("Dial_CH", _ZH_LINES)],
        )

        # Without exclusion: 2 languages
        all_result = detect_languages_by_style(path)
        all_langs = set(lang for lang in all_result.values() if lang)
        assert len(all_langs) == 2

        # With CH excluded: only Japanese
        mapping = {"Dial_JP": "dialogue", "Dial_CH": "exclude"}
        filtered_result = detect_languages_by_style(
            path, style_mapping=mapping)
        filtered_langs = set(
            lang for lang in filtered_result.values() if lang)
        assert len(filtered_langs) == 1
        assert "ja" in filtered_langs


def test_comments_excluded():
    """Comment events don't contribute to detection."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        # Only comment events — no detectable text
        for i, text in enumerate(_JA_LINES):
            ev = pysubs2.SSAEvent(
                start=i * 1000, end=(i + 1) * 1000,
                text=text, style="Default",
            )
            ev.is_comment = True
            subs.events.append(ev)
        path = os.path.join(tmpdir, "comments.ass")
        subs.save(path)

        result = detect_languages_by_style(path)
        # Style has no non-comment events → not in result
        assert "Default" not in result


def test_drawing_events_excluded():
    r"""Events with \p1 drawing commands don't contribute to detection."""
    with tempfile.TemporaryDirectory() as tmpdir:
        subs = pysubs2.SSAFile()
        subs.styles["Default"] = pysubs2.SSAStyle()
        subs.styles["Drawing"] = pysubs2.SSAStyle()

        for i, text in enumerate(_JA_LINES):
            subs.events.append(pysubs2.SSAEvent(
                start=i * 1000, end=(i + 1) * 1000,
                text=text, style="Default"))
        # Drawing-only style
        subs.events.append(pysubs2.SSAEvent(
            start=0, end=1000,
            text=r"{\p1}m 0 0 l 100 0 100 100 0 100",
            style="Drawing"))

        path = os.path.join(tmpdir, "drawing.ass")
        subs.save(path)

        result = detect_languages_by_style(path)
        assert "Default" in result
        assert result["Default"] == "ja"
        assert "Drawing" not in result


def test_nonexistent_file():
    """Nonexistent file returns empty dict."""
    result = detect_languages_by_style("/nonexistent/file.ass")
    assert result == {}


def test_no_mapping_analyzes_all_styles():
    """When style_mapping is None, all styles are analyzed."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "all.ass"),
            [("A", _JA_LINES), ("B", _ZH_LINES), ("C", _EN_LINES)],
        )
        result = detect_languages_by_style(path, style_mapping=None)

        assert len(result) == 3
        assert "A" in result
        assert "B" in result
        assert "C" in result


def test_three_languages():
    """Three distinct languages all correctly identified."""
    with tempfile.TemporaryDirectory() as tmpdir:
        path = _write_multi_lang_ass(
            os.path.join(tmpdir, "three.ass"),
            [("JP", _JA_LINES), ("CH", _ZH_LINES), ("EN", _EN_LINES)],
        )
        result = detect_languages_by_style(path)

        assert result["JP"] == "ja"
        assert result["CH"] is not None and result["CH"].startswith("zh")
        assert result["EN"] == "en"


if __name__ == '__main__':
    import inspect

    print("Running per-style language detection tests...\n")
    test_funcs = [
        obj for name, obj in sorted(globals().items())
        if name.startswith('test_') and callable(obj)
    ]
    for func in test_funcs:
        print(f"  {func.__name__}...", end=' ')
        func()
        print("PASS")

    print(f"\nAll {len(test_funcs)} per-style language detection tests passed!")
