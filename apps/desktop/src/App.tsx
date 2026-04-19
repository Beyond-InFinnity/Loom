import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  API_BASE,
  FileSlot,
  HealthInfo,
  ScanResponse,
  TrackInfo,
  probeHealth,
  registerFileByPath,
  scanVideo,
} from "./api";
import "./App.css";

type SlotKey = "video" | "target" | "native";

type SlotConfig = {
  key: SlotKey;
  label: string;
  hint: string;
  filters: { name: string; extensions: string[] }[];
};

const SLOTS: SlotConfig[] = [
  {
    key: "video",
    label: "Video file",
    hint: "MKV, MP4, or any container ffmpeg accepts. Output is always .mkv.",
    filters: [
      {
        name: "Video",
        extensions: ["mkv", "mp4", "mov", "avi", "webm", "ts", "m4v"],
      },
    ],
  },
  {
    key: "target",
    label: "Top subtitles (foreign / media language)",
    hint: "Optional — leave blank to extract from the video at scan time.",
    filters: [
      { name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt"] },
    ],
  },
  {
    key: "native",
    label: "Bottom subtitles (your native language)",
    hint: "Optional — leave blank to extract from the video at scan time.",
    filters: [
      { name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt"] },
    ],
  },
];

type Slots = Partial<Record<SlotKey, FileSlot>>;
type SlotErrors = Partial<Record<SlotKey, string>>;
type SidecarState =
  | { kind: "starting" }
  | { kind: "ok"; info: HealthInfo }
  | { kind: "error"; message: string };
type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "ok"; data: ScanResponse }
  | { kind: "error"; message: string };
type TrackRole = "none" | "top" | "bottom";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatDuration(seconds: number): string {
  if (!seconds || !isFinite(seconds)) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m.toString().padStart(2, "0")}m`;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function App() {
  const [sidecar, setSidecar] = useState<SidecarState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [slots, setSlots] = useState<Slots>({});
  const [errors, setErrors] = useState<SlotErrors>({});
  const [busy, setBusy] = useState<SlotKey | null>(null);
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const info = await probeHealth();
        if (!cancelled) setSidecar({ kind: "ok", info });
      } catch (err) {
        if (!cancelled) {
          setSidecar({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    if (sidecar.kind !== "error") return;
    const t = window.setTimeout(() => setAttempt((n) => n + 1), 1000);
    return () => window.clearTimeout(t);
  }, [sidecar]);

  // Reset scan state whenever the video slot changes (cleared, replaced).
  useEffect(() => {
    setScan({ kind: "idle" });
  }, [slots.video?.id]);

  async function pickFile(slot: SlotConfig) {
    setErrors((e) => ({ ...e, [slot.key]: undefined }));
    setBusy(slot.key);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        filters: slot.filters,
      });
      if (typeof picked !== "string") {
        setBusy(null);
        return;
      }
      const slotData = await registerFileByPath(picked);
      setSlots((s) => ({ ...s, [slot.key]: slotData }));
    } catch (err) {
      setErrors((e) => ({
        ...e,
        [slot.key]: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      setBusy(null);
    }
  }

  function clearSlot(key: SlotKey) {
    setSlots((s) => {
      const next = { ...s };
      delete next[key];
      return next;
    });
    setErrors((e) => ({ ...e, [key]: undefined }));
  }

  async function runScan() {
    if (!slots.video) return;
    setScan({ kind: "scanning" });
    try {
      const data = await scanVideo(slots.video.id);
      setScan({ kind: "ok", data });
    } catch (err) {
      setScan({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function trackRole(track: TrackInfo): TrackRole {
    if (!track.file_id) return "none";
    if (slots.target?.id === track.file_id) return "top";
    if (slots.native?.id === track.file_id) return "bottom";
    return "none";
  }

  function assignTrack(track: TrackInfo, role: TrackRole) {
    if (!track.file_id) return;
    const current = trackRole(track);
    setSlots((s) => {
      const next = { ...s };
      if (current === "top" && role !== "top") delete next.target;
      if (current === "bottom" && role !== "bottom") delete next.native;
      if (role === "top") {
        next.target = { id: track.file_id!, name: track.label };
      } else if (role === "bottom") {
        next.native = { id: track.file_id!, name: track.label };
      }
      return next;
    });
    if (role !== "none") {
      const slotKey: SlotKey = role === "top" ? "target" : "native";
      setErrors((e) => ({ ...e, [slotKey]: undefined }));
    }
  }

  const disabled = sidecar.kind !== "ok";
  const scanBusy = scan.kind === "scanning";
  const canScan = !!slots.video && !disabled && !scanBusy;

  return (
    <main className="container" style={{ maxWidth: 760, margin: "0 auto", padding: "32px 24px" }}>
      <h1 style={{ marginBottom: 4 }}>Loom</h1>
      <p style={{ opacity: 0.6, fontSize: "0.9em", marginTop: 0 }}>
        Step 3b · file picker + scan
      </p>

      <section style={{ marginTop: 24 }}>
        {SLOTS.map((slot) => {
          const value = slots[slot.key];
          const err = errors[slot.key];
          return (
            <div
              key={slot.key}
              style={{
                marginBottom: 16,
                padding: 16,
                border: "1px solid #333",
                borderRadius: 8,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <strong>{slot.label}</strong>
                {value && (
                  <button
                    onClick={() => clearSlot(slot.key)}
                    style={{ fontSize: "0.85em", padding: "2px 8px" }}
                  >
                    clear
                  </button>
                )}
              </div>
              <div style={{ opacity: 0.6, fontSize: "0.85em", margin: "4px 0 12px" }}>
                {slot.hint}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button
                  onClick={() => pickFile(slot)}
                  disabled={disabled || busy === slot.key}
                  style={{ padding: "6px 14px" }}
                >
                  {busy === slot.key ? "registering…" : value ? "Choose another…" : "Choose file…"}
                </button>
                {slot.key === "video" && (
                  <button
                    onClick={runScan}
                    disabled={!canScan}
                    style={{ padding: "6px 14px" }}
                    title={!slots.video ? "Pick a video first" : ""}
                  >
                    {scanBusy ? "scanning…" : "Scan video"}
                  </button>
                )}
              </div>
              {value && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: "monospace",
                    fontSize: "0.85em",
                    opacity: 0.85,
                  }}
                >
                  <div>
                    {value.name}
                    {value.size !== undefined && (
                      <span style={{ opacity: 0.6 }}> · {formatBytes(value.size)}</span>
                    )}
                  </div>
                  <div style={{ opacity: 0.5, fontSize: "0.85em", wordBreak: "break-all" }}>
                    id={value.id}
                  </div>
                  {value.path && (
                    <div style={{ opacity: 0.5, fontSize: "0.85em", wordBreak: "break-all" }}>
                      {value.path}
                    </div>
                  )}
                </div>
              )}
              {err && (
                <div style={{ marginTop: 10, color: "#f87171", fontSize: "0.85em" }}>
                  {err}
                </div>
              )}
            </div>
          );
        })}
      </section>

      {scan.kind !== "idle" && (
        <section
          style={{
            marginTop: 8,
            padding: 16,
            border: "1px solid #333",
            borderRadius: 8,
          }}
        >
          <strong>Video tracks</strong>
          {scan.kind === "scanning" && (
            <div style={{ marginTop: 8, opacity: 0.7, fontSize: "0.9em" }}>
              probing container…
            </div>
          )}
          {scan.kind === "error" && (
            <div style={{ marginTop: 8, color: "#f87171", fontSize: "0.85em" }}>
              {scan.message}
            </div>
          )}
          {scan.kind === "ok" && (
            <>
              <div
                style={{
                  marginTop: 8,
                  fontFamily: "monospace",
                  fontSize: "0.85em",
                  opacity: 0.85,
                }}
              >
                {scan.data.metadata.title || "(untitled)"}
                {scan.data.metadata.year && ` (${scan.data.metadata.year})`}
                {" · "}
                {formatDuration(scan.data.metadata.duration_seconds)}
                {" · "}
                {scan.data.metadata.width}×{scan.data.metadata.height}
              </div>
              <div style={{ marginTop: 12 }}>
                {scan.data.tracks.length === 0 && (
                  <div style={{ opacity: 0.6, fontSize: "0.9em" }}>
                    No subtitle tracks found. Upload subtitles directly above.
                  </div>
                )}
                {scan.data.tracks.map((t) => (
                  <div
                    key={t.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                      padding: "6px 0",
                      borderBottom: "1px solid #222",
                      fontSize: "0.9em",
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          opacity: t.selectable ? 1 : 0.5,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {t.label}
                      </div>
                      {!t.selectable && t.codec && (
                        <div style={{ opacity: 0.5, fontSize: "0.8em" }}>
                          {t.codec} · image-based, needs OCR
                        </div>
                      )}
                    </div>
                    {t.selectable ? (
                      <select
                        value={trackRole(t)}
                        onChange={(e) =>
                          assignTrack(t, e.target.value as TrackRole)
                        }
                        style={{ padding: "2px 6px", fontSize: "0.85em" }}
                      >
                        <option value="none">—</option>
                        <option value="top">Top (foreign)</option>
                        <option value="bottom">Bottom (native)</option>
                      </select>
                    ) : (
                      <span style={{ opacity: 0.4, fontSize: "0.8em" }}>
                        unavailable
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      <footer
        style={{
          marginTop: 24,
          paddingTop: 12,
          borderTop: "1px solid #333",
          fontFamily: "monospace",
          fontSize: "0.8em",
          opacity: 0.7,
        }}
      >
        {sidecar.kind === "starting" && <span>connecting to sidecar…</span>}
        {sidecar.kind === "ok" && (
          <span style={{ color: "#4ade80" }}>
            ● {sidecar.info.name} v{sidecar.info.version} · {API_BASE}
          </span>
        )}
        {sidecar.kind === "error" && (
          <span style={{ color: "#f87171" }}>
            ● sidecar unreachable · {sidecar.message} · retrying ({attempt + 1})
          </span>
        )}
      </footer>
    </main>
  );
}

export default App;
