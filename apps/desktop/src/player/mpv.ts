// JS side of the mpv IPC engine (7c) — invoke wrappers over the Rust
// commands plus the PlayheadSource seam impl fed by observed properties.
//
// One module-level property store: the Rust event pump emits "mpv-prop"
// Tauri events for time-pos / pause / duration / eof-reached; this module
// folds them into state and fans out to subscribers.  The PlayheadSource
// built on top is what CaptionStream + the pause-gloss gate consume — the
// libmpv analog of the extension's <video>.timeupdate wrapper.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PlayheadSource } from "@loom/player-ui/seams";

interface MpvPropPayload {
  name?: string;
  data?: unknown;
}

let timeMs = 0;
let paused = false;
let durationMs = 0;
let eof = false;
let listening = false;

const tickSubs = new Set<(ms: number) => void>();
const pauseSubs = new Set<(paused: boolean) => void>();
const stateSubs = new Set<() => void>();

function notifyState(): void {
  stateSubs.forEach((f) => f());
}

/** Idempotent — call once at Player mount.  Keeps listening for the app's
    lifetime (mpv restarts reuse the same event channel). */
export async function initMpvEvents(): Promise<void> {
  if (listening) return;
  listening = true;
  await listen<MpvPropPayload>("mpv-prop", (e) => {
    const { name, data } = e.payload ?? {};
    switch (name) {
      case "time-pos":
        if (typeof data === "number") {
          timeMs = data * 1000;
          tickSubs.forEach((f) => f(timeMs));
          notifyState();
        }
        break;
      case "pause":
        if (typeof data === "boolean" && data !== paused) {
          paused = data;
          pauseSubs.forEach((f) => f(paused));
          notifyState();
        }
        break;
      case "duration":
        if (typeof data === "number") {
          durationMs = data * 1000;
          notifyState();
        }
        break;
      case "eof-reached":
        eof = data === true;
        notifyState();
        break;
    }
  });
}

export async function startMpv(mediaPath: string): Promise<void> {
  timeMs = 0;
  durationMs = 0;
  eof = false;
  await invoke("mpv_start", { mediaPath, extraArgs: [] });
}

export async function mpvCommand(command: unknown[]): Promise<void> {
  await invoke("mpv_command", { command });
}

export async function stopMpv(): Promise<void> {
  await invoke("mpv_stop");
}

export async function setPause(value: boolean): Promise<void> {
  await mpvCommand(["set_property", "pause", value]);
}

export async function seekToMs(ms: number): Promise<void> {
  await mpvCommand(["set_property", "time-pos", ms / 1000]);
}

/** Loom's generated 4-layer .ass, served by the sidecar — mpv's demuxer
    reads http URLs directly, so no temp file. */
export async function addLoomSubs(url: string): Promise<void> {
  await mpvCommand(["sub-add", url, "select", "Loom"]);
}

export const mpvPlayhead: PlayheadSource = {
  currentTimeMs: () => timeMs,
  onTick(cb) {
    tickSubs.add(cb);
    return () => tickSubs.delete(cb);
  },
  paused: () => paused,
  onPausedChange(cb) {
    pauseSubs.add(cb);
    return () => pauseSubs.delete(cb);
  },
};

/** LoomHost.acquirePlayhead — the mpv playhead exists as soon as the
    process does; no waiting analog to the extension's video hunt. */
export async function acquireMpvPlayhead(
  _signal: AbortSignal,
): Promise<PlayheadSource | null> {
  return mpvPlayhead;
}

/** Coarse state snapshot for the transport UI (subscribe + read). */
export function getMpvState(): {
  timeMs: number;
  durationMs: number;
  paused: boolean;
  eof: boolean;
} {
  return { timeMs, durationMs, paused, eof };
}

export function onMpvState(cb: () => void): () => void {
  stateSubs.add(cb);
  return () => stateSubs.delete(cb);
}
