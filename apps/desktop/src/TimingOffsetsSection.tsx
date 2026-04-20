import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlignResponse,
  alignSubtitles,
  FileSlot,
  registerFileByPath,
  ScanResponse,
  scanVideo,
  TimingOffsets,
  TrackInfo,
} from "./api";

const VIDEO_EXTS = new Set([
  "mkv", "mp4", "mov", "avi", "webm", "ts", "m4v",
]);
const SUB_EXTS = new Set(["srt", "ass", "ssa", "vtt"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

function isVideoPath(path: string): boolean {
  return VIDEO_EXTS.has(extOf(path));
}

type LayerKey = "top" | "bottom";

type Props = {
  offsets: TimingOffsets;
  setOffsets: React.Dispatch<React.SetStateAction<TimingOffsets>>;
  linked: boolean;
  setLinked: (b: boolean) => void;
  nativeFileId: string;
  targetFileId: string;
};

export function TimingOffsetsSection({
  offsets, setOffsets, linked, setLinked, nativeFileId, targetFileId,
}: Props) {
  function setOffsetWithLink(which: LayerKey, newMs: number) {
    setOffsets((prev) => {
      if (!linked) {
        return which === "bottom"
          ? { ...prev, bottom_ms: newMs }
          : { ...prev, top_ms: newMs };
      }
      const delta =
        newMs - (which === "bottom" ? prev.bottom_ms : prev.top_ms);
      return {
        bottom_ms: which === "bottom" ? newMs : prev.bottom_ms + delta,
        top_ms: which === "top" ? newMs : prev.top_ms + delta,
      };
    });
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
      <div style={{ marginBottom: 4 }}>
        <strong>Timing offsets</strong>
      </div>
      <div
        style={{
          opacity: 0.6,
          fontSize: "0.8em",
          marginBottom: 12,
          lineHeight: 1.4,
        }}
      >
        Shift a track's timing when it comes from a different release cut
        than the video. Positive values delay the track; negative values
        pull it earlier. Use Auto-align below if you don't know the value.
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <OffsetInput
          label="Bottom (native)"
          ms={offsets.bottom_ms}
          onChangeMs={(ms) => setOffsetWithLink("bottom", ms)}
        />
        <OffsetInput
          label="Top (foreign)"
          ms={offsets.top_ms}
          onChangeMs={(ms) => setOffsetWithLink("top", ms)}
        />
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            fontSize: "0.85em",
            marginLeft: 140,
          }}
          title="When linked, changing one offset shifts the other by the same amount."
        >
          <input
            type="checkbox"
            checked={linked}
            onChange={(e) => setLinked(e.target.checked)}
          />
          Link offsets
        </label>
      </div>

      <AutoAlignBlock
        nativeFileId={nativeFileId}
        targetFileId={targetFileId}
        onApply={(which, sec) =>
          setOffsetWithLink(which, Math.round(sec * 1000))
        }
      />
    </section>
  );
}

function OffsetInput({
  label, ms, onChangeMs,
}: {
  label: string;
  ms: number;
  onChangeMs: (ms: number) => void;
}) {
  const [text, setText] = useState<string>(() => (ms / 1000).toFixed(2));

  // Resync display when the external value changes (e.g. Apply from
  // auto-align, or link-propagated delta). Skip when the current text
  // already represents the incoming ms — avoids wiping a mid-edit '.'.
  useEffect(() => {
    const parsed = Number(text);
    const currentMs = Number.isNaN(parsed) ? NaN : Math.round(parsed * 1000);
    if (currentMs !== ms) setText((ms / 1000).toFixed(2));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 130, fontSize: "0.85em" }}>{label}</span>
      <input
        type="number"
        step={0.01}
        value={text}
        onChange={(e) => {
          const raw = e.target.value;
          setText(raw);
          const n = Number(raw);
          if (raw !== "" && !Number.isNaN(n)) {
            onChangeMs(Math.round(n * 1000));
          }
        }}
        onBlur={() => setText((ms / 1000).toFixed(2))}
        style={{ width: 90, padding: "2px 6px", fontSize: "0.85em" }}
      />
      <span style={{ fontSize: "0.85em", opacity: 0.6 }}>seconds</span>
    </div>
  );
}

type RefState =
  | { kind: "none" }
  | { kind: "registering" }
  | { kind: "video"; slot: FileSlot }
  | { kind: "video-scanning"; slot: FileSlot }
  | { kind: "video-scanned"; slot: FileSlot; scan: ScanResponse; trackIdx: number }
  | { kind: "subtitle"; slot: FileSlot }
  | { kind: "error"; message: string };

