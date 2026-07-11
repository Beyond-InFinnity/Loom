// The desktop Loom Player's LoomHost (7c) — the SECOND registered host
// after the extension, and the proof of the seam architecture: same
// package UI, different plumbing.
//
//   storage  — webview localStorage (per-app persistent; same loom_* keys)
//   player   — fixed id "player"; native-caption hiding is mpv's --sid=no
//   api      — the PROD text API (dictionary/annotate live there; the
//              local sidecar has no dictionary DB).  clientVersion null →
//              X-Loom-Version omitted (don't pollute extension telemetry).
//   playhead — mpv IPC (./mpv.ts)
//   locale   — navigator.language
//
// Import this module ONCE from the Player entry; registration happens at
// module evaluation, same contract as the extension's lib/host.ts.

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

const changeSubs = new Set<(c: Record<string, StorageChange>) => void>();

const storage: StorageAdapter = {
  async get(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list) {
      const raw = localStorage.getItem(k);
      if (raw !== null) {
        try {
          out[k] = JSON.parse(raw);
        } catch {
          out[k] = raw;
        }
      }
    }
    return out;
  },
  async set(items) {
    const changes: Record<string, StorageChange> = {};
    for (const [k, v] of Object.entries(items)) {
      changes[k] = { newValue: v };
      localStorage.setItem(k, JSON.stringify(v));
    }
    changeSubs.forEach((f) => f(changes));
  },
  async remove(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    const changes: Record<string, StorageChange> = {};
    for (const k of list) {
      changes[k] = {};
      localStorage.removeItem(k);
    }
    changeSubs.forEach((f) => f(changes));
  },
  onChanged(cb) {
    changeSubs.add(cb);
    return () => changeSubs.delete(cb);
  },
};

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
    const raw = localStorage.getItem("loom_owner_key");
    if (!raw) return null;
    try {
      const v = JSON.parse(raw);
      return typeof v === "string" && v.length > 0 ? v : null;
    } catch {
      return raw;
    }
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
