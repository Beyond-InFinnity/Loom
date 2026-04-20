import { useEffect, useRef, useState } from "react";
import {
  formatTs,
  parseTimeInput,
  PreviewMode,
  PreviewResponse,
  renderPreview,
  Resolution,
  TimingOffsets,
} from "./api";
import { StyleConfig } from "./styles";

type Props = {
  nativeFileId: string;
  targetFileId: string;
  targetLang: string;
  styles: StyleConfig;
  offsets?: TimingOffsets;
  duration?: number;
  sourceResolution?: Resolution;
  videoFileId?: string;
};

type PreviewState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; data: PreviewResponse }
  | { kind: "error"; message: string };

const DEBOUNCE_MS = 200;
const DEFAULT_DURATION = 3600;

export function PreviewSection({
  nativeFileId, targetFileId, targetLang, styles, offsets, duration, sourceResolution, videoFileId,
}: Props) {
  const max = Math.max(1, Math.floor(duration ?? DEFAULT_DURATION));
  const [timestamp, setTimestamp] = useState<number>(() => Math.min(300, max));
  const [tsText, setTsText] = useState<string>(() => formatTs(Math.min(300, max)));
  const [mode, setMode] = useState<PreviewMode>("ass");
  const [preview, setPreview] = useState<PreviewState>({ kind: "idle" });
  const seq = useRef(0);

  // Clamp timestamp + re-sync text when duration changes (e.g. new scan).
  useEffect(() => {
    setTimestamp((t) => {
      const clamped = Math.min(Math.max(0, t), max);
      if (clamped !== t) setTsText(formatTs(clamped));
      return clamped;
    });
  }, [max]);

  useEffect(() => {
    const myId = ++seq.current;
    setPreview((p) => (p.kind === "idle" ? { kind: "loading" } : p));
    const timer = window.setTimeout(async () => {
      try {
        const data = await renderPreview({
          native_file_id: nativeFileId,
          target_file_id: targetFileId,
          target_lang_code: targetLang,
          timestamp_seconds: timestamp,
          styles,
          offsets,
          preview_mode: mode,
          source_resolution: sourceResolution,
          video_file_id: videoFileId,
        });
        if (seq.current !== myId) return;
        setPreview({ kind: "ok", data });
      } catch (err) {
        if (seq.current !== myId) return;
        setPreview({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [nativeFileId, targetFileId, targetLang, timestamp, mode, styles, offsets, sourceResolution, videoFileId]);

  function onSliderChange(v: number) {
    setTimestamp(v);
    setTsText(formatTs(v));
  }

  function onTextCommit() {
    const parsed = parseTimeInput(tsText, max);
    if (parsed === null) {
      setTsText(formatTs(timestamp));
      return;
    }
    setTimestamp(parsed);
    setTsText(formatTs(parsed));
  }

  return (
    <section
      style={{
        marginTop: 16,
        padding: 16,
        border: "1px solid #333",
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 12,
        }}
      >
        <strong>Preview</strong>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: "0.85em" }}>
          Mode
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as PreviewMode)}
            style={{ padding: "2px 6px", fontSize: "0.85em" }}
          >
            <option value="ass">.ass</option>
            <option value="pgs">PGS</option>
          </select>
        </label>
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={timestamp}
          onChange={(e) => onSliderChange(Number(e.target.value))}
          style={{ flex: 1 }}
          title={formatTs(timestamp)}
        />
        <input
          type="text"
          value={tsText}
          onChange={(e) => setTsText(e.target.value)}
          onBlur={onTextCommit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          style={{
            width: 120, padding: "3px 6px", fontSize: "0.85em",
            fontFamily: "monospace", textAlign: "center",
          }}
          title="e.g. 3 (minutes), 3:56, 1:22:33"
        />
      </div>

      <PreviewFrame state={preview} />

      {preview.kind === "ok" && (
        <TextFields data={preview.data} />
      )}
    </section>
  );
}

function PreviewFrame({ state }: { state: PreviewState }) {
  const frameStyle: React.CSSProperties = {
    width: "100%",
    height: 400,
    border: "1px solid #222",
    borderRadius: 4,
    background: "#000",
  };
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <div
        style={{
          ...frameStyle,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          opacity: 0.5,
          fontSize: "0.85em",
        }}
      >
        {state.kind === "loading" ? "rendering…" : "no preview yet"}
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div
        style={{
          ...frameStyle,
          color: "#f87171",
          padding: 12,
          fontSize: "0.85em",
          fontFamily: "monospace",
          overflow: "auto",
        }}
      >
        {state.message}
      </div>
    );
  }
  return (
    <iframe
      title="Subtitle preview"
      srcDoc={state.data.html}
      sandbox=""
      style={frameStyle}
    />
  );
}

function TextFields({ data }: { data: PreviewResponse }) {
  const rows: { label: string; value: string }[] = [
    { label: "Bottom (native)", value: data.native_text },
    { label: "Top (foreign)", value: data.target_text },
    { label: "Romanized", value: data.romanized_text },
  ];
  const hasAny = rows.some((r) => r.value);
  if (!hasAny) return null;
  return (
    <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r) => (
        <div
          key={r.label}
          style={{
            display: "grid",
            gridTemplateColumns: "120px 1fr",
            gap: 8,
            fontSize: "0.8em",
            fontFamily: "monospace",
            alignItems: "baseline",
          }}
        >
          <span style={{ opacity: 0.55 }}>{r.label}</span>
          <span style={{ opacity: r.value ? 0.9 : 0.3, wordBreak: "break-word" }}>
            {r.value || "—"}
          </span>
        </div>
      ))}
    </div>
  );
}
