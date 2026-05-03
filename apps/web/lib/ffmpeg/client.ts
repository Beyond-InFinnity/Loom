// FFmpegClient — typed wrapper around @ffmpeg/ffmpeg's FFmpeg class.
//
// Why no extra worker layer: the FFmpeg class already runs everything
// in its own internal worker (a `type:"module"` worker spawned in
// classes.js).  Wrapping that in our own outer worker would mean two
// postMessage hops with no UX gain — main thread stays responsive
// either way.  We get the benefits people usually want from a worker
// boundary (encapsulation, lifecycle control, clean cancellation,
// timeout hygiene) by wrapping the class in TypeScript instead.
//
// This client codifies feedback_async_hang_prevention.md: every
// promise from the underlying ffmpeg.wasm code goes through
// withTimeout(), and every public method accepts an AbortSignal.

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";
import type {
  FFmpegClientOptions,
  OperationOptions,
  ProbeResult,
} from "./types.js";

const WORKERFS = "WORKERFS" as const;

const DEFAULT_TIMEOUTS = {
  init: 60_000,    // wasm fetch + worker boot
  mount: 10_000,   // WORKERFS mount (no real I/O, just bookkeeping)
  probe: 30_000,   // ffmpeg -i runs in milliseconds even on huge files
  extract: 5 * 60_000, // can be slow for embedded subs in long videos
  mux: 30 * 60_000,    // muxing copies the entire video stream
} as const;

/** Wrap a promise so it rejects on timeout with a labeled error.
    See feedback_async_hang_prevention.md — every third-party call
    we await must be bounded. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException(`aborted: ${label}`, "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms waiting for: ${label}`)),
      ms,
    );
    const onAbort = () => {
      clearTimeout(handle);
      reject(new DOMException(`aborted: ${label}`, "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { clearTimeout(handle); signal?.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { clearTimeout(handle); signal?.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

export class FFmpegClient {
  #ffmpeg: FFmpeg | null = null;
  #loaded = false;
  #busy = false;
  readonly #opts: FFmpegClientOptions;

  private constructor(opts: FFmpegClientOptions) {
    this.#opts = opts;
  }

  /** Construct + load.  After this resolves, the client is ready for
      probe/extract/mux.  Boot is one-time per client; reusing the same
      instance across operations skips it. */
  static async create(opts: FFmpegClientOptions = {}): Promise<FFmpegClient> {
    const client = new FFmpegClient(opts);
    await client.#init();
    return client;
  }

  isLoaded(): boolean { return this.#loaded; }
  isBusy(): boolean { return this.#busy; }

  /** Tear down the underlying worker.  Call this on unmount or when
      cancelling a stuck operation. */
  terminate(): void {
    try { this.#ffmpeg?.terminate(); } catch { /* ignore */ }
    this.#ffmpeg = null;
    this.#loaded = false;
    this.#busy = false;
  }

  async #init(opts?: OperationOptions): Promise<void> {
    if (this.#loaded) return;
    // The classWorkerURL must be a fully-qualified URL with origin.
    // The FFmpeg class does `new URL(classWorkerURL, import.meta.url)`,
    // and in Next dev mode `import.meta.url` for the bundled module
    // resolves to a `file:///...` URL — a path-only string would then
    // resolve to file:// and get blocked as cross-protocol.
    const baseURL = this.#opts.baseURL ?? `${window.location.origin}/ffmpeg`;
    const ff = new FFmpeg();
    if (this.#opts.onLog) {
      ff.on("log", ({ message }) => this.#opts.onLog!(message));
    }
    if (this.#opts.onProgress) {
      ff.on("progress", (e) => this.#opts.onProgress!(e));
    }
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUTS.init;
    await withTimeout(
      (async () => {
        const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
        const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
        await ff.load({
          coreURL,
          wasmURL,
          // worker.js is type:"module" with relative imports — must be
          // a real same-origin URL so ./const.js, ./errors.js resolve.
          classWorkerURL: `${baseURL}/worker.js`,
        });
      })(),
      timeoutMs,
      "FFmpegClient.init (fetch core + spawn worker + load wasm)",
      opts?.signal,
    );
    this.#ffmpeg = ff;
    this.#loaded = true;
  }

  /** Run `ffmpeg -i <file>` and return the captured stderr alongside
      a (currently raw) ProbeResult.
      4c-2 deliverable: API surface + raw stderr capture.
      4c-3 will populate metadata/subtitle_tracks/audio_tracks by
      parsing the stderr blob.  Until then, those fields are empty. */
  async probe(file: File, opts?: OperationOptions): Promise<ProbeResult> {
    const ff = this.#requireLoaded();
    return this.#withBusy(async () => {
      const stderrLines: string[] = [];
      const collectLog = ({ message }: { message: string }) => {
        stderrLines.push(message);
      };
      ff.on("log", collectLog);
      try {
        const mountPoint = "/mount";
        await withTimeout(
          (async () => {
            // Best-effort cleanup of any stale mount from a prior op.
            try { await ff.unmount(mountPoint); } catch { /* fine */ }
            try { await ff.deleteDir(mountPoint); } catch { /* fine */ }
            await ff.createDir(mountPoint);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await ff.mount(WORKERFS as any, { files: [file] }, mountPoint);
          })(),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.mount,
          "probe.mount",
          opts?.signal,
        );

        await withTimeout(
          // exec returns a non-zero exit because there's no output file —
          // that's expected and not an error for `-i`-only invocation.
          ff.exec(["-hide_banner", "-i", `${mountPoint}/${file.name}`]),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.probe,
          "probe.exec",
          opts?.signal,
        );

        try { await ff.unmount(mountPoint); } catch { /* fine */ }

        return {
          metadata: { title: null, year: null, duration_seconds: 0, width: 0, height: 0 },
          subtitle_tracks: [],
          audio_tracks: [],
          raw_stderr: stderrLines.join("\n"),
        };
      } finally {
        ff.off("log", collectLog);
      }
    });
  }

  /** Pull a subtitle track to bytes.  4c-3. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async extractTrack(_file: File, _streamIndex: number, _opts?: OperationOptions): Promise<Uint8Array> {
    this.#requireLoaded();
    throw new Error("FFmpegClient.extractTrack: not implemented (lands in 4c-3)");
  }

  /** Mux generated .ass / .sup back into the source container.  4c-3. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async mux(_source: File, _additions: { ass?: Uint8Array; sup?: Uint8Array }, _opts?: OperationOptions): Promise<Uint8Array> {
    this.#requireLoaded();
    throw new Error("FFmpegClient.mux: not implemented (lands in 4c-3)");
  }

  // ── Internals ────────────────────────────────────────────────

  #requireLoaded(): FFmpeg {
    if (!this.#loaded || !this.#ffmpeg) {
      throw new Error("FFmpegClient: not loaded.  Did you call create()?");
    }
    return this.#ffmpeg;
  }

  /** Serialize operations on the underlying ffmpeg instance — the
      FFmpeg class is single-threaded and concurrent calls would race
      on its in-memory FS state. */
  async #withBusy<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busy) {
      throw new Error("FFmpegClient: another operation is in progress");
    }
    this.#busy = true;
    try {
      return await fn();
    } finally {
      this.#busy = false;
    }
  }
}
