// ApiConfig — seam #5 (MOBILE_ROADMAP.md §3).
//
// Injects what `lib/env.ts` build-defines + `lib/api-client.ts` reads from
// `browser.runtime` today: the Loom API base URL, a client-version label for
// the User-Agent-ish header, and the optional owner bypass key.

export interface ApiConfig {
  /** e.g. "https://api.loom.nerv-analytic.ai" (prod) or a localhost sidecar. */
  baseUrl: string;
  /** Client version for the X-Loom-Version telemetry header — the raw
      manifest/app version string (e.g. "0.5.0"); null when unknown (the
      header is then omitted).  Wire-compatible with what the extension has
      always sent — don't prefix or reformat. */
  clientVersion: string | null;
  /** Owner bypass key (X-Loom-Auth) if configured; null otherwise. */
  ownerKey(): Promise<string | null>;
}
