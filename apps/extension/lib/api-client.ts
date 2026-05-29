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

export function getApiClient(): LoomClient {
  if (cached) return cached;

  const client = createLoomClient(API_BASE_URL);
  client.use({
    async onRequest({ request }) {
      const key = await getOwnerKey();
      if (key) request.headers.set("X-Loom-Auth", key);
      return request;
    },
  });

  cached = client;
  return cached;
}
