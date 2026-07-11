// LoomHost registry — how shared player-ui code reaches its host's seam
// implementations (MOBILE_ROADMAP.md §3).
//
// The host (browser extension, desktop player shell, Android WebView bridge)
// builds its seam impls and calls registerLoomHost() ONCE, at startup,
// before any UI mounts.  Shared modules call loomHost() lazily — never at
// module top level (same rule as i18n's t(): module-scope consts evaluate
// before the host registers).
//
// In the extension, `apps/extension/lib/host.ts` registers at module
// evaluation and every entrypoint imports it first, so extension modules
// may also import the concrete adapters from there directly — the registry
// exists so PACKAGE modules stay host-blind.

import type {
  ApiConfig,
  CaptionTrackSource,
  PlayerAdapter,
  PlayheadSource,
  ScaleSource,
  StorageAdapter,
} from "./seams";

export interface LoomHost {
  storage: StorageAdapter;
  player: PlayerAdapter;
  api: ApiConfig;
  /** Wait for the media surface and return a source bound to it (the
      extension resolves the platform <video>; a native shell resolves
      immediately over its bridge).  Null on timeout/abort. */
  acquirePlayhead?: (signal: AbortSignal) => Promise<PlayheadSource | null>;
  /** The pause-gate playhead: follows the CURRENTLY tracked media (the
      video surface can change identity — Prime's preview→episode
      migration), so it's a getter, not a bound instance. */
  playhead?: () => PlayheadSource | null;
  /** Scale source over the current player root; null when no player is in
      the DOM at call time. */
  scale?: () => ScaleSource | null;
  /** Track ingestion — registered by native players (7c).  The extension
      keeps its discover.ts flow until that flow itself moves behind this. */
  tracks?: CaptionTrackSource;
}

let current: LoomHost | null = null;

export function registerLoomHost(host: LoomHost): void {
  current = host;
}

export function loomHost(): LoomHost {
  if (!current) {
    throw new Error(
      "[player-ui] loomHost() called before registerLoomHost() — the host " +
        "shell must register its seam implementations at startup",
    );
  }
  return current;
}
