// PlayerAdapter / PlayheadSource / ScaleSource — seams #2 and #3
// (MOBILE_ROADMAP.md §3).
//
// Replaces the DOM surface that `getPlatform()` + `<video>` provide in the
// extension: who the host is, where the player root/video live, the
// playhead clock, pause state, and the rendered-picture height that drives
// font scaling (`usePlayerScale`).
//
// In the extension (7b) these wrap the existing platform impls; in a native
// player the shell feeds them over the WebView bridge (libmpv `time-pos` /
// `pause` property observation; render-size callbacks).

export interface PlayerAdapter {
  /** Stable host id — the extension's platform id ("youtube", "netflix",
      "prime", …) or a fixed id for native shells ("player",
      "player-android").  Keys per-platform prefs and corpus captures. */
  id: string;
  /** Hide the host's own caption rendering while Loom draws (extension:
      injected CSS; native player: `sid=no` — typically a no-op because the
      shell never enables native sub rendering). */
  hideNativeCaptions(): void;
  restoreNativeCaptions(): void;
}

export interface PlayheadSource {
  /** Current media position in ms.  Synchronous — callers poll it on their
      own cadence in addition to subscribing. */
  currentTimeMs(): number;
  /** Fires on every position tick (extension: `<video>.timeupdate` ≈4 Hz;
      libmpv: `time-pos` observation).  Returns unsubscribe. */
  onTick(cb: (timeMs: number) => void): () => void;
  paused(): boolean;
  /** Fires on play/pause edges.  Returns unsubscribe. */
  onPausedChange(cb: (paused: boolean) => void): () => void;
}

export interface ScaleSource {
  /** Height in CSS px of the VISIBLE VIDEO PICTURE (letterboxing excluded —
      the object-fit:contain box, per the usePlayerScale tripwire), used as
      `pictureHeight / 1080` font scaling. */
  pictureHeightPx(): number;
  /** Fires when the picture size changes (resize, fullscreen, rotation).
      Returns unsubscribe. */
  onResize(cb: (heightPx: number) => void): () => void;
}
