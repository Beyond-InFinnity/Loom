"use client";

import { useEffect, useRef, useState } from "react";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { toBlobURL } from "@ffmpeg/util";

const WORKERFS = "WORKERFS" as const;

// Wrap any promise so a never-settling third-party call surfaces as a
// labeled rejection within `ms` instead of a silent infinite spinner.
// Banned bug class per feedback_async_hang_prevention.md.
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(
      () => reject(new Error(`timeout after ${ms}ms waiting for: ${label}`)),
      ms,
    );
    p.then(
      (v) => { clearTimeout(handle); resolve(v); },
      (e) => { clearTimeout(handle); reject(e); },
    );
  });
}

type StepState = "pending" | "running" | "done" | "error";
type Step = {
  label: string;
  state: StepState;
  startedAt?: number;
  endedAt?: number;
  timeoutMs: number;
  detail?: string;
};

const INITIAL_STEPS: Step[] = [
  { label: "fetch ffmpeg-core.js (~110KB)", state: "pending", timeoutMs: 15_000 },
  { label: "fetch ffmpeg-core.wasm (~31MB)", state: "pending", timeoutMs: 60_000 },
  { label: "spawn worker + load wasm", state: "pending", timeoutMs: 30_000 },
  { label: "mount file via WORKERFS", state: "pending", timeoutMs: 10_000 },
  { label: "ffmpeg -i (probe)", state: "pending", timeoutMs: 30_000 },
];

