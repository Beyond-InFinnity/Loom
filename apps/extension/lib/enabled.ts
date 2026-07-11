// Global per-browser kill switch.
//
// Distinct from the per-tab activation state (sessionStorage in
// loom-app.tsx, which decides dormant-vs-active for ONE tab): this is a
// single browser.storage.local boolean that turns Loom OFF everywhere. When
// false, the content script renders nothing at all — not even the dormant
// pill — so Loom is completely inert on that browser until re-enabled.
//
// Surfaced as a toggle in the popup (both dev + prod builds). It is an
// OPT-OUT switch: absent/unset means enabled, so a fresh install works with
// no setup. Replaces the production owner-key field as the popup's primary
// control (the owner key is dev-only now — see entrypoints/popup/app.tsx).
//
// 7b: reads/writes/onChanged go through the StorageAdapter seam (same
// browser.storage.local underneath in the extension host).

import { storage } from "./host";

const STORAGE_KEY = "loom_enabled";

function coerce(value: unknown): boolean {
  // Absent (undefined) → enabled by default. Any other value is read as a
  // strict boolean so a stray string can't accidentally disable Loom.
  return value === undefined ? true : value === true;
}

export async function getEnabled(): Promise<boolean> {
  const result = await storage.get(STORAGE_KEY);
  return coerce(result[STORAGE_KEY]);
}

export async function setEnabled(enabled: boolean): Promise<void> {
  await storage.set({ [STORAGE_KEY]: enabled });
}

/** Subscribe to changes of the enabled flag. Returns an unsubscribe fn.
    Fires with the new boolean whenever the popup toggles it — this is what
    makes the kill switch live across already-open tabs. */
export function onEnabledChanged(cb: (enabled: boolean) => void): () => void {
  return storage.onChanged((changes) => {
    const change = changes[STORAGE_KEY];
    if (!change) return;
    cb(coerce(change.newValue));
  });
}
