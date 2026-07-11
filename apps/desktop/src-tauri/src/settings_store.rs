// Shared cross-window settings store for the Loom Player (desktop).
//
// The main Tauri window hosts the settings UI; the player window renders
// subtitles.  They're separate webviews with separate localStorage, so
// settings live in ONE place instead: a JSON file behind these commands,
// with every write broadcast as a "loom-settings-changed" Tauri event so
// the other window's StorageAdapter.onChanged fires live.  This is the
// desktop's StorageAdapter backing (host.ts) — the seam that lets the same
// caption UI settings drive both windows, like the extension's
// browser.storage.local (which is already cross-context).
//
// Keys are the loom_* strings the UI already uses; values are JSON.

use std::collections::BTreeMap;
use std::sync::Mutex;

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
pub struct SettingsStore {
    inner: Mutex<Map<String, Value>>,
}

fn store_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(std::path::PathBuf::from(home).join(".config/loom/player_settings.json"))
}

impl SettingsStore {
    /// Load the persisted map at startup (empty on first run / any error).
    pub fn load() -> Self {
        let map = store_path()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|s| serde_json::from_str::<Map<String, Value>>(&s).ok())
            .unwrap_or_default();
        Self {
            inner: Mutex::new(map),
        }
    }

    fn persist(map: &Map<String, Value>) {
        if let Some(p) = store_path() {
            if let Some(dir) = p.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(s) = serde_json::to_string(map) {
                let _ = std::fs::write(p, s);
            }
        }
    }
}

/// The whole settings map — read once at window startup to warm the
/// StorageAdapter's synchronous cache.
#[tauri::command]
pub fn settings_get_all(app: AppHandle) -> Value {
    let store = app.state::<SettingsStore>();
    let guard = store.inner.lock().unwrap();
    Value::Object(guard.clone())
}

/// Merge `items` into the store, persist, and broadcast the changes to ALL
/// windows so their StorageAdapter.onChanged listeners fire.
#[tauri::command]
pub fn settings_set(app: AppHandle, items: Map<String, Value>) -> Result<(), String> {
    {
        let store = app.state::<SettingsStore>();
        let mut guard = store.inner.lock().unwrap();
        for (k, v) in &items {
            guard.insert(k.clone(), v.clone());
        }
        SettingsStore::persist(&guard);
    }
    // { key: { newValue } } shape, matching the StorageAdapter change type.
    let mut changes: BTreeMap<String, Value> = BTreeMap::new();
    for (k, v) in items {
        changes.insert(k, serde_json::json!({ "newValue": v }));
    }
    let _ = app.emit("loom-settings-changed", changes);
    Ok(())
}

#[tauri::command]
pub fn settings_remove(app: AppHandle, keys: Vec<String>) -> Result<(), String> {
    {
        let store = app.state::<SettingsStore>();
        let mut guard = store.inner.lock().unwrap();
        for k in &keys {
            guard.remove(k);
        }
        SettingsStore::persist(&guard);
    }
    let mut changes: BTreeMap<String, Value> = BTreeMap::new();
    for k in keys {
        changes.insert(k, serde_json::json!({}));
    }
    let _ = app.emit("loom-settings-changed", changes);
    Ok(())
}
