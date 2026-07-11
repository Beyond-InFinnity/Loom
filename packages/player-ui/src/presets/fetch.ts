// Fetch the color-preset catalog from the slim API.
//
// /styles/presets?lang= returns universal presets + any language-scoped
// presets matching the supplied BCP-47 code.  Empty lang returns
// universal only.  Cached per-lang at module scope — most users won't
// switch target lang during a session, so this is effectively a one-
// time fetch.  Cache is dropped on extension reload.
//
// Why module-level cache instead of caption-context state: the fetch
// is per-(target lang) but the catalog is the SAME wire response for
// the same lang regardless of which video the user is on.  Sharing
// across tabs / videos via module scope is correct.

import { getApiClient } from "../api-client";
import { logDebug } from "../log";
import type { PresetCatalog } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;

const cache = new Map<string, PresetCatalog>();
const inflight = new Map<string, Promise<PresetCatalog | null>>();

export interface FetchPresetsOptions {
  /** BCP-47 lang code of the active TARGET track.  Empty string ⇒
   *  universal presets only.  null ⇒ same as empty. */
  lang: string | null;
  signal?: AbortSignal;
}

/** Returns the preset catalog for the given language code.  Empty
 *  catalog ({groups:[], presets:[]}) on network failure — the UI
 *  treats it as "no presets available" rather than throwing. */
export async function fetchPresetCatalog(
  opts: FetchPresetsOptions,
): Promise<PresetCatalog | null> {
  const langKey = opts.lang ?? "";
  const cached = cache.get(langKey);
  if (cached) return cached;
  const pending = inflight.get(langKey);
  if (pending) return pending;

  const promise = doFetch(langKey, opts.signal).finally(() => {
    inflight.delete(langKey);
  });
  inflight.set(langKey, promise);
  return promise;
}

async function doFetch(
  langKey: string,
  parentSignal?: AbortSignal,
): Promise<PresetCatalog | null> {
  const client = getApiClient();
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  const parentListener = () => ctrl.abort();
  if (parentSignal) {
    parentSignal.addEventListener("abort", parentListener, { once: true });
  }

  try {
    const { data, error, response } = await client.GET("/styles/presets", {
      params: { query: langKey ? { lang: langKey } : {} },
      signal: ctrl.signal,
    });
    if (error || !data) {
      console.warn(
        "[Loom Presets] /styles/presets HTTP",
        response?.status ?? "?",
        "lang=" + (langKey || "(universal)"),
        error,
      );
      return null;
    }
    const catalog = data as PresetCatalog;
    cache.set(langKey, catalog);
    logDebug(
      "[Loom Presets] catalog loaded — lang=" + (langKey || "(universal)"),
      "groups=" + catalog.groups.length,
      "presets=" + catalog.presets.length,
    );
    return catalog;
  } catch (e) {
    const err = e as Error;
    console.warn(
      "[Loom Presets] /styles/presets threw — lang=" + langKey,
      err.message,
    );
    return null;
  } finally {
    clearTimeout(timeoutId);
    if (parentSignal) {
      parentSignal.removeEventListener("abort", parentListener);
    }
  }
}
