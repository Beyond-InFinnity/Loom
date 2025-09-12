# app/user_settings.py

import json
import os

SETTINGS_FILE = "user_settings.json"

def save_user_styles(style_dict):
    with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
        json.dump(style_dict, f, indent=2, ensure_ascii=False)

def load_user_styles():
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            return {}
    return {}
