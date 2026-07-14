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
let speed = 1;
let dwidth = 0;
let dheight = 0;
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
      case "speed":
        if (typeof data === "number") {
          speed = data;
          notifyState();
        }
        break;
      case "dwidth":
        if (typeof data === "number") {
          dwidth = data;
          notifyState();
        }
        break;
      case "dheight":
        if (typeof data === "number") {
          dheight = data;
          notifyState();
        }
        break;
    }
  });
}

/** Reparent this window's webview over a GtkGLArea + wire the libmpv
    render context (single-window engine).  Call once, from the player
    window, before loading media. */
export async function attachPlayer(): Promise<void> {
  await invoke("player_attach");
}

export async function startMpv(mediaPath: string): Promise<void> {
  timeMs = 0;
  durationMs = 0;
  eof = false;
  await invoke("player_load", { path: mediaPath });
}

export async function mpvCommand(command: unknown[]): Promise<void> {
  // The render engine takes a string[] (mirrors the mpv command array).
  await invoke("player_command", { command: command.map((c) => String(c)) });
}

export async function stopMpv(): Promise<void> {
  await invoke("player_stop");
}

/** Tell the native engine the DOM overlay changed, so it re-captures it over
    the video.  Damage-driven capture: the engine snapshots for a short burst
    after each nudge (covering CSS fades) then idles, so 4K playback stays
    smooth.  Fire-and-forget — never throws into React. */
export function nudgeDomCapture(): void {
  void invoke("player_dom_dirty").catch(() => {});
}

export async function setPause(value: boolean): Promise<void> {
  // Use the `set` command (NOT `set_property` — that is not an mpv input
  // command and silently no-ops) with mpv's flag values "yes"/"no".
  await mpvCommand(["set", "pause", value ? "yes" : "no"]);
}

/** Toggle pause regardless of the UI's tracked state — robust to a stale
    `paused` snapshot (e.g. before the first property event lands). */
export async function cyclePause(): Promise<void> {
  await mpvCommand(["cycle", "pause"]);
}

/** Set the engine mute state (in-session only — audio defaults ON). */
export async function setMute(value: boolean): Promise<void> {
  await invoke("player_set_mute", { muted: value });
}

/** The engine mute state (always false now — audio defaults ON). */
export async function isMutedPersisted(): Promise<boolean> {
  return (await invoke("player_is_muted")) as boolean;
}

export async function setAudioLang(lang: string): Promise<void> {
  // mpv picks the first audio track whose language matches (ISO-639, e.g.
  // "jpn,ja").  A no-op if the file has one audio track.  Uses `set` — NOT
  // `set_property`, which is not a valid mpv input command.
  await mpvCommand(["set", "alang", lang]);
}

export async function seekToMs(ms: number): Promise<void> {
  // The `seek` command (target seconds, absolute) — `set_property time-pos`
  // is not a valid input command and silently no-ops (the seek bug).
  await mpvCommand(["seek", ms / 1000, "absolute"]);
}

/** Set mpv playback volume (0–100).  Independent of mute — a muted player
    stays silent regardless of volume. */
export async function setVolume(value: number): Promise<void> {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  await mpvCommand(["set", "volume", v]);
}

/** Seek by a relative number of seconds (negative = backward). */
export async function seekRelative(seconds: number): Promise<void> {
  await mpvCommand(["seek", seconds, "relative"]);
}

/** Set playback speed (clamped 0.25–4×). */
export async function setSpeed(value: number): Promise<void> {
  const v = Math.max(0.25, Math.min(4, value));
  await mpvCommand(["set", "speed", v]);
}

/** Cycle the A-B loop: 1st call sets point A, 2nd sets B (loops), 3rd clears. */
export async function toggleAbLoop(): Promise<void> {
  await mpvCommand(["ab-loop"]);
}

export interface MpvTrack {
  type: string; // "video" | "audio" | "sub"
  id: number | null;
  lang: string | null;
  title: string | null;
  selected: boolean;
}

/** The file's audio/subtitle/video tracks, as mpv sees them. */
export async function fetchTrackList(): Promise<MpvTrack[]> {
  try {
    return ((await invoke("player_track_list")) as MpvTrack[]) ?? [];
  } catch {
    return [];
  }
}

/** Select the audio track by mpv track id. */
export async function setAudioTrack(id: number): Promise<void> {
  await mpvCommand(["set", "aid", id]);
}

/** Select an embedded subtitle track (mpv/libass renders it — separate from
    Loom's DOM captions), or "no" to hide mpv's own subs. */
export async function setSubTrack(id: number | "no"): Promise<void> {
  await mpvCommand(["set", "sid", id]);
}

/** Hand a Loom-generated songs .ass to mpv/libass (preserving OP/ED animation
    that the DOM path would flatten).  Returns the new subtitle track id — pass
    it to removeSub() before adding a replacement on track switch. */
export async function addLoomSubs(content: string): Promise<number> {
  return (await invoke("player_add_loom_subs", { content })) as number;
}

/** Remove a previously-added subtitle track by id (the Loom songs track). */
export async function removeSub(id: number): Promise<void> {
  await mpvCommand(["sub-remove", id]);
}

/** Select mpv's SECONDARY subtitle track (rendered alongside the primary sid),
    or "no" to clear it — used by "Original subtitles → Both". */
export async function setSecondarySubTrack(id: number | "no"): Promise<void> {
  await mpvCommand(["set", "secondary-sid", id]);
}

/** libass advance ratio (fullwidth advance / fontsize) for each base lyric font
    that actually renders it — embedded MKV attachment, else fontconfig.  Lets
    song furigana align in the ORIGINAL OP typeface (no Noto pin).  Families that
    can't be resolved are omitted → the caller keeps the pin.  `lang` (ja/zh/ko)
    biases fontconfig to a CJK-covering face, mirroring libass's fallback. */
export async function fontAdvanceRatios(
  families: string[],
  videoPath: string,
  lang: string,
): Promise<Record<string, number>> {
  if (families.length === 0) return {};
  try {
    return (await invoke("player_font_advance_ratios", {
      families,
      videoPath,
      lang,
    })) as Record<string, number>;
  } catch (e) {
    console.debug("[Loom Player] font_advance_ratios failed:", e);
    return {};
  }
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
  speed: number;
  dwidth: number;
  dheight: number;
} {
  return { timeMs, durationMs, paused, eof, speed, dwidth, dheight };
}

export function onMpvState(cb: () => void): () => void {
  stateSubs.add(cb);
  return () => stateSubs.delete(cb);
}
