// The desktop Loom Player's LoomHost (7c) — the SECOND registered host
// after the extension, and the proof of the seam architecture: same
// package UI, different plumbing.
//
//   storage  — SHARED cross-window store (settings_store.rs) so the main
//              window's settings UI and the player window stay in sync,
//              like the extension's cross-context browser.storage.local.
//              A synchronous warm cache (loaded by initDesktopStorage) backs
//              reads; writes persist + broadcast a "loom-settings-changed"
//              event that updates every window's cache and fires onChanged.
//   player   — fixed id "player"; native-caption hiding is mpv's --sid=no
//   api      — the PROD text API (dictionary/annotate live there; the
//              local sidecar has no dictionary DB).  clientVersion null →
//              X-Loom-Version omitted (don't pollute extension telemetry).
//   playhead — mpv IPC (./mpv.ts)
//   locale   — navigator.language
//
// Import this module ONCE from each window entry, then AWAIT
// initDesktopStorage() before mounting so settings reads are warm.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { registerLoomHost } from "@loom/player-ui/host";
import { setDebugLogger } from "@loom/player-ui/log";
import { initUiLocale, setUiLocaleProvider } from "@loom/player-ui";
import type {
  ApiConfig,
  PlayerAdapter,
  StorageAdapter,
  StorageChange,
} from "@loom/player-ui/seams";
import { acquireMpvPlayhead, mpvPlayhead } from "./mpv";

export const TEXT_API_BASE = "https://api.loom.nerv-analytic.ai";

// Synchronous warm cache over the shared Rust store (values are JSON).
const cache = new Map<string, unknown>();
const changeSubs = new Set<(c: Record<string, StorageChange>) => void>();
let initialized = false;

/** Load the shared store into the cache + subscribe to cross-window changes.
    Await this in each window entry before rendering. */
export async function initDesktopStorage(): Promise<void> {
  if (initialized) return;
  initialized = true;
  const all = (await invoke("settings_get_all")) as Record<string, unknown>;
  for (const [k, v] of Object.entries(all ?? {})) cache.set(k, v);
  await listen<Record<string, StorageChange>>("loom-settings-changed", (e) => {
    const changes = e.payload ?? {};
    for (const [k, c] of Object.entries(changes)) {
      if ("newValue" in c) cache.set(k, (c as StorageChange).newValue);
      else cache.delete(k);
    }
    changeSubs.forEach((f) => f(changes));
  });
}

export const storage: StorageAdapter = {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) {
      if (cache.has(k)) out[k] = cache.get(k);
    }
    return out;
  },
  async set(items) {
    for (const [k, v] of Object.entries(items)) cache.set(k, v);
    // Persist + broadcast; THIS window's onChanged fires via the event too,
    // so don't double-notify locally.
    await invoke("settings_set", { items });
  },
  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) cache.delete(k);
    await invoke("settings_remove", { keys: list });
  },
  onChanged(cb) {
    changeSubs.add(cb);
    return () => changeSubs.delete(cb);
  },
};

/** Synchronous cache read for warm-init call sites (settings defaults). */
export function readCached<T>(key: string, fallback: T): T {
  return cache.has(key) ? (cache.get(key) as T) : fallback;
}

const player: PlayerAdapter = {
  id: "player",
  // mpv never renders the media's own subtitle track (--sid=no at spawn),
  // so there's nothing to hide/restore.
  hideNativeCaptions() {},
  restoreNativeCaptions() {},
};

const api: ApiConfig = {
  baseUrl: TEXT_API_BASE,
  clientVersion: null,
  async ownerKey() {
    const v = readCached<unknown>("loom_owner_key", null);
    return typeof v === "string" && v.length > 0 ? v : null;
  },
};

setUiLocaleProvider(() => navigator.language);
if (import.meta.env.DEV) {
  setDebugLogger((...args) => console.debug(...args));
}

registerLoomHost({
  storage,
  player,
  api,
  acquirePlayhead: acquireMpvPlayhead,
  playhead: () => mpvPlayhead,
});

initUiLocale();
