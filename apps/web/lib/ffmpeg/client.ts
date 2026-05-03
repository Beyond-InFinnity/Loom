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
  TrackInfo,
} from "./types";
import { extensionForSubtitleCodec, parseProbeJSON } from "./parse-probe";

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

  /** Probe a video file and return its metadata + subtitle/audio
      track lists.  Uses ffprobe with JSON output (mirrors the Python
      side) — far more robust than parsing ffmpeg's stderr by regex. */
  async probe(file: File, opts?: OperationOptions): Promise<ProbeResult> {
    const ff = this.#requireLoaded();
    return this.#withBusy(async () => {
      const stderrLines: string[] = [];
      const collectLog = ({ message }: { message: string }) => {
        stderrLines.push(message);
      };
      ff.on("log", collectLog);
      const mountPoint = "/mount";
      const inFs = `${mountPoint}/${file.name}`;
      const outFs = "/probe.json";
      try {
        await withTimeout(this.#mountFile(file, mountPoint),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.mount, "probe.mount", opts?.signal);

        // ffprobe writes structured JSON to outFs.  -show_format gives
        // duration + container tags (title/date/year), -show_streams
        // gives per-stream codec_type, codec_name, dimensions, channels,
        // and tags (language/title).
        await withTimeout(
          ff.ffprobe([
            "-v", "error",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            inFs,
            "-o", outFs,
          ]),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.probe,
          "probe.ffprobe",
          opts?.signal,
        );

        const jsonBytes = await ff.readFile(outFs, "utf8");
        // readFile returns FileData = Uint8Array | string.  When encoding
        // is set, we get a string back; type narrowing for the parser.
        const jsonText = typeof jsonBytes === "string"
          ? jsonBytes
          : new TextDecoder().decode(jsonBytes);

        await this.#cleanupMount(mountPoint);
        try { await ff.deleteFile(outFs); } catch { /* best effort */ }

        const result = parseProbeJSON(jsonText, file.name);
        result.raw_stderr = stderrLines.join("\n");
        return result;
      } finally {
        ff.off("log", collectLog);
      }
    });
  }

  /** Extract one subtitle track from a video file to its native bytes.
      Caller picks the stream by ffmpeg index (TrackInfo.id from probe).
      Returns the raw subtitle file contents (e.g. .srt UTF-8 text bytes,
      .ass UTF-8 text bytes, .sup PGS binary).  Codec → extension picked
      automatically; pass `track.codec` from probe to avoid surprises. */
  async extractTrack(
    file: File,
    track: Pick<TrackInfo, "id" | "codec">,
    opts?: OperationOptions,
  ): Promise<{ data: Uint8Array; filename: string }> {
    const ff = this.#requireLoaded();
    return this.#withBusy(async () => {
      const mountPoint = "/mount";
      const inFs = `${mountPoint}/${file.name}`;
      const ext = extensionForSubtitleCodec(track.codec);
      const outFs = `/extract.${ext}`;
      try {
        await withTimeout(this.#mountFile(file, mountPoint),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.mount, "extract.mount", opts?.signal);

        // -map 0:N picks the source stream by index (TrackInfo.id).
        // -c copy avoids any re-encoding for text subs.  The container
        // is implied by the output extension (Matroska single-stream
        // for .sup, raw text for .srt/.ass/.vtt).
        await withTimeout(
          ff.exec(["-hide_banner", "-i", inFs, "-map", `0:${track.id}`, "-c", "copy", outFs]),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.extract,
          "extract.exec",
          opts?.signal,
        );

        const data = await ff.readFile(outFs);
        const bytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;

        await this.#cleanupMount(mountPoint);
        try { await ff.deleteFile(outFs); } catch { /* best effort */ }

        const baseName = file.name.replace(/\.[^.]+$/, "");
        return { data: bytes, filename: `${baseName}.track${track.id}.${ext}` };
      } catch (err) {
        await this.#cleanupMount(mountPoint);
        throw err;
      }
    });
  }

  /** Mux generated .ass / .sup back into the source container.
      Mirrors loom_core/video/mkv_handler.py::merge_subs_to_mkv flag-
      for-flag.  Output is always MKV (only container that supports
      ASS + PGS + attachments together). */
  async mux(
    source: File,
    additions: {
      ass?: Uint8Array;
      sup?: Uint8Array;
      target_lang_code?: string | null;
      ass_track_title?: string | null;
      pgs_track_title?: string | null;
      keep_existing_subs?: boolean;
      keep_attachments?: boolean;
      default_audio_index?: number | null;
      /** Number of subtitle streams already in the source — required
          when keep_existing_subs is true so the new tracks land at the
          right -disposition / -metadata indices.  Pass from probe. */
      existing_subtitle_count?: number;
    },
    opts?: OperationOptions,
  ): Promise<{ data: Uint8Array; filename: string }> {
    const ff = this.#requireLoaded();
    if (!additions.ass && !additions.sup) {
      throw new Error("FFmpegClient.mux: at least one of ass/sup required");
    }
    return this.#withBusy(async () => {
      const mountPoint = "/mount";
      const inFs = `${mountPoint}/${source.name}`;
      const assFs = additions.ass ? "/in.ass" : null;
      const supFs = additions.sup ? "/in.sup" : null;
      const baseName = source.name.replace(/\.[^.]+$/, "");
      const outFs = `/${baseName}.loom.mkv`;

      const keepExistingSubs = additions.keep_existing_subs ?? true;
      const keepAttachments = additions.keep_attachments ?? true;
      const existingSubCount = keepExistingSubs ? (additions.existing_subtitle_count ?? 0) : 0;

      try {
        await withTimeout(this.#mountFile(source, mountPoint),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.mount, "mux.mount", opts?.signal);

        if (assFs) await ff.writeFile(assFs, additions.ass!);
        if (supFs) await ff.writeFile(supFs, additions.sup!);

        const args: string[] = ["-hide_banner", "-y", "-i", inFs];
        if (assFs) args.push("-i", assFs);
        if (supFs) args.push("-i", supFs);

        // Map source streams by type (mirrors merge_subs_to_mkv).  Order
        // matters for the disposition/metadata index math below.
        args.push("-map", "0:v", "-map", "0:a");
        if (keepExistingSubs) args.push("-map", "0:s?");

        let nextInput = 1;
        let assSubIdx: number | null = null;
        let supSubIdx: number | null = null;
        if (assFs) {
          args.push("-map", String(nextInput));
          assSubIdx = existingSubCount;
          nextInput += 1;
        }
        if (supFs) {
          args.push("-map", String(nextInput));
          supSubIdx = existingSubCount + (assFs ? 1 : 0);
          nextInput += 1;
        }
        if (keepAttachments) args.push("-map", "0:t?");

        args.push("-c", "copy");
        if (assSubIdx !== null) args.push(`-c:s:${assSubIdx}`, "ass");

        // Strict DTS-order interleaving — see merge_subs_to_mkv comment
        // (without this, subtitle blocks get clustered and disappear).
        args.push("-max_interleave_delta", "0");

        // Clear all subtitle dispositions, set our default.
        args.push("-disposition:s", "0");
        const defaultIdx = supSubIdx ?? assSubIdx;
        if (defaultIdx !== null) args.push(`-disposition:s:${defaultIdx}`, "default");

        if (additions.default_audio_index != null) {
          args.push("-disposition:a", "0");
          args.push(`-disposition:a:${additions.default_audio_index}`, "default");
        }

        // Per-stream metadata for new tracks.
        if (assSubIdx !== null) {
          if (additions.target_lang_code) {
            args.push(`-metadata:s:s:${assSubIdx}`, `language=${additions.target_lang_code}`);
          }
          if (additions.ass_track_title) {
            args.push(`-metadata:s:s:${assSubIdx}`, `title=${additions.ass_track_title}`);
          }
        }
        if (supSubIdx !== null) {
          if (additions.target_lang_code) {
            args.push(`-metadata:s:s:${supSubIdx}`, `language=${additions.target_lang_code}`);
          }
          if (additions.pgs_track_title) {
            args.push(`-metadata:s:s:${supSubIdx}`, `title=${additions.pgs_track_title}`);
          }
        }

        args.push(outFs);

        await withTimeout(
          ff.exec(args),
          opts?.timeoutMs ?? DEFAULT_TIMEOUTS.mux,
          "mux.exec",
          opts?.signal,
        );

        const data = await ff.readFile(outFs);
        const bytes = typeof data === "string"
          ? new TextEncoder().encode(data)
          : data;

        await this.#cleanupMount(mountPoint);
        if (assFs) try { await ff.deleteFile(assFs); } catch { /* best effort */ }
        if (supFs) try { await ff.deleteFile(supFs); } catch { /* best effort */ }
        try { await ff.deleteFile(outFs); } catch { /* best effort */ }

        return { data: bytes, filename: `${baseName}.loom.mkv` };
      } catch (err) {
        await this.#cleanupMount(mountPoint);
        throw err;
      }
    });
  }

  // ── Internals ────────────────────────────────────────────────

  #requireLoaded(): FFmpeg {
    if (!this.#loaded || !this.#ffmpeg) {
      throw new Error("FFmpegClient: not loaded.  Did you call create()?");
    }
    return this.#ffmpeg;
  }

  /** WORKERFS-mount a File at mountPoint, cleaning up any leftover
      mount from a prior op first.  Used by every operation that needs
      streaming access to the input. */
  async #mountFile(file: File, mountPoint: string): Promise<void> {
    const ff = this.#ffmpeg!;
    try { await ff.unmount(mountPoint); } catch { /* fine */ }
    try { await ff.deleteDir(mountPoint); } catch { /* fine */ }
    await ff.createDir(mountPoint);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await ff.mount(WORKERFS as any, { files: [file] }, mountPoint);
  }

  /** Best-effort unmount + dir cleanup.  Errors swallowed because
      this runs in finally/catch paths where re-throwing would mask
      the real failure. */
  async #cleanupMount(mountPoint: string): Promise<void> {
    const ff = this.#ffmpeg;
    if (!ff) return;
    try { await ff.unmount(mountPoint); } catch { /* fine */ }
    try { await ff.deleteDir(mountPoint); } catch { /* fine */ }
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
