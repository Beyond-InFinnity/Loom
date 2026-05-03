"use client";

import { useEffect, useRef, useState } from "react";
import { FFmpegClient } from "../../lib/ffmpeg/client";
import type { ProbeResult } from "../../lib/ffmpeg/types";

// 4c-1 + 4c-2 smoke test page.
//   4c-1 validated ffmpeg.wasm boot + WORKERFS streaming.
//   4c-2 wraps both behind FFmpegClient — this page now exercises the
//        public API (create, probe, terminate) instead of poking at
//        the underlying @ffmpeg/ffmpeg primitives directly.  If a
//        future change breaks the client, this page surfaces it.

type StepState = "pending" | "running" | "done" | "error";
type Step = {
  label: string;
  state: StepState;
  startedAt?: number;
  endedAt?: number;
  detail?: string;
};

const INITIAL_STEPS: Step[] = [
  { label: "FFmpegClient.create() — boot wasm + worker", state: "pending" },
  { label: "client.probe(file) — mount + ffmpeg -i", state: "pending" },
];

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
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null);

  function appendLog(line: string) {
    setLogs((prev) => [...prev, line]);
  }
  function patchStep(i: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }
  function resetSteps() {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    setLogs([]);
    setProbeResult(null);
    setTopLevelError(null);
  }

  // Heartbeat — proves the UI is alive while a step runs.
  useEffect(() => {
    if (!steps.some((s) => s.state === "running")) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [steps]);

  useEffect(() => { setCoi(window.crossOriginIsolated); }, []);

  // Window-level error capture — silent worker errors from third-party
  // code surface here when the wrapped promises don't see them.
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

  // Window-level drop wiring.
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

  // Tear down the client on unmount.
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
      appendLog(`[host] probe complete: ${result.raw_stderr.split("\n").length} stderr lines captured`);
    } catch (err) {
      setTopLevelError(String(err));
      appendLog(`[host] FAILED: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────

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
      <h1 className="text-xl mb-2">ffmpeg.wasm + FFmpegClient smoke test (4c-2)</h1>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/50 text-xs">
        <div className="font-bold mb-1 text-zinc-300">What this validates:</div>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>FFmpegClient.create() boots wasm + worker through the typed API.</li>
          <li>client.probe(file) returns a ProbeResult with captured stderr.</li>
          <li>Same-client reuse skips the boot step on the second drop (look for &ldquo;cached client from prior run&rdquo;).</li>
          <li>Both calls accept AbortSignal — Abort cancels in-flight work.</li>
          <li>Track/metadata parsing (the populated fields of ProbeResult) lands in 4c-3.</li>
        </ul>
      </div>

      <div className="mb-2 text-xs text-zinc-400">
        cross-origin isolated: {coi === null ? "checking…"
          : coi ? <span className="text-emerald-400">true</span>
          : <span className="text-red-400">FALSE — page won&apos;t work</span>}
      </div>

      <div
        className={
          "mb-4 p-8 border-2 border-dashed rounded text-center transition-colors " +
          (dragActive
            ? "border-emerald-400 bg-emerald-950/30"
            : "border-zinc-600 bg-zinc-800/40")
        }
      >
        Drop a video file anywhere on this page
      </div>

      <div className="mb-4 flex items-center gap-3">
        <input
          type="file"
          disabled={busy}
          className="text-zinc-300 disabled:opacity-50"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
          }}
        />
        <button
          type="button"
          onClick={abort}
          disabled={!busy}
          className="px-3 py-1 border border-red-500 text-red-300 rounded disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Abort
        </button>
        <button
          type="button"
          onClick={() => {
            clientRef.current?.terminate();
            clientRef.current = null;
            appendLog("[host] client terminated; next drop will re-boot");
          }}
          disabled={busy}
          className="px-3 py-1 border border-sky-500 text-sky-300 rounded disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Terminate client
        </button>
      </div>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/30">
        <div className="font-bold mb-2 text-zinc-300 text-xs">pipeline:</div>
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
          <div className="font-bold mb-1 text-emerald-300">ProbeResult (raw):</div>
          <div className="text-zinc-400">
            metadata: {JSON.stringify(probeResult.metadata)}<br />
            subtitle_tracks: {probeResult.subtitle_tracks.length} (parsing in 4c-3)<br />
            audio_tracks: {probeResult.audio_tracks.length} (parsing in 4c-3)<br />
            raw_stderr: {probeResult.raw_stderr.length} chars
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
