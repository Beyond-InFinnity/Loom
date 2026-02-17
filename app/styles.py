# app/styles.py
import pysubs2
from pypinyin import pinyin, Style

FONT_LIST = [
    "Arial", "Arial Black", "Verdana", "Georgia", "Times New Roman", 
    "Noto Sans", "Noto Sans SC", "Noto Sans JP", "Noto Sans KR"
]

LANG_CONFIG = {
    "en": {"display_name": "English", "romanization_name": "N/A", "romanize_function": None},
    "de": {"display_name": "German", "romanization_name": "N/A", "romanize_function": None},
    "zh-cn": {
        "display_name": "Chinese-Simplified", 
        "romanization_name": "Pinyin", 
        "romanize_function": lambda text: " ".join(p[0] for p in pinyin(text, style=Style.TONE))
    },
    # Future languages can be added here
}
