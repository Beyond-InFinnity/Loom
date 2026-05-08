"use client";

// 4e-3 — the user-facing UX shell.  Wraps the same FFmpegClient +
// LoomGenerator pipeline that /ffmpeg-test exercises, but stripped of
// diagnostic widgets and themed to match nerv-analytic.ai.
//
// State machine, top to bottom:
//   idle        →  no file yet, drop zone visible
//   probing     →  ffmpeg.wasm decoding container metadata
//   ready       →  metadata + track pickers + Generate button
//   generating  →  rasterize+encode loop running, progress visible
//   done        →  files already downloaded; show summary + reset

import { useEffect, useRef, useState } from "react";

import { loomApi } from "../../lib/api/client";
import { buildRomanizeMap, hasPhoneticLayer, romanizeFromMap } from "../../lib/api/romanize";
import { FFmpegClient } from "../../lib/ffmpeg/client";
import { LoomGenerator } from "../../lib/loom-generator";
import type { ProbeResult, TrackInfo } from "../../lib/ffmpeg/types";
import { stripAssOverrideTags } from "../../lib/subs/generate-ass";
import { SSAFile } from "../../lib/subs/ssa";
import { detectAssStyles, iterDialogueEvents } from "../../lib/subs/style-classify";
import { defaultStyleConfig } from "../../lib/subs/style-config";
import type { SupWriterStats } from "../../lib/raster/sup-writer";

type Status = "idle" | "probing" | "ready" | "generating" | "done" | "error";

interface GenerateResult {
  ass_kb: number;
  sup_kb: number;
  frames: number;
  stats: SupWriterStats;
  duration_s: number;
}