export default function FFmpegTestPage() {
  const ffmpegRef = useRef<FFmpeg | null>(null);
  const coreURLRef = useRef<string | null>(null);
  const wasmURLRef = useRef<string | null>(null);
  const [steps, setSteps] = useState<Step[]>(INITIAL_STEPS);
  const [logs, setLogs] = useState<string[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [coi, setCoi] = useState<boolean | null>(null);
  const [tick, setTick] = useState(0); // heartbeat: forces re-render every 500ms while any step is running
  const [busy, setBusy] = useState(false);
  const [topLevelError, setTopLevelError] = useState<string | null>(null);

  function appendLog(line: string) {
    setLogs((prev) => [...prev, line]);
  }

  function patchStep(index: number, patch: Partial<Step>) {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  }

  function resetSteps() {
    setSteps(INITIAL_STEPS.map((s) => ({ ...s })));
    setLogs([]);
    setTopLevelError(null);
  }

  // Heartbeat: while any step is running, re-render every 500ms so the
  // elapsed counters tick visibly.  Proves the UI is alive even when
  // the underlying promise is silent.
  useEffect(() => {
    const anyRunning = steps.some((s) => s.state === "running");
    if (!anyRunning) return;
    const id = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(id);
  }, [steps]);

  // Diagnostic: is the page actually cross-origin-isolated?
  useEffect(() => {
    setCoi(window.crossOriginIsolated);
  }, []);

  // Capture global errors + unhandled rejections.  The FFmpeg class's
  // worker has no onerror handler, so worker boot failures (broken
  // imports, parse errors, MIME mismatches) silently hang load().
  // These listeners surface what otherwise goes nowhere.
  useEffect(() => {
    const onErr = (e: ErrorEvent) => {
      appendLog(`[window error] ${e.message} (${e.filename}:${e.lineno}:${e.colno})`);
    };
    const onRej = (e: PromiseRejectionEvent) => {
      appendLog(`[unhandled rejection] ${String(e.reason)}`);
    };
    window.addEventListener("error", onErr);
    window.addEventListener("unhandledrejection", onRej);
    return () => {
      window.removeEventListener("error", onErr);
      window.removeEventListener("unhandledrejection", onRej);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Independent worker probe: spawn /ffmpeg/worker.js as a module worker
  // and listen for ANY signal of life.  This bypasses the FFmpeg class
  // entirely so we can tell whether the worker file itself is bootable.
  async function probeWorker() {
    appendLog("[probe] spawning /ffmpeg/worker.js as module worker");
    return new Promise<string>((resolve) => {
      const w = new Worker("/ffmpeg/worker.js", { type: "module" });
      const finish = (msg: string) => {
        try { w.terminate(); } catch { /* ignore */ }
        appendLog(`[probe] result: ${msg}`);
        resolve(msg);
      };
      w.onerror = (e) => finish(`onerror: ${e.message || "(no message — likely import failure)"} @ ${e.filename}:${e.lineno}`);
      w.onmessageerror = (e) => finish(`onmessageerror: ${String(e)}`);
      w.onmessage = (e) => finish(`onmessage: ${JSON.stringify(e.data).slice(0, 200)}`);
      // Worker is initialized (top-level imports run) immediately on
      // construction.  If it boots clean and idles, we won't get any
      // event — that's the "alive" case.
      setTimeout(() => finish("alive (no error within 3s — worker boot succeeded)"), 3000);
    });
  }

  // Window-level dragover/drop: blocks the browser's default
  // navigate-to-file-URL behavior and routes drops to handleFile.
  useEffect(() => {
    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      setDragActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      e.preventDefault();
      if (!e.relatedTarget) setDragActive(false);
    };
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

  function abort() {
    try { ffmpegRef.current?.terminate(); } catch { /* ignore */ }
    ffmpegRef.current = null;
    coreURLRef.current = null;
    wasmURLRef.current = null;
    setBusy(false);
    setTopLevelError("aborted by user");
    setSteps((prev) =>
      prev.map((s) =>
        s.state === "running" ? { ...s, state: "error", detail: "aborted", endedAt: performance.now() } : s,
      ),
    );
  }

  // Run one step with timeout + state transitions.  All third-party
  // promises go through here.
  async function runStep<T>(index: number, op: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    patchStep(index, { state: "running", startedAt, endedAt: undefined, detail: undefined });
    try {
      const result = await withTimeout(op(), INITIAL_STEPS[index].timeoutMs, INITIAL_STEPS[index].label);
      patchStep(index, { state: "done", endedAt: performance.now() });
      return result;
    } catch (err) {
      patchStep(index, { state: "error", endedAt: performance.now(), detail: String(err) });
      throw err;
    }
  }

  async function handleFile(file: File) {
    if (busy) return;
    setBusy(true);
    resetSteps();
    appendLog(`[host] got file: ${file.name} (${(file.size / 1e6).toFixed(1)} MB)`);
    try {
      // Steps 0-2 are one-time wasm boot.  Skip if already loaded.
      if (!ffmpegRef.current) {
        // Must be a fully-qualified URL with origin.  The FFmpeg class
        // does `new URL(classWorkerURL, import.meta.url)` and in Next dev
        // import.meta.url for the bundled module is `file:///...`, so a
        // path-only string like `/ffmpeg/worker.js` resolves to file://
        // and the browser blocks it as cross-protocol.
        const baseURL = `${window.location.origin}/ffmpeg`;
        coreURLRef.current = await runStep(0, () =>
          toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"));
        wasmURLRef.current = await runStep(1, () =>
          toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"));
        const ff = new FFmpeg();
        ff.on("log", ({ message }) => appendLog(message));
        await runStep(2, () => ff.load({
          coreURL: coreURLRef.current!,
          wasmURL: wasmURLRef.current!,
          // Real URL not blob — worker is type:"module" with relative imports.
          classWorkerURL: `${baseURL}/worker.js`,
        }));
        ffmpegRef.current = ff;
      } else {
        // Mark boot steps as "done (cached)" for clarity.
        for (const i of [0, 1, 2]) patchStep(i, { state: "done", detail: "(cached from prior run)" });
      }

      const ff = ffmpegRef.current!;
      const mountPoint = "/mount";
      await runStep(3, async () => {
        try { await ff.unmount(mountPoint); } catch { /* first run */ }
        try { await ff.deleteDir(mountPoint); } catch { /* first run */ }
        await ff.createDir(mountPoint);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await ff.mount(WORKERFS as any, { files: [file] }, mountPoint);
      });

      await runStep(4, async () => {
        // `-i` with no output prints metadata to stderr then exits non-zero.
        await ff.exec(["-hide_banner", "-i", `${mountPoint}/${file.name}`]);
        await ff.unmount(mountPoint);
      });

      appendLog("[host] all steps complete");
    } catch (err) {
      setTopLevelError(String(err));
      appendLog(`[host] FAILED: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  // Render helpers --------------------------------------------------

  void tick; // referenced so the heartbeat re-render isn't optimized away

  function elapsed(s: Step): string {
    if (s.state === "pending") return "";
    const start = s.startedAt ?? 0;
    const end = s.endedAt ?? performance.now();
    const dt = ((end - start) / 1000).toFixed(1);
    if (s.state === "running") {
      const budget = (s.timeoutMs / 1000).toFixed(0);
      return ` (${dt}s elapsed, ${budget}s timeout)`;
    }
    return ` (${dt}s)`;
  }

  function stepIcon(s: Step): string {
    return { pending: "·", running: "▶", done: "✓", error: "✗" }[s.state];
  }
  function stepColor(s: Step): string {
    return {
      pending: "text-zinc-500",
      running: "text-amber-300",
      done: "text-emerald-400",
      error: "text-red-400",
    }[s.state];
  }

  return (
    <main className="min-h-screen p-8 font-mono text-sm bg-zinc-900 text-zinc-100">
      <h1 className="text-xl mb-2">ffmpeg.wasm + WORKERFS smoke test (4c-1)</h1>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/50 text-xs">
        <div className="font-bold mb-1 text-zinc-300">What success looks like:</div>
        <ul className="list-disc list-inside text-zinc-400 space-y-1">
          <li>Cross-origin isolated below should be <span className="text-emerald-400">true</span>.</li>
          <li>All 5 steps reach <span className="text-emerald-400">✓ done</span>.  Each step has its own timeout — if any step exceeds its budget you&apos;ll see a labeled <span className="text-red-400">✗ timeout</span> error, not a silent hang.</li>
          <li>Black log box fills with ~15–30 lines of ffmpeg stderr (Input #0, Duration:, Stream #0:N).</li>
          <li>If a step gets stuck or takes longer than expected, click <b>Abort</b>.</li>
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
          onClick={() => void probeWorker()}
          disabled={busy}
          className="px-3 py-1 border border-sky-500 text-sky-300 rounded disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Probe worker only
        </button>
      </div>

      <div className="mb-4 p-3 border border-zinc-700 rounded bg-zinc-800/30">
        <div className="font-bold mb-2 text-zinc-300 text-xs">pipeline:</div>
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={i} className={"text-xs " + stepColor(s)}>
              <span className="inline-block w-4">{stepIcon(s)}</span>
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

      <div className="mb-1 text-xs text-zinc-500">
        ffmpeg stderr ({logs.length} lines):
      </div>
      <pre className="bg-black p-3 max-h-[60vh] overflow-auto text-xs whitespace-pre-wrap">
        {logs.join("\n") || "(no logs yet — drop a file)"}
      </pre>
    </main>
  );
}
