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

import { loomHost } from "./host";

let cached: LoomClient | null = null;

export function getApiClient(): LoomClient {
  if (cached) return cached;
  const api = loomHost().api;

  // Base URL + version + owner key all come from the ApiConfig seam (7b) —
  // the extension host feeds the build-time API_BASE_URL, the manifest
  // version (X-Loom-Version: server-side version observability across ALL
  // browsers — AMO usage stats cover Firefox only), and the stored owner
  // bypass key.
  const client = createLoomClient(api.baseUrl);
  client.use({
    async onRequest({ request }) {
      const key = await loomHost().api.ownerKey();
      if (key) request.headers.set("X-Loom-Auth", key);
      if (api.clientVersion) {
        request.headers.set("X-Loom-Version", api.clientVersion);
      }
      return request;
    },
  });

  cached = client;
  return cached;
}
