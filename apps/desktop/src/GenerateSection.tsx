import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import {
  downloadFileBytes,
  generateAss,
  generatePgs,
  getJob,
  JobStatus,
  Resolution,
  suggestFilename,
  TimingOffsets,
} from "./api";
import { StyleConfig } from "./styles";

type Format = "ass" | "pgs" | "both";

type AssState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok"; fileId: string }
  | { kind: "error"; message: string };

type PgsState =
  | { kind: "idle" }
  | { kind: "running"; progress: number; phase: string | null }
  | { kind: "ok"; fileId: string }
  | { kind: "error"; message: string };

type OutRes = "source" | "480" | "720" | "1080" | "1440" | "2160";

const OUT_RES_OPTIONS: { value: OutRes; label: string }[] = [
  { value: "source", label: "Match source" },
  { value: "480", label: "480p (854×480)" },
  { value: "720", label: "720p (1280×720)" },
  { value: "1080", label: "1080p (1920×1080)" },
  { value: "1440", label: "1440p (2560×1440)" },
  { value: "2160", label: "2160p (3840×2160)" },
];

// 16:9 widths for each preset. Matches loom_app's _PLAYRES_OPTIONS.
const OUT_RES_DIMS: Record<Exclude<OutRes, "source">, [number, number]> = {
  "480": [854, 480],
  "720": [1280, 720],
  "1080": [1920, 1080],
  "1440": [2560, 1440],
  "2160": [3840, 2160],
};

function outResToResolution(r: OutRes): Resolution | undefined {
  if (r === "source") return undefined;
  const [w, h] = OUT_RES_DIMS[r];
  return { width: w, height: h };
}

const POLL_INTERVAL_MS = 500;

type Props = {
  nativeFileId: string;
  targetFileId: string;
  targetLang: string;
  nativeLang?: string;
  videoFileId?: string;
  styles: StyleConfig;
  offsets?: TimingOffsets;
  sourceResolution?: Resolution;
  onResult?: (r: { assFileId?: string; pgsFileId?: string }) => void;
};

