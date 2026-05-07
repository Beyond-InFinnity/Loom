// Singleton LoomClient bound to the API base URL the build was given.
//
// In dev, NEXT_PUBLIC_LOOM_API points at the local slim API
// (http://localhost:8765 — see loom_api/web.py).  In prod, Vercel sets it
// to https://api.loom.nerv-analytic.ai.  Falls back to the local URL if
// unset so a fresh `npm run dev` Just Works.
//
// Owner bypass: if localStorage has `loom_owner_key` set (populated by
// the OwnerKeyBootstrap component when the user visits with
// `?owner_key=...`), every request gets an X-Loom-Auth header.  The
// backend's BypassAwareSlowAPI middleware skips the rate limiter for
// requests whose header matches LOOM_BYPASS_KEYS.  See
// apps/web/components/owner-key-bootstrap.tsx for the storage path
// and CLAUDE.md "Owner Auth Roadmap" for the full plan.

import createClient, { type Middleware } from "openapi-fetch";
import { type LoomClient, type paths } from "@loom/api-client";

const DEFAULT_BASE = "http://localhost:8765";
const OWNER_KEY_STORAGE = "loom_owner_key";

/** Read the owner bypass key from localStorage at request time so a
    fresh value (set via /?owner_key=... after page load) takes effect
    on the next request without re-creating the client. */
function readOwnerKey(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(OWNER_KEY_STORAGE);
  } catch {
    return null;
  }
}

const ownerKeyMiddleware: Middleware = {
  async onRequest({ request }) {
    const key = readOwnerKey();
    if (key) request.headers.set("X-Loom-Auth", key);
    return request;
  },
};

let cached: LoomClient | null = null;

export function loomApi(): LoomClient {
  if (cached) return cached;
  const base = process.env.NEXT_PUBLIC_LOOM_API?.trim() || DEFAULT_BASE;
  const client = createClient<paths>({ baseUrl: base });
  client.use(ownerKeyMiddleware);
  cached = client;
  return cached;
}
