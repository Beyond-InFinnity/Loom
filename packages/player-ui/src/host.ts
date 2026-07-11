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
  /** Playhead/scale are resolved per-mount (the video surface can change
      identity — Prime's preview→episode migration); hosts return the
      CURRENT source.  Optional until 7c: the extension registers them in
      7b, but package modules must tolerate their absence. */
  playhead?: () => PlayheadSource | null;
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
