// Owner-key storage helpers.  Mirrors the web app's localStorage path
// from apps/web/components/owner-key-bootstrap.tsx but uses
// browser.storage.local — the only storage available to MV3 service
// workers, and the only one that works consistently across Chrome +
// Firefox.
//
// `browser.*` (not `chrome.*`).  Firefox's `chrome.*` namespace is a
// callback-style compat alias that silently returns `undefined` from
// `get`/`set` instead of a Promise.  Awaiting it resolves to undefined
// and the next property access throws.  `browser.*` is Promise-native
// on Firefox + polyfilled by WXT on Chrome.
//
// The key bypasses slowapi rate limits on the slim API when injected
// as the X-Loom-Auth header.  See loom_api/web.py::BypassAwareSlowAPI.

const STORAGE_KEY = "loom_owner_key";

export async function getOwnerKey(): Promise<string | null> {
  const result = await browser.storage.local.get(STORAGE_KEY);
  const value = result[STORAGE_KEY];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function setOwnerKey(key: string): Promise<void> {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    await browser.storage.local.remove(STORAGE_KEY);
    return;
  }
  await browser.storage.local.set({ [STORAGE_KEY]: trimmed });
}
