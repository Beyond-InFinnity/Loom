// ApiConfig — seam #5 (MOBILE_ROADMAP.md §3).
//
// Injects what `lib/env.ts` build-defines + `lib/api-client.ts` reads from
// `browser.runtime` today: the Loom API base URL, a client-version label for
// the User-Agent-ish header, and the optional owner bypass key.

export interface ApiConfig {
  /** e.g. "https://api.loom.nerv-analytic.ai" (prod) or a localhost sidecar. */
  baseUrl: string;
  /** Client identity for telemetry headers — replaces
      `browser.runtime.getManifest().version` (e.g. "extension/0.5.0",
      "player-android/0.1.0"). */
  clientVersion: string;
  /** Owner bypass key (X-Loom-Auth) if configured; null otherwise. */
  ownerKey(): Promise<string | null>;
}