export function GenerateSection({
  nativeFileId, targetFileId, targetLang, nativeLang, videoFileId,
  styles, offsets, sourceResolution, onResult,
}: Props) {
  const [format, setFormat] = useState<Format>("ass");
  const [includeAnnotations, setIncludeAnnotations] = useState(false);
  const [outRes, setOutRes] = useState<OutRes>("source");
  const [assState, setAssState] = useState<AssState>({ kind: "idle" });
  const [pgsState, setPgsState] = useState<PgsState>({ kind: "idle" });
  const pollTimer = useRef<number | null>(null);

  // Kill any in-flight PGS poll if the section unmounts or the inputs change.
  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, []);

  useEffect(() => {
    // Reset state when source inputs change so we never save a stale result.
    setAssState({ kind: "idle" });
    setPgsState({ kind: "idle" });
  }, [nativeFileId, targetFileId, targetLang]);

  // Notify parent when file_ids materialise (for section 6 mux).
  useEffect(() => {
    if (!onResult) return;
    const assId = assState.kind === "ok" ? assState.fileId : undefined;
    const pgsId = pgsState.kind === "ok" ? pgsState.fileId : undefined;
    onResult({ assFileId: assId, pgsFileId: pgsId });
  }, [assState, pgsState, onResult]);

  function pollPgs(jobId: string) {
    (async () => {
      try {
        const status: JobStatus = await getJob(jobId);
        if (status.state === "completed" && status.result_file_id) {
          setPgsState({ kind: "ok", fileId: status.result_file_id });
          return;
        }
        if (status.state === "failed") {
          setPgsState({
            kind: "error",
            message: status.error ?? "PGS generation failed",
          });
          return;
        }
        setPgsState({
          kind: "running",
          progress: status.progress,
          phase: status.phase,
        });
        pollTimer.current = window.setTimeout(() => pollPgs(jobId), POLL_INTERVAL_MS);
      } catch (err) {
        setPgsState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  async function runAss() {
    setAssState({ kind: "running" });
    try {
      const res = await generateAss({
        native_file_id: nativeFileId,
        target_file_id: targetFileId,
        target_lang_code: targetLang,
        styles,
        offsets,
        source_resolution: sourceResolution,
        output_resolution: outResToResolution(outRes),
        include_annotations: includeAnnotations,
      });
      setAssState({ kind: "ok", fileId: res.file_id });
    } catch (err) {
      setAssState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runPgs() {
    setPgsState({ kind: "running", progress: 0, phase: "queued" });
    try {
      const accepted = await generatePgs({
        native_file_id: nativeFileId,
        target_file_id: targetFileId,
        target_lang_code: targetLang,
        styles,
        offsets,
        source_resolution: sourceResolution,
        output_resolution: outResToResolution(outRes),
      });
      pollPgs(accepted.id);
    } catch (err) {
      setPgsState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function runGenerate() {
    if (pollTimer.current !== null) {
      window.clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
    const tasks: Promise<void>[] = [];
    if (format === "ass" || format === "both") tasks.push(runAss());
    if (format === "pgs" || format === "both") tasks.push(runPgs());
    await Promise.all(tasks);
  }

  async function buildDefaultName(ext: string): Promise<string> {
    try {
      const r = await suggestFilename({
        ext,
        video_file_id: videoFileId,
        native_lang_code: nativeLang,
        target_lang_code: targetLang,
        phonetic_system: styles.annotation.phonetic_system ?? undefined,
        include_annotations:
          ext === "ass" ? includeAnnotations : styles.annotation.enabled,
        include_romanization: styles.romanized.enabled,
      });
      return r.filename;
    } catch {
      // Non-fatal: fall back to a plain name so the Save dialog still opens.
      return `subtitles.${ext}`;
    }
  }

  async function saveBytes(
    fileId: string, ext: string, extLabel: string,
  ): Promise<string | null> {
    const defaultName = await buildDefaultName(ext);
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: extLabel, extensions: [ext] }],
    });
    if (typeof path !== "string") return null;
    const bytes = await downloadFileBytes(fileId);
    await writeFile(path, bytes);
    return path;
  }

  const busy =
    assState.kind === "running" || pgsState.kind === "running";
  const canGenerate = !busy && nativeFileId && targetFileId && targetLang;

  return (
    <section
      style={{
        marginTop: 16,
        padding: 16,
        border: "1px solid #333",
        borderRadius: 8,
      }}
    >
      <div style={{ marginBottom: 12 }}>
        <strong>Generate</strong>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: "0.85em", opacity: 0.7, width: 90 }}>Format</span>
          <FormatRadio value={format} onChange={setFormat} />
        </div>

        {(format === "ass" || format === "both") && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: "0.85em", opacity: 0.7, width: 90 }}>.ass</span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em" }}>
              <input
                type="checkbox"
                checked={includeAnnotations}
                onChange={(e) => setIncludeAnnotations(e.target.checked)}
              />
              Include annotations (\pos) — PGS usually renders better
            </label>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: "0.85em", opacity: 0.7, width: 90 }}>Output res</span>
          <select
            value={outRes}
            onChange={(e) => setOutRes(e.target.value as OutRes)}
            style={{ padding: "3px 6px", fontSize: "0.85em" }}
          >
            {OUT_RES_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <div>
          <button
            onClick={runGenerate}
            disabled={!canGenerate}
            style={{ padding: "6px 14px" }}
          >
            {busy ? "generating…" : "Generate"}
          </button>
        </div>
      </div>

      {(format === "ass" || format === "both") && (
        <AssRow
          state={assState}
          onSave={(id) => saveBytes(id, "ass", "ASS subtitles")}
        />
      )}
      {(format === "pgs" || format === "both") && (
        <PgsRow
          state={pgsState}
          onSave={(id) => saveBytes(id, "sup", "PGS subtitles")}
        />
      )}
    </section>
  );
}

