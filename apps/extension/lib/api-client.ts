// Singleton @loom/api-client with X-Loom-Auth middleware.  Used by both
// the popup (for /health smoke) and — starting in 5d — the content
// script (for /romanize fan-out).
//
// Direct fetch path from the call site (no background-worker proxy).
// This relies on the slim API's CORS regex
// `chrome-extension://.*|moz-extension://.*` shipping in lockstep with
// this extension; see loom_api/web.py.  If the smoke /health from the
// popup ever returns CORS-blocked, that regex is the first place to
// look.

import { createLoomClient, type LoomClient } from "@loom/api-client";

import { getOwnerKey } from "./owner-key";
import { API_BASE_URL } from "./env";

let cached: LoomClient | null = null;

/** Extension version for the X-Loom-Version header — server-side version
    observability across ALL browsers (AMO usage stats cover Firefox only;
    Railway logs + this header answer "who runs what" everywhere).  Guarded:
    outside a real extension context (vitest) there is no `browser`. */
function extensionVersion(): string | null {
  try {
    return browser.runtime.getManifest().version ?? null;
  } catch {
    return null;
  }
}

export function getApiClient(): LoomClient {
  if (cached) return cached;

  const version = extensionVersion();
  const client = createLoomClient(API_BASE_URL);
  client.use({
    async onRequest({ request }) {
      const key = await getOwnerKey();
      if (key) request.headers.set("X-Loom-Auth", key);
      if (version) request.headers.set("X-Loom-Version", version);
      return request;
    },
  });

  cached = client;
  return cached;
}