function downloadBytes(data: Uint8Array, filename: string) {
  const blob = new Blob([new Uint8Array(data)], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function GeneratorPanel() {
  const clientRef = useRef<FFmpegClient | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [nativeTrackId, setNativeTrackId] = useState<number | null>(null);
  const [targetTrackId, setTargetTrackId] = useState<number | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    return () => {
      clientRef.current?.terminate();
      clientRef.current = null;
    };
  }, []);

  // Page-level drag-and-drop so users can drop anywhere, not just on the
  // dropzone div — same pattern /ffmpeg-test uses.
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

  async function handleFile(picked: File) {
    if (status === "probing" || status === "generating") return;
    setError(null);
    setResult(null);
    setProbe(null);
    setNativeTrackId(null);
    setTargetTrackId(null);
    setFile(picked);
    setStatus("probing");
    setProgress(`inspecting ${picked.name}…`);

    try {
      if (!clientRef.current) {
        clientRef.current = await FFmpegClient.create();
      }
      const result = await clientRef.current.probe(picked);
      setProbe(result);
      // Pre-pick if there's only one selectable track per role candidate
      // — otherwise leave both null so the user makes the call.
      const selectable = result.subtitle_tracks.filter((t) => t.selectable);
      if (selectable.length === 1) {
        setNativeTrackId(selectable[0].id);
        setTargetTrackId(selectable[0].id);
      } else if (selectable.length === 2) {
        setNativeTrackId(selectable[0].id);
        setTargetTrackId(selectable[1].id);
      }
      setStatus("ready");
      setProgress("");
    } catch (err) {
      setError(`probe failed: ${String(err)}`);
      setStatus("error");
    }
  }

  async function handleGenerate() {
    if (!file || !clientRef.current || !probe) return;
    if (nativeTrackId == null || targetTrackId == null) return;
    setStatus("generating");
    setError(null);
    setResult(null);
    setProgress("extracting tracks…");

    try {
      const native = probe.subtitle_tracks.find((t) => t.id === nativeTrackId)!;
      const target = probe.subtitle_tracks.find((t) => t.id === targetTrackId)!;
      const nativeRes = await clientRef.current.extractTrack(file, native);
      const targetRes = await clientRef.current.extractTrack(file, target);

      const nativeSubs = SSAFile.fromString(new TextDecoder("utf-8").decode(nativeRes.data));
      const targetSubs = SSAFile.fromString(new TextDecoder("utf-8").decode(targetRes.data));

      // 4e-4 — pre-resolve the Romanized layer via /romanize.  When the
      // target track has a known lang_code AND the language has a phonetic
      // layer, batch-call once per unique event text and pass a sync
      // lookup into LoomGenerator.  Languages without phonetic support
      // (English, French, etc.) skip the round-trip entirely.
      let romanize: ((text: string) => string) | undefined = undefined;
      if (target.lang_code) {
        const api = loomApi();
        try {
          setProgress(`checking romanization for ${target.lang_code}…`);
          const supported = await hasPhoneticLayer(api, target.lang_code);
          if (supported) {
            // Match generateAssFile's exact lookup key: stripAssOverrideTags
            // without trim.  generateAssFile calls romanize(plain) where
            // `plain = stripAssOverrideTags(ev.text)` — keys must agree byte
            // for byte or the sync map lookup will miss.  Filter to dialogue
            // events using the same classifier so karaoke + sign events
            // don't get fanned out to /romanize (which would burn rate
            // limit + return junk romaji on already-localized text).
            const uniqueTexts = new Set<string>();
            const targetMapping = detectAssStyles(targetSubs);
            for (const ev of iterDialogueEvents(targetSubs, targetMapping)) {
              const plain = stripAssOverrideTags(ev.text);
              if (plain.trim()) uniqueTexts.add(plain);
            }
            setProgress(`romanizing ${uniqueTexts.size} unique events…`);
            const map = await buildRomanizeMap({
              client: api,
              lang_code: target.lang_code,
              texts: uniqueTexts,
              on_progress: (done, total) => {
                setProgress(`romanizing · ${done} / ${total}`);
              },
            });
            romanize = romanizeFromMap(map);
          }
        } catch (err) {
          // Fail-soft: log + skip the Romanized layer rather than blocking
          // the whole generate.  User still gets .ass + .sup with Bottom + Top.
          console.warn("romanize batch failed; skipping Romanized layer:", err);
        }
      }

      const gen = new LoomGenerator({
        native: nativeSubs,
        target: targetSubs,
        styles: defaultStyleConfig(),
        romanize,
      });

      const t0 = performance.now();
      setProgress("building .ass…");
      const assBytes = gen.generateAss();
      const baseName = file.name.replace(/\.[^.]+$/, "");
      downloadBytes(assBytes, `${baseName}.loom.ass`);

      setProgress("rasterizing + encoding .sup…");
      const sup = await gen.generateSup({
        on_progress: (done, total) => {
          setProgress(`rasterize + encode · ${done} / ${total} frames`);
        },
      });
      downloadBytes(sup.bytes, `${baseName}.loom.sup`);

      const dt = (performance.now() - t0) / 1000;
      setResult({
        ass_kb: assBytes.length / 1024,
        sup_kb: sup.bytes.length / 1024,
        frames: sup.frames,
        stats: sup.stats,
        duration_s: dt,
      });
      setStatus("done");
      setProgress("");
    } catch (err) {
      setError(`generate failed: ${String(err)}`);
      setStatus("error");
    }
  }

  function reset() {
    setFile(null);
    setProbe(null);
    setNativeTrackId(null);
    setTargetTrackId(null);
    setResult(null);
    setError(null);
    setProgress("");
    setStatus("idle");
  }

  const generating = status === "generating";
  const probing = status === "probing";
  const busy = generating || probing;

  return (
    <div className="space-y-8">
      {(status === "idle" || status === "probing" || status === "error") && (
        <DropZone
          dragActive={dragActive}
          busy={busy}
          onPick={(f) => void handleFile(f)}
          probing={probing}
          progress={progress}
        />
      )}

      {status === "error" && error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          {error}
          <button
            type="button"
            onClick={reset}
            className="ml-3 text-destructive-foreground underline hover:text-foreground"
          >
            try another file
          </button>
        </div>
      )}

      {(status === "ready" || status === "generating" || status === "done") && probe && file && (
        <div className="space-y-6">
          <div className="rounded-md border border-border bg-card/50 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-mono text-sm text-foreground">{file.name}</span>
              <span className="text-xs text-muted-foreground">
                {probe.metadata.width}×{probe.metadata.height} ·{" "}
                {Math.round(probe.metadata.duration_seconds)}s ·{" "}
                {probe.subtitle_tracks.length} subtitle{probe.subtitle_tracks.length === 1 ? "" : "s"}
              </span>
            </div>
          </div>

          <TrackPicker
            label="Native track"
            description="The language you read in.  Renders along the bottom of the frame."
            tracks={probe.subtitle_tracks}
            value={nativeTrackId}
            onChange={setNativeTrackId}
            disabled={busy}
            accentClass="border-accent/50 bg-accent/5 text-accent-foreground"
          />

          <TrackPicker
            label="Target track"
            description="The language of the video.  Loom adds romanization above this layer."
            tracks={probe.subtitle_tracks}
            value={targetTrackId}
            onChange={setTargetTrackId}
            disabled={busy}
            accentClass="border-primary/50 bg-primary/5 text-foreground"
          />

          {status !== "done" && (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={busy || nativeTrackId == null || targetTrackId == null}
                onClick={() => void handleGenerate()}
                className="inline-flex items-center gap-2 rounded-md border border-primary bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate ASS + SUP"}
              </button>
              <button
                type="button"
                onClick={reset}
                disabled={busy}
                className="text-xs text-muted-foreground underline hover:text-foreground disabled:opacity-40 disabled:no-underline"
              >
                start over
              </button>
              {progress && (
                <span className="font-mono text-xs text-accent">{progress}</span>
              )}
            </div>
          )}

          {result && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-5 text-sm">
              <p className="font-mono text-xs uppercase tracking-widest text-primary">
                ✓ done in {result.duration_s.toFixed(1)}s
              </p>
              <ul className="mt-3 space-y-1 text-foreground/80">
                <li>
                  .ass downloaded · {result.ass_kb.toFixed(1)} KB · 4-layer (Bottom + Top + Romanized stub + Annotation slot)
                </li>
                <li>
                  .sup downloaded · {result.sup_kb.toFixed(1)} KB · {result.frames} frames
                  {" · "}
                  ES {result.stats.epoch_start} · AP {result.stats.acquisition_point} · Normal {result.stats.normal} · Skip {result.stats.skipped} · Clear {result.stats.clears}
                </li>
              </ul>
              <button
                type="button"
                onClick={reset}
                className="mt-4 inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-muted-foreground"
              >
                Generate another
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DropZone(props: {
  dragActive: boolean;
  busy: boolean;
  probing: boolean;
  progress: string;
  onPick: (f: File) => void;
}) {
  return (
    <label
      className={
        "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed p-12 text-center transition-colors " +
        (props.dragActive
          ? "border-primary bg-primary/10"
          : props.busy
          ? "border-accent/50 bg-accent/5"
          : "border-border bg-card/40 hover:border-muted-foreground hover:bg-card/60")
      }
    >
      <input
        type="file"
        className="sr-only"
        disabled={props.busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onPick(f);
        }}
      />
      <span className="font-serif text-2xl font-light text-foreground">
        {props.probing ? "Reading file…" : "Drop a video here"}
      </span>
      <span className="text-xs text-muted-foreground">
        {props.probing
          ? props.progress
          : "MKV / MP4 / WebM · or click to browse"}
      </span>
    </label>
  );
}

function TrackPicker(props: {
  label: string;
  description: string;
  tracks: TrackInfo[];
  value: number | null;
  onChange: (id: number) => void;
  disabled: boolean;
  accentClass: string;
}) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <label className="font-mono text-xs uppercase tracking-widest text-accent">
          {props.label}
        </label>
        <span className="text-xs text-muted-foreground">{props.description}</span>
      </div>
      <div className="grid gap-2">
        {props.tracks.map((t) => {
          const selected = props.value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={props.disabled || !t.selectable}
              onClick={() => props.onChange(t.id)}
              className={
                "flex items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors " +
                (selected
                  ? props.accentClass
                  : "border-border bg-card/30 hover:border-muted-foreground hover:bg-card/50") +
                (!t.selectable || props.disabled ? " cursor-not-allowed opacity-50" : "")
              }
            >
              <span className="text-sm">
                <span className="font-mono text-xs text-muted-foreground">#{t.id}</span>{" "}
                {t.label}
                {!t.selectable && (
                  <span className="ml-2 text-xs text-muted-foreground">image-based · skip</span>
                )}
              </span>
              {selected && (
                <span className="font-mono text-xs uppercase tracking-widest">selected</span>
              )}
            </button>
          );
        })}
        {props.tracks.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No subtitle tracks found in this file.
          </p>
        )}
      </div>
    </div>
  );
}
