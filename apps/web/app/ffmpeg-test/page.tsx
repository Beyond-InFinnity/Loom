"use client";

import { useEffect, useRef, useState } from "react";
import { FFmpegClient } from "../../lib/ffmpeg/client";
import type { ProbeResult, TrackInfo } from "../../lib/ffmpeg/types";
import { SSAFile } from "../../lib/subs/ssa";

// 4c-1 → 4c-3 smoke test page.
//   4c-1 validated ffmpeg.wasm boot + WORKERFS streaming.
//   4c-2 wraps both behind FFmpegClient.
//   4c-3 implements probe (ffprobe→JSON parse), extractTrack, mux.
//
// This page exercises all three operations against a real video the
// user drops in.  Each operation has its own button + result display
// so it's clear which step is being tested.

type StepState = "pending" | "running" | "done" | "error";
type Step = {
  label: string;
  state: StepState;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
};

const INITIAL_STEPS: Step[] = [
  { label: "FFmpegClient.create()", state: "pending" },
  { label: "client.probe(file)", state: "pending" },
];

function downloadBytes(data: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(data)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Tiny synthetic .ass for mux validation.  ~2 dialogue lines so the
// mux step actually does something but stays fast.
const SYNTHETIC_ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: LoomTest,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,1,2,10,10,40,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.00,0:00:05.00,LoomTest,,0,0,0,,Loom mux test — line 1
Dialogue: 0,0:00:06.00,0:00:10.00,LoomTest,,0,0,0,,Loom mux test — line 2
`;

export default function FFmpegTestPage() {
  const clientRef = useRef<FFmpegClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [logs, setLogs] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [coi, setCoi] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);
  const [extractStatus, setExtractStatus] = useState<string | null>(null);
  const [muxStatus, setMuxStatus] = useState<string | null>(null);

  function appendLog(line: string) { setLogs((prev) => [...prev, line]); }
  function patchStep(i: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function resetSteps() {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    setLogs([]);
    setProbeResult(null);
    setExtractStatus(null);
    setMuxStatus(null);
    setTopLevelError(null);
  }

  useEffect(() => {
    if (!steps.some((s) => s.state === "running")) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [steps]);

  useEffect(() => { setCoi(window.crossOriginIsolated); }, []);

  useEffect(() => {
    const onErr = (e: ErrorEvent) =>
      appendLog(`[window error] ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    const onRej = (e: PromiseRejectionEvent) =>
      appendLog(`[unhandled rejection] ${String(e.reason)}`);
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
  }, []);

  useEffect(() => {
    const onDragOver = (e: DragEvent) => { e.preventDefault(); setDragActive(true); };
    const onDragLeave = (e: DragEvent) => { e.preventDefault(); if (!e.relatedTarget) setDragActive(false); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) void handleFile(f);
    };
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      clientRef.current?.terminate();
      clientRef.current = null;
    };
  }, []);

  function abort() {
    abortRef.current?.abort();
    clientRef.current?.terminate();
    clientRef.current = null;
    setBusy(false);
    setTopLevelError("aborted by user");
    setSteps((prev) =>
      prev.map((s) =>
        s.state === "running" ? { ...s, state: "error", detail: "aborted", endedAt: performance.now() } : s,
      ),
    );
  }

  async function runStep<T>(i: number, op: () => Promise<T>): Promise<T> {
    patchStep(i, { state: "running", startedAt: performance.now(), endedAt: undefined, detail: undefined });
    try {
      const result = await op();
      patchStep(i, { state: "done", endedAt: performance.now() });
      return result;
    } catch (err) {
      patchStep(i, { state: "error", endedAt: performance.now(), detail: String(err) });
      throw err;
    }
  }

  async function handleFile(file: File) {
    if (busy) return;
    setBusy(true);
    resetSteps();
    setCurrentFile(file);
    appendLog(`[host] got file: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);
    abortRef.current = new AbortController();
    try {
      if (!clientRef.current) {
        clientRef.current = await runStep(0, () => FFmpegClient.create({
          onLog: (msg) => appendLog(msg),
        }));
      } else {
        patchStep(0, { state: "done", detail: "(cached client from prior run)" });
      }

      const result = await runStep(1, () =>
        clientRef.current!.probe(file, { signal: abortRef.current!.signal }),
      );
      setProbeResult(result);
      appendLog(`[host] probe parsed: ${result.subtitle_tracks.length} subs, ${result.audio_tracks.length} audio, ${result.metadata.width}x${result.metadata.height}, ${result.metadata.duration_seconds.toFixed(1)}s`);
    } catch (err) {
      setTopLevelError(String(err));
      appendLog(`[host] FAILED: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExtract(track: TrackInfo) {
    if (!currentFile || !clientRef.current || busy) return;
    setBusy(true);
    setExtractStatus(`extracting stream #${track.id} (${track.codec})…`);
    try {
      const t0 = performance.now();
      const { data, filename } = await clientRef.current.extractTrack(currentFile, track);
      const dt = ((performance.now() - t0) / 1000).toFixed(1);

      // 4d-1 round-trip self-test: parse extracted bytes via SSAFile,
      // serialize, re-parse, verify event count survives the round trip.
      // Skips image-based subtitles (PGS .sup is binary, not text).
      let parseSummary = "";
      if (track.selectable) {
        try {
          const text = new TextDecoder("utf-8").decode(data);
          const subs = SSAFile.fromString(text);
          const reparsed = SSAFile.fromAss(subs.toAss());
          const ok = reparsed.events.length === subs.events.length;
          const first = subs.events[0];
          parseSummary = ` · parsed: ${subs.events.length} events, ${subs.styles.size} styles` +
            (first ? `, first="${first.text.slice(0, 40)}…"` : "") +
            ` · round-trip: ${ok ? "OK" : `FAIL (${reparsed.events.length} ≠ ${subs.events.length})`}`;
        } catch (e) {
          parseSummary = ` · parse FAILED: ${String(e)}`;
        }
      }

      setExtractStatus(`extracted ${filename} (${(data.length / 1024).toFixed(1)} KB) in ${dt}s${parseSummary} — downloading`);
      downloadBytes(data, filename);
    } catch (err) {
      setExtractStatus(`extract failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleMuxTest() {
    if (!currentFile || !clientRef.current || !probeResult || busy) return;
    setBusy(true);
    setMuxStatus("muxing source + synthetic .ass…");
    try {
      const t0 = performance.now();
      const assBytes = new TextEncoder().encode(SYNTHETIC_ASS);
      const { data, filename } = await clientRef.current.mux(currentFile, {
        ass: assBytes,
        target_lang_code: "eng",
        ass_track_title: "Loom mux test (Loom)",
        existing_subtitle_count: probeResult.subtitle_tracks.length,
      });
      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      setMuxStatus(`muxed ${filename} (${(data.length / 1e6).toFixed(1)} MB) in ${dt}s — downloading`);
      downloadBytes(data, filename);
    } catch (err) {
      setMuxStatus(`mux failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  void tick;

  function elapsed(s: Step): string {
    if (s.state === "pending") return "";
    const start = s.startedAt ?? 0;
    const end = s.endedAt ?? performance.now();
    const dt = ((end - start) / 1000).toFixed(1);
    return s.state === "running" ? ` (${dt}s elapsed…)` : ` (${dt}s)`;
  }
  const stepIcon: Record<StepState, string> = { pending: "·", running: "▶", done: "✓", error: "✗" };
  const stepColor: Record<StepState, string> = {
    pending: "text-zinc-500",
    running: "text-amber-300",
    done: "text-emerald-400",
    error: "text-red-400",
  };

  return (
    <main className="min-h-screen p-8 font-mono text-sm bg-zinc-900 text-zinc-100">
      <h1 className="text-xl mb-2">ffmpeg.wasm probe / extract / mux smoke test (4c-3)</h1>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/50 text-xs">
        <div className="font-bold mb-1 text-zinc-300">What this validates:</div>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li><b>probe</b>: ffprobe-JSON parse populates VideoMetadata + TrackInfo[] + AudioTrackInfo[].</li>
          <li><b>extractTrack</b>: per-subtitle &ldquo;Extract&rdquo; buttons appear after probe — click to download the raw subtitle bytes.</li>
          <li><b>mux</b>: &ldquo;Test mux&rdquo; button bundles a synthetic 2-line .ass into the source as a new track + downloads the resulting .mkv.</li>
        </ul>
      </div>

      <div className="mb-2 text-xs text-zinc-400">
        cross-origin isolated: {coi === null ? "checking…"
          : coi ? <span className="text-emerald-400">true</span>
          : <span className="text-red-400">FALSE</span>}
      </div>

      <div
        className={
          "mb-4 p-8 border-2 border-dashed rounded text-center transition-colors " +
          (dragActive ? "border-emerald-400 bg-emerald-950/30" : "border-zinc-600 bg-zinc-800/40")
        }
      >
        Drop a video file anywhere on this page
      </div>

      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <input type="file" disabled={busy} className="text-zinc-300 disabled:opacity-50"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleFile(f); }} />
        <button type="button" onClick={abort} disabled={!busy}
          className="px-3 py-1 border border-red-500 text-red-300 rounded disabled:opacity-30 disabled:cursor-not-allowed">
          Abort
        </button>
        <button type="button" onClick={() => {
          clientRef.current?.terminate(); clientRef.current = null;
          appendLog("[host] client terminated; next drop will re-boot");
        }} disabled={busy}
          className="px-3 py-1 border border-sky-500 text-sky-300 rounded disabled:opacity-30 disabled:cursor-not-allowed">
          Terminate client
        </button>
      </div>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/30">
        <div className="font-bold mb-2 text-zinc-300 text-xs">probe pipeline:</div>
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={i} className={"text-xs " + stepColor[s.state]}>
              <span className="inline-block w-4">{stepIcon[s.state]}</span>
              <span>{i + 1}. {s.label}</span>
              <span className="text-zinc-500">{elapsed(s)}</span>
              {s.detail && <span className="block ml-6 text-red-300">↳ {s.detail}</span>}
            </li>
          ))}
        </ol>
        {topLevelError && (
          <div className="mt-2 p-2 border border-red-700 rounded bg-red-950/30 text-red-300 text-xs">
            {topLevelError}
          </div>
        )}
      </div>

      {probeResult && (
        <div className="mb-4 p-3 border border-emerald-900 rounded bg-emerald-950/20 text-xs">
          <div className="font-bold mb-2 text-emerald-300">probe → ProbeResult</div>

          <div className="text-zinc-400 mb-2">
            <span className="text-zinc-500">metadata: </span>
            title={String(probeResult.metadata.title)}, year={String(probeResult.metadata.year)},{" "}
            {probeResult.metadata.width}×{probeResult.metadata.height},{" "}
            {probeResult.metadata.duration_seconds.toFixed(1)}s
          </div>

          <div className="mb-2">
            <span className="text-zinc-500">subtitle_tracks ({probeResult.subtitle_tracks.length}):</span>
            {probeResult.subtitle_tracks.length === 0 && <span className="text-zinc-500"> none</span>}
            <ul className="space-y-1 mt-1">
              {probeResult.subtitle_tracks.map((t) => (
                <li key={t.id} className="flex items-center gap-2">
                  <span className="text-zinc-300">
                    #{t.id} {t.label}
                    {!t.selectable && <span className="text-amber-400"> [image-based]</span>}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleExtract(t)}
                    className="px-2 py-0.5 border border-emerald-600 text-emerald-300 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Extract
                  </button>
                </li>
              ))}
            </ul>
            {extractStatus && (
              <div className="mt-2 text-zinc-300 text-xs">↳ {extractStatus}</div>
            )}
          </div>

          <div className="mb-2">
            <span className="text-zinc-500">audio_tracks ({probeResult.audio_tracks.length}):</span>
            <ul className="mt-1 space-y-0.5">
              {probeResult.audio_tracks.map((t) => (
                <li key={t.audio_index} className="text-zinc-300">
                  a#{t.audio_index} ({t.codec}, {t.channels ?? "?"}ch, lang={t.lang_code ?? "—"}, title={t.title ?? "—"})
                </li>
              ))}
            </ul>
          </div>

          <div className="mt-3 pt-3 border-t border-emerald-900">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleMuxTest()}
              className="px-3 py-1 border border-amber-500 text-amber-300 rounded text-xs disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Test mux: source + synthetic 2-line .ass → .mkv
            </button>
            {muxStatus && (
              <div className="mt-2 text-zinc-300 text-xs">↳ {muxStatus}</div>
            )}
          </div>
        </div>
      )}

      <div className="mb-1 text-xs text-zinc-500">
        ffmpeg stderr ({logs.length} lines):
      </div>
      <pre className="bg-black p-3 max-h-[60vh] overflow-auto text-xs whitespace-pre-wrap">
        {logs.join("\n") || "(no logs yet — drop a file)"}
      </pre>
    </main>
  );
}
