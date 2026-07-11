import { loomHost } from "../host";
import { logDebug } from "../log";

import type {
  CaptionEvent,
  StreamChangeDetail,
  StreamStatus,
} from "./types";

// CaptionStream — playhead-driven active-caption emitter.
//
// MAIN-world bridge does all discovery + fetch + parse.  This class
// just receives a `(targetEvents, nativeEvents)` pair, subscribes to the
// host's PlayheadSource (7b seam — the extension impl waits for the
// platform <video> and wraps its `timeupdate`, ~4×/s; a native player
// feeds libmpv time-pos instead), and emits "active caption changed" via
// direct callbacks.

export interface CaptionStreamCallbacks {
  onStatusChange?: (status: StreamStatus) => void;
  onActiveChange?: (detail: StreamChangeDetail) => void;
}

export interface StartPayload {
  targetEvents: CaptionEvent[];
  nativeEvents: CaptionEvent[];
  targetLang: string;
  nativeLang: string;
}

export class CaptionStream {
  #status: StreamStatus = { kind: "idle" };
  #targetEvents: CaptionEvent[] = [];
  #nativeEvents: CaptionEvent[] = [];
  #currentTarget: CaptionEvent | null = null;
  #currentNative: CaptionEvent | null = null;
  #currentTargets: CaptionEvent[] = [];
  #currentNatives: CaptionEvent[] = [];
  #abort: AbortController | null = null;
  #unsubscribeTick: (() => void) | null = null;
  #callbacks: CaptionStreamCallbacks;

  constructor(callbacks: CaptionStreamCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  get status(): StreamStatus {
    return this.#status;
  }

  get currentTarget(): CaptionEvent | null {
    return this.#currentTarget;
  }

  get currentNative(): CaptionEvent | null {
    return this.#currentNative;
  }

  setCallbacks(callbacks: CaptionStreamCallbacks): void {
    this.#callbacks = callbacks;
  }

  /** Begin streaming with already-fetched event lists. */
  async start(payload: StartPayload): Promise<void> {
    await this.stop();
    this.#abort = new AbortController();
    const signal = this.#abort.signal;

    this.#setStatus({ kind: "detecting" });

    try {
      this.#targetEvents = payload.targetEvents;
      this.#nativeEvents = payload.nativeEvents;

      // Diagnostic: log first 3 events of each stream so we can see
      // whether parsed times look right when active-event finding fails.
      logDebug(
        "[Loom Stream] start — target sample:",
        payload.targetEvents.slice(0, 3).map((e) => ({
          start: e.start,
          end: e.end,
          dur: e.end - e.start,
          text: e.text.slice(0, 20),
        })),
      );
      logDebug(
        "[Loom Stream] start — native sample:",
        payload.nativeEvents.slice(0, 3).map((e) => ({
          start: e.start,
          end: e.end,
          dur: e.end - e.start,
          text: e.text.slice(0, 20),
        })),
      );

      const acquire = loomHost().acquirePlayhead;
      const playhead = acquire ? await acquire(signal) : null;
      if (signal.aborted) return;
      if (!playhead) {
        this.#setStatus({
          kind: "error",
          message: "video element not found within 10s",
        });
        return;
      }
      this.#unsubscribeTick = playhead.onTick((ms) => this.#tick(ms));
      logDebug(
        "[Loom Stream] playhead tick subscribed; currentTimeMs=",
        playhead.currentTimeMs(),
        "paused=",
        playhead.paused(),
      );

      this.#setStatus({
        kind: "tracking",
        targetLang: payload.targetLang,
        nativeLang: payload.nativeLang,
      });

      this.#tick(playhead.currentTimeMs());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const message = e instanceof Error ? e.message : String(e);
      console.error("[Loom] CaptionStream.start threw:", message);
      this.#setStatus({ kind: "error", message });
    }
  }

  setUnsupported(reason: "no-captions" | "no-supported-track"): void {
    this.stop();
    this.#setStatus({ kind: "unsupported", reason });
  }

  setError(message: string): void {
    this.stop();
    this.#setStatus({ kind: "error", message });
  }

  /** Tear down the current cycle.  Idempotent. */
  async stop(): Promise<void> {
    this.#abort?.abort();
    this.#abort = null;
    this.#unsubscribeTick?.();
    this.#unsubscribeTick = null;
    this.#targetEvents = [];
    this.#nativeEvents = [];
    if (
      this.#currentTarget !== null ||
      this.#currentNative !== null ||
      this.#currentTargets.length > 0 ||
      this.#currentNatives.length > 0
    ) {
      this.#currentTarget = null;
      this.#currentNative = null;
      this.#currentTargets = [];
      this.#currentNatives = [];
      this.#emitChange();
    }
  }

  #setStatus(status: StreamStatus): void {
    this.#status = status;
    this.#callbacks.onStatusChange?.(status);
  }

  #emitChange(): void {
    const detail: StreamChangeDetail = {
      target: this.#currentTarget,
      native: this.#currentNative,
      targets: this.#currentTargets,
      natives: this.#currentNatives,
    };
    this.#callbacks.onActiveChange?.(detail);
  }

  #tick(currentTimeMs: number): void {
    const t = currentTimeMs;
    // ALL concurrently-active cues per side (a scene can show a bottom
    // dialogue line + a positioned/vertical side cue at once).
    const nextTargets = findActiveAll(this.#targetEvents, t);
    const nextNatives = findActiveAll(this.#nativeEvents, t);
    const nextTarget = pickPrimary(nextTargets);
    const nextNative = nextNatives[0] ?? null;
    if (
      nextTarget === this.#currentTarget &&
      nextNative === this.#currentNative &&
      sameEvents(nextTargets, this.#currentTargets) &&
      sameEvents(nextNatives, this.#currentNatives)
    ) {
      return;
    }
    this.#currentTarget = nextTarget;
    this.#currentNative = nextNative;
    this.#currentTargets = nextTargets;
    this.#currentNatives = nextNatives;
    this.#emitChange();
  }

}

/** Every event overlapping the playhead, in track order. */
function findActiveAll(events: CaptionEvent[], t: number): CaptionEvent[] {
  const out: CaptionEvent[] = [];
  for (const e of events) {
    if (e.start <= t && t < e.end) out.push(e);
  }
  return out;
}

/** The PRIMARY cue for the main (horizontal) dual-subs slot.  ONLY a
    horizontal cue qualifies — a cue with no layout counts as horizontal, so
    YouTube / Netflix (no positional data) resolve to the first active cue,
    identical to the pre-multi-cue behavior.  A VERTICAL cue is never
    promoted here (that would transpose it to horizontal in the main slot,
    losing its orientation + position + adding a romaji line it shouldn't
    have); when every active cue is vertical the primary is null and they
    all render in place as positional extras. */
function pickPrimary(cues: CaptionEvent[]): CaptionEvent | null {
  const horizontals = cues.filter(
    (c) => !c.layout || c.layout.writingMode === "horizontal",
  );
  if (horizontals.length === 0) return null;
  // Prefer a BOTTOM-anchored cue for the main slot (a cue with no layout is
  // bottom by default).  So when a top-positioned sign (Netflix `line:10%`)
  // is concurrent with bottom dialogue, the dialogue stays in the main slot
  // and the sign renders at the top as an extra — not the other way round.
  const bottom = horizontals.find((c) => !c.layout || c.layout.block === "bottom");
  return bottom ?? horizontals[0];
}

/** Reference-equality list compare (events are stable objects from the
    parsed track, so identity is a valid change signal). */
function sameEvents(a: CaptionEvent[], b: CaptionEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
