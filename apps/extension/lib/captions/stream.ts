import { logDev } from "../env";
import { getPlatform } from "./platform";

import type {
  CaptionEvent,
  StreamChangeDetail,
  StreamStatus,
} from "./types";

// CaptionStream — playhead-driven active-caption emitter.
//
// MAIN-world bridge does all discovery + fetch + parse.  This class
// just receives a `(targetEvents, nativeEvents)` pair, hooks
// <video>.timeupdate, and emits "active caption changed" via direct
// callbacks.
//
// The <video> selector is platform-resolved (5h-3): YouTube's
// "video.html5-main-video", Netflix's "#appMountPoint video".  Both
// fire native HTML5 `timeupdate` (~4×/s), which is the same cadence
// YouTube has always used — so Netflix reuses this path verbatim rather
// than the rAF poll the recon tentatively sketched.  (If live testing
// shows Netflix's timeupdate is too coarse, the seam to switch is here.)

const FALLBACK_VIDEO_SELECTOR = "video.html5-main-video";
const VIDEO_WAIT_TIMEOUT_MS = 10_000;

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
  #abort: AbortController | null = null;
  #video: HTMLVideoElement | null = null;
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
      logDev(
        "[Loom Stream] start — target sample:",
        payload.targetEvents.slice(0, 3).map((e) => ({
          start: e.start,
          end: e.end,
          dur: e.end - e.start,
          text: e.text.slice(0, 20),
        })),
      );
      logDev(
        "[Loom Stream] start — native sample:",
        payload.nativeEvents.slice(0, 3).map((e) => ({
          start: e.start,
          end: e.end,
          dur: e.end - e.start,
          text: e.text.slice(0, 20),
        })),
      );

      const video = await this.#waitForVideo(signal);
      if (signal.aborted) return;
      if (!video) {
        this.#setStatus({
          kind: "error",
          message: "video element not found within 10s",
        });
        return;
      }
      this.#video = video;
      video.addEventListener("timeupdate", this.#onTimeUpdate);
      logDev(
        "[Loom Stream] timeupdate listener attached; video currentTime=",
        video.currentTime,
        "paused=",
        video.paused,
        "duration=",
        video.duration,
      );

      this.#setStatus({
        kind: "tracking",
        targetLang: payload.targetLang,
        nativeLang: payload.nativeLang,
      });

      this.#tick(video.currentTime);
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
    if (this.#video) {
      this.#video.removeEventListener("timeupdate", this.#onTimeUpdate);
      this.#video = null;
    }
    this.#targetEvents = [];
    this.#nativeEvents = [];
    if (this.#currentTarget !== null || this.#currentNative !== null) {
      this.#currentTarget = null;
      this.#currentNative = null;
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
    };
    this.#callbacks.onActiveChange?.(detail);
  }

  #onTimeUpdate = (): void => {
    if (this.#video) {
      this.#tick(this.#video.currentTime);
    }
  };

  #tick(currentTimeSeconds: number): void {
    const t = currentTimeSeconds * 1000;
    const nextTarget = findActiveAt(this.#targetEvents, t);
    const nextNative = findActiveAt(this.#nativeEvents, t);
    if (
      nextTarget === this.#currentTarget &&
      nextNative === this.#currentNative
    ) {
      return;
    }
    this.#currentTarget = nextTarget;
    this.#currentNative = nextNative;
    this.#emitChange();
  }

  async #waitForVideo(signal: AbortSignal): Promise<HTMLVideoElement | null> {
    const platform = getPlatform();
    const selector = platform?.videoSelector ?? FALLBACK_VIDEO_SELECTOR;
    // A platform may supply a custom resolver (Prime: the largest real
    // player surface's <video>, not a hidden preview placeholder).  Falls
    // back to the first selector match for platforms without one.
    const resolveVideo = (): HTMLVideoElement | null =>
      platform?.resolveVideo?.() ??
      document.querySelector<HTMLVideoElement>(selector);
    const existing = resolveVideo();
    if (existing) return existing;

    return new Promise<HTMLVideoElement | null>((resolve) => {
      const observer = new MutationObserver(() => {
        const video = resolveVideo();
        if (video) {
          observer.disconnect();
          clearTimeout(timeoutId);
          signal.removeEventListener("abort", abortHandler);
          resolve(video);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      const timeoutId = setTimeout(() => {
        observer.disconnect();
        signal.removeEventListener("abort", abortHandler);
        resolve(null);
      }, VIDEO_WAIT_TIMEOUT_MS);

      const abortHandler = () => {
        observer.disconnect();
        clearTimeout(timeoutId);
        resolve(null);
      };
      signal.addEventListener("abort", abortHandler);
    });
  }
}

function findActiveAt(events: CaptionEvent[], t: number): CaptionEvent | null {
  for (const e of events) {
    if (e.start <= t && t < e.end) return e;
  }
  return null;
}
