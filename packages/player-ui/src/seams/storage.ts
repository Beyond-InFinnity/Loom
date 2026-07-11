// StorageAdapter — seam #1 (MOBILE_ROADMAP.md §3).
//
// Every persisted preference in the Loom UI goes through this interface
// instead of `browser.storage.local` directly.  The keyspace stays the
// extension's `loom_*` string constants so existing extension installs
// lose nothing when the extension flips to an adapter impl.
//
// Impls:
//   - extension: browser.storage.local (7b)
//   - desktop player: Tauri store / fs-backed JSON via the shell bridge
//   - Android: SharedPreferences via the WebView JS bridge
//
// Contract notes (mirror browser.storage.local semantics — the code being
// rewired was written against them):
//   - get() resolves missing keys as absent properties, never throws for
//     unknown keys.
//   - onChanged fires for writes from ANY context sharing the store (the
//     extension relies on this for popup ↔ content-script sync); a
//     single-context host may fire it only for its own writes.
//   - Values are JSON-serializable (string | number | boolean | arrays |
//     plain objects) — same envelope browser.storage.local accepts.

export type StorageValue =
  | string
  | number
  | boolean
  | null
  | StorageValue[]
  | { [key: string]: StorageValue };

export interface StorageChange {
  oldValue?: StorageValue;
  newValue?: StorageValue;
}

export interface StorageAdapter {
  get(keys: string[]): Promise<Record<string, StorageValue>>;
  set(items: Record<string, StorageValue>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
  /** Subscribe to changes; returns an unsubscribe function. */
  onChanged(
    cb: (changes: Record<string, StorageChange>) => void,
  ): () => void;
}
