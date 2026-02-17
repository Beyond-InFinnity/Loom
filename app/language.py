# app/language.py
import pysubs2
from langdetect import detect
from langdetect.lang_detect_exception import LangDetectException

def detect_language_from_file(file, sample_size=30):
    """
    Detects language from an uploaded subtitle file by intelligently sampling
    from the middle of the file to avoid credits and branding.
    
    Args:
        file: The uploaded file object from Streamlit.
        sample_size: The number of subtitle lines to use for detection.

    Returns:
        The detected language code (e.g., 'en', 'zh-cn') or None if detection fails.
    """
    if not file:
        return None
        
    try:
        file.seek(0)
        subs = pysubs2.SSAFile.from_string(file.getvalue().decode("utf-8"))
        
        if not subs:
            return None

        # Calculate the midpoint and the slice for sampling
        total_lines = len(subs)
        mid_point = total_lines // 2
        start_index = max(0, mid_point - (sample_size // 2))
        end_index = min(total_lines, start_index + sample_size)
        
        # Ensure we don't try to sample from an empty list
        if start_index >= end_index:
            return None

        # Aggregate text from the middle subtitle events
        text_sample = " ".join(
            line.text.replace("\\N", " ") for line in subs[start_index:end_index]
        )
        
        if not text_sample.strip():
            return None
            
        return detect(text_sample)
        
    except (LangDetectException, IndexError, Exception) as e:
        # Broad exception to handle parsing errors, empty files, or detection failures gracefully
        print(f"Language detection failed: {e}") # Optional: for debugging
        return None