function AutoAlignBlock({
  nativeFileId, targetFileId, onApply,
}: {
  nativeFileId: string;
  targetFileId: string;
  onApply: (which: LayerKey, offsetSec: number) => void;
}) {
  const [open_, setOpen] = useState(false);
  const [ref, setRef] = useState<RefState>({ kind: "none" });
  const [compareTo, setCompareTo] = useState<LayerKey>("top");
  const [applyTo, setApplyTo] = useState<LayerKey>("top");
  const [computing, setComputing] = useState(false);
  const [result, setResult] = useState<AlignResponse | null>(null);
  const [computeError, setComputeError] = useState<string | null>(null);

  // Reset compute state whenever the reference or the target tracks change.
  useEffect(() => {
    setResult(null);
    setComputeError(null);
  }, [ref, nativeFileId, targetFileId, compareTo]);

  async function pickRef() {
    setResult(null);
    setComputeError(null);
    setRef({ kind: "registering" });
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: "Video or subtitles",
            extensions: [...VIDEO_EXTS, ...SUB_EXTS],
          },
        ],
      });
      if (typeof picked !== "string") {
        setRef({ kind: "none" });
        return;
      }
      const slot = await registerFileByPath(picked);
      if (isVideoPath(picked)) {
        setRef({ kind: "video", slot });
      } else if (SUB_EXTS.has(extOf(picked))) {
        setRef({ kind: "subtitle", slot });
      } else {
        setRef({
          kind: "error",
          message: `Unsupported file extension: .${extOf(picked)}`,
        });
      }
    } catch (err) {
      setRef({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function scanRef() {
    if (ref.kind !== "video") return;
    const slot = ref.slot;
    setRef({ kind: "video-scanning", slot });
    try {
      const scan = await scanVideo(slot.id);
      const firstSelectable = scan.tracks.findIndex(
        (t) => t.selectable && t.file_id,
      );
      setRef({
        kind: "video-scanned",
        slot,
        scan,
        trackIdx: firstSelectable === -1 ? 0 : firstSelectable,
      });
    } catch (err) {
      setRef({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function referenceFileId(): string | null {
    if (ref.kind === "subtitle") return ref.slot.id;
    if (ref.kind === "video-scanned") {
      const track = ref.scan.tracks[ref.trackIdx];
      return track?.file_id ?? null;
    }
    return null;
  }

  async function compute() {
    const refId = referenceFileId();
    if (!refId) return;
    const tgtId = compareTo === "top" ? targetFileId : nativeFileId;
    setComputing(true);
    setResult(null);
    setComputeError(null);
    try {
      const r = await alignSubtitles({
        reference_file_id: refId,
        target_file_id: tgtId,
      });
      setResult(r);
    } catch (err) {
      setComputeError(err instanceof Error ? err.message : String(err));
    } finally {
      setComputing(false);
    }
  }

  function apply() {
    if (!result || result.warning) return;
    onApply(applyTo, result.offset_seconds);
  }

  const canCompute =
    !computing &&
    referenceFileId() !== null &&
    !!nativeFileId &&
    !!targetFileId;

  const summary =
    ref.kind === "subtitle" || ref.kind === "video" || ref.kind === "video-scanning"
      ? ref.slot.name
      : ref.kind === "video-scanned"
      ? ref.slot.name
      : ref.kind === "registering"
      ? "registering…"
      : "";

  return (
    <div
      style={{
        marginTop: 14,
        border: "1px solid #2c2c2c",
        borderRadius: 6,
        background: "#1a1a1a",
      }}
    >
      <div
        onClick={() => setOpen((o) => !o)}
        style={{
          padding: "8px 12px",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <strong style={{ fontSize: "0.9em" }}>Auto-align from reference</strong>
        {summary && (
          <span
            style={{
              opacity: 0.5,
              fontSize: "0.8em",
              fontFamily: "monospace",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {summary}
          </span>
        )}
        <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: "0.8em" }}>
          {open_ ? "▾" : "▸"}
        </span>
      </div>
      {open_ && (
        <div
          style={{
            padding: "10px 14px 14px",
            borderTop: "1px solid #2c2c2c",
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <div
            style={{
              opacity: 0.6,
              fontSize: "0.8em",
              lineHeight: 1.45,
              paddingBottom: 2,
            }}
          >
            Pick a reference subtitle (or video) whose timing matches the
            track you want to fix. Compare it against the loaded track
            that's <em>already correctly timed</em>, then apply the offset
            to the mis-timed layer. Tip: you can also skip the reference
            step by comparing cross-language — e.g. a correctly-timed
            English track against a mis-timed Japanese track — as long as
            both cover the same content.
          </div>

          <Row
            label="Reference file"
            help="Any subtitle or video with the same release timing as your mis-aligned track."
          >
            <button
              onClick={pickRef}
              disabled={ref.kind === "registering"}
              style={{ padding: "4px 12px", fontSize: "0.85em" }}
            >
              {ref.kind === "registering" ? "registering…" : "Browse…"}
            </button>
            {summary && (
              <span
                style={{
                  fontSize: "0.8em",
                  fontFamily: "monospace",
                  opacity: 0.85,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                  flex: 1,
                }}
                title={summary}
              >
                {summary}
              </span>
            )}
          </Row>

          {ref.kind === "error" && (
            <div style={{ color: "#f87171", fontSize: "0.85em" }}>
              {ref.message}
            </div>
          )}

          {ref.kind === "video" && (
            <Row label="">
              <button
                onClick={scanRef}
                style={{ padding: "4px 12px", fontSize: "0.85em" }}
              >
                Scan reference video
              </button>
            </Row>
          )}

          {ref.kind === "video-scanning" && (
            <div style={{ fontSize: "0.85em", opacity: 0.7 }}>
              scanning reference video…
            </div>
          )}

          {ref.kind === "video-scanned" && (
            <Row
              label="Track"
              help="Pick the track from the reference that matches the language or content of your Compare-to loaded track."
            >
              <TrackSelect
                tracks={ref.scan.tracks}
                value={ref.trackIdx}
                onChange={(idx) =>
                  setRef({ ...ref, trackIdx: idx })
                }
              />
            </Row>
          )}

          <Row
            label="Compare to"
            help="The loaded track that's already correctly timed — usually the one extracted straight from the video."
          >
            <LayerPicker value={compareTo} onChange={setCompareTo} />
          </Row>

          <Row label="">
            <button
              onClick={compute}
              disabled={!canCompute}
              style={{ padding: "4px 12px", fontSize: "0.85em" }}
            >
              {computing ? "computing…" : "Compute offset"}
            </button>
          </Row>

          {computeError && (
            <div style={{ color: "#f87171", fontSize: "0.85em" }}>
              {computeError}
            </div>
          )}

          {result && <ResultRow result={result} />}

          {result && !result.warning && (
            <>
              <Row
                label="Apply to"
                help="The mis-timed layer — the one that came from the same release as your reference, not the one you compared against."
              >
                <LayerPicker value={applyTo} onChange={setApplyTo} />
              </Row>
              <Row label="">
                <button
                  onClick={apply}
                  style={{ padding: "4px 12px", fontSize: "0.85em" }}
                >
                  Apply
                </button>
              </Row>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  label, children, help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span
          style={{ width: 130, fontSize: "0.85em", opacity: 0.7 }}
          title={help}
        >
          {label}
        </span>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            flex: 1,
            minWidth: 0,
          }}
        >
          {children}
        </div>
      </div>
      {help && (
        <div
          style={{
            marginLeft: 140,
            fontSize: "0.75em",
            opacity: 0.5,
            lineHeight: 1.4,
          }}
        >
          {help}
        </div>
      )}
    </div>
  );
}

function LayerPicker({
  value, onChange,
}: { value: LayerKey; onChange: (v: LayerKey) => void }) {
  return (
    <div
      style={{
        display: "inline-flex",
        border: "1px solid #444",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      {([
        { id: "top", label: "Top (foreign)" },
        { id: "bottom", label: "Bottom (native)" },
      ] as { id: LayerKey; label: string }[]).map((o) => (
        <button
          key={o.id}
          onClick={() => onChange(o.id)}
          style={{
            padding: "3px 10px",
            fontSize: "0.85em",
            background: value === o.id ? "#444" : "transparent",
            color: value === o.id ? "#fff" : "#bbb",
            border: "none",
            cursor: "pointer",
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TrackSelect({
  tracks, value, onChange,
}: {
  tracks: TrackInfo[];
  value: number;
  onChange: (idx: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ padding: "3px 6px", fontSize: "0.85em", flex: 1, minWidth: 0 }}
    >
      {tracks.map((t, i) => (
        <option
          key={t.id}
          value={i}
          disabled={!t.selectable || !t.file_id}
        >
          {t.label}
          {!t.selectable && t.codec ? ` — ${t.codec} (unavailable)` : ""}
        </option>
      ))}
    </select>
  );
}

function ResultRow({ result }: { result: AlignResponse }) {
  if (result.warning) {
    return (
      <div
        style={{
          fontSize: "0.85em",
          color: "#fbbf24",
          padding: "6px 10px",
          background: "#2a2110",
          borderRadius: 4,
        }}
      >
        {result.warning}
      </div>
    );
  }
  const off = result.offset_seconds;
  const abs = Math.abs(off);
  const sign = off >= 0 ? "+" : "";
  let body: string;
  if (abs < 0.005) {
    body = "Detected offset: 0.00s — Tracks are already aligned.";
  } else if (off > 0) {
    body =
      `Detected offset: ${sign}${off.toFixed(2)}s — ` +
      `The reference source's subtitles start ${abs.toFixed(2)}s earlier ` +
      `than this video's. Tracks from the reference source need to be ` +
      `shifted ${abs.toFixed(2)}s later to align.`;
  } else {
    body =
      `Detected offset: ${off.toFixed(2)}s — ` +
      `The reference source's subtitles start ${abs.toFixed(2)}s later ` +
      `than this video's. Tracks from the reference source need to be ` +
      `shifted ${abs.toFixed(2)}s earlier to align.`;
  }
  return (
    <div
      style={{
        fontSize: "0.85em",
        padding: "6px 10px",
        background: "#162032",
        borderRadius: 4,
        lineHeight: 1.4,
      }}
    >
      {body}
    </div>
  );
}
