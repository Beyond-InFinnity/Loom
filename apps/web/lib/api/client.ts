// Singleton LoomClient bound to the API base URL the build was given.
//
// In dev, NEXT_PUBLIC_LOOM_API points at the local slim API
// (http://localhost:8765 — see loom_api/web.py).  In prod, Vercel sets it
// to https://api.loom.nerv-analytic.ai.  Falls back to the local URL if
// unset so a fresh `npm run dev` Just Works.

import { createLoomClient, type LoomClient } from "@loom/api-client";

const DEFAULT_BASE = "http://localhost:8765";

let cached: LoomClient | null = null;

export function loomApi(): LoomClient {
  if (cached) return cached;
  const base = process.env.NEXT_PUBLIC_LOOM_API?.trim() || DEFAULT_BASE;
  cached = createLoomClient(base);
  return cached;
}