function FormatRadio({
  value, onChange,
}: { value: Format; onChange: (v: Format) => void }) {
  const opts: { id: Format; label: string }[] = [
    { id: "ass", label: ".ass" },
    { id: "pgs", label: "PGS (.sup)" },
    { id: "both", label: "Both" },
  ];
  return (
    <div style={{ display: "inline-flex", border: "1px solid #444", borderRadius: 6, overflow: "hidden" }}>
      {opts.map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: "4px 12px",
            fontSize: "0.85em",
            background: value === o.id ? "#444" : "transparent",
            color: value === o.id ? "#fff" : "#bbb",
            border: "none",
            borderRadius: 0,
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function AssRow({
  state, onSave,
}: { state: AssState; onSave: (fileId: string) => Promise<string | null> }) {
  return (
    <ResultRow
      label=".ass"
      busyText="generating .ass…"
      state={state}
      onSave={onSave}
      progressNode={null}
    />
  );
}

function PgsRow({
  state, onSave,
}: { state: PgsState; onSave: (fileId: string) => Promise<string | null> }) {
  const progressNode =
    state.kind === "running" ? (
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
        <ProgressBar fraction={state.progress} />
        <span style={{ fontSize: "0.8em", opacity: 0.65, fontFamily: "monospace" }}>
          {Math.round(state.progress * 100)}%
          {state.phase ? ` · ${state.phase}` : ""}
        </span>
      </div>
    ) : null;
  return (
    <ResultRow
      label="PGS"
      busyText="rasterizing PGS…"
      state={state}
      onSave={onSave}
      progressNode={progressNode}
    />
  );
}

function ResultRow({
  label, busyText, state, onSave, progressNode,
}: {
  label: string;
  busyText: string;
  state: AssState | PgsState;
  onSave: (fileId: string) => Promise<string | null>;
  progressNode: React.ReactNode;
}) {
  const [savedTo, setSavedTo] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSavedTo(null);
    setSaveError(null);
  }, [state.kind, state.kind === "ok" ? state.fileId : ""]);

  async function onClickSave() {
    if (state.kind !== "ok") return;
    setSaving(true);
    setSaveError(null);
    try {
      const path = await onSave(state.fileId);
      if (path) setSavedTo(path);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (state.kind === "idle") return null;

  return (
    <div
      style={{
        marginTop: 12,
        paddingTop: 10,
        borderTop: "1px solid #222",
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: "0.85em", opacity: 0.65, width: 40 }}>{label}</span>
      {state.kind === "running" && (
        progressNode ?? (
          <span style={{ fontSize: "0.85em", opacity: 0.7 }}>{busyText}</span>
        )
      )}
      {state.kind === "error" && (
        <span style={{ fontSize: "0.85em", color: "#f87171", fontFamily: "monospace", wordBreak: "break-word" }}>
          {state.message}
        </span>
      )}
      {state.kind === "ok" && (
        <>
          <button
            onClick={onClickSave}
            disabled={saving}
            style={{ padding: "4px 12px", fontSize: "0.85em" }}
          >
            {saving ? "saving…" : `Save ${label}…`}
          </button>
          {savedTo && (
            <span style={{ fontSize: "0.8em", color: "#4ade80", fontFamily: "monospace", wordBreak: "break-all" }}>
              → {savedTo}
            </span>
          )}
          {saveError && (
            <span style={{ fontSize: "0.8em", color: "#f87171", fontFamily: "monospace" }}>
              {saveError}
            </span>
          )}
        </>
      )}
    </div>
  );
}

function ProgressBar({ fraction }: { fraction: number }) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div
      style={{
        flex: 1,
        minWidth: 120,
        height: 6,
        background: "#222",
        borderRadius: 3,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: "#4ade80",
          transition: "width 200ms ease",
        }}
      />
    </div>
  );
}
