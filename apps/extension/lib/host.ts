// The extension's LoomHost — browser-backed implementations of the
// player-ui seams (MOBILE_ROADMAP.md §3), registered at module evaluation.
//
// Import contract: every entrypoint imports this module (directly or via a
// consumer) BEFORE any UI mounts, so registerLoomHost() has always run by
// the time shared code calls loomHost().  Extension-side modules import the
// concrete adapters (`storage`, …) from here directly — a plain ES import
// guarantees evaluation order with no registry race.
//
// `browser.*` (not `chrome.*`) for the Promise-vs-callback reason
// documented in lib/owner-key.ts.

import { registerLoomHost } from "@loom/player-ui/host";
import type {
  ApiConfig,
  PlayerAdapter,
  StorageAdapter,
  StorageChange,
} from "@loom/player-ui/seams";
import { getPlatform } from "./captions/platform";
import {
  acquirePlayhead,
  pausedPlayhead,
  scaleSource,
} from "./host-dom/media-sources";
import { API_BASE_URL } from "./env";

/** browser.storage.local behind the StorageAdapter seam.  Semantics are
    1:1 — same keys, same JSON envelope, cross-context onChanged — so
    rewired callers behave byte-identically to their pre-seam selves. */
export const storage: StorageAdapter = {
  async get(keys) {
    return await browser.storage.local.get(keys);
  },
  async set(items) {
    await browser.storage.local.set(items);
  },
  async remove(keys) {
    await browser.storage.local.remove(keys);
  },
  onChanged(cb) {
    const listener = (
      changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
      areaName: string,
    ): void => {
      if (areaName !== "local") return;
      cb(changes as Record<string, StorageChange>);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  },
};

/** The current streaming site behind the PlayerAdapter seam.  `id` is a
    getter because platform resolution is per-page (and null off-platform —
    popup/onboarding contexts — where it reports "unknown", matching the
    old caption-context fallback). */
export const player: PlayerAdapter = {
  get id(): string {
    return getPlatform()?.id ?? "unknown";
  },
  hideNativeCaptions(): void {
    getPlatform()?.hideNativeCaptions();
  },
  restoreNativeCaptions(): void {
    getPlatform()?.restoreNativeCaptions();
  },
};

/** API identity behind the ApiConfig seam.  ownerKey reads storage directly
    (not lib/owner-key.ts) to keep this module cycle-free — owner-key.ts
    imports `storage` from here. */
export const api: ApiConfig = {
  baseUrl: API_BASE_URL,
  clientVersion: (() => {
    try {
      return browser.runtime.getManifest().version ?? null;
    } catch {
      // Outside a real extension context (vitest) there is no `browser`.
      return null;
    }
  })(),
  async ownerKey(): Promise<string | null> {
    const result = await storage.get("loom_owner_key");
    const value = result["loom_owner_key"];
    return typeof value === "string" && value.length > 0 ? value : null;
  },
};

registerLoomHost({
  storage,
  player,
  api,
  acquirePlayhead,
  playhead: () => pausedPlayhead,
  scale: scaleSource,
});
