import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  API_BASE,
  detectSubtitleLanguage,
  fetchLanguageConfig,
  FileSlot,
  HealthInfo,
  ScanResponse,
  TimingOffsets,
  TrackInfo,
  probeHealth,
  registerFileByPath,
  scanVideo,
} from "./api";
import {
  defaultStyleConfig,
  FACTORY_DEFAULT_FONTS,
  phoneticOptions,
  StyleConfig,
} from "./styles";
import { StyleSection } from "./StyleSection";
import { TimingOffsetsSection } from "./TimingOffsetsSection";
import { PreviewSection } from "./PreviewSection";
import { GenerateSection } from "./GenerateSection";
import { MuxSection } from "./MuxSection";
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

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { SettingsPanel } from "./settings/SettingsPanel";
import { PlayerRemote } from "./settings/PlayerRemote";

// Open (or focus) the single-window Loom Player — a separate transparent
// window whose webview is the caption/transport UI, with libmpv rendering
// the video behind it (MOBILE_ROADMAP.md §5a).  The module-level guard makes
// concurrent calls (React StrictMode's double-invoke) create ONE window, not
// two racing ones.
let openingPlayer = false;
async function openPlayer(): Promise<void> {
  if (openingPlayer) return; // set BEFORE the first await → dedupes the race
  openingPlayer = true;
  try {
    const existing = await WebviewWindow.getByLabel("loom-player");
    if (existing) {
      await existing.setFocus();
      return;
    }
    const w = new WebviewWindow("loom-player", {
      url: "player.html",
      title: "Loom Player",
      width: 1280,
      height: 720,
      transparent: true,
    });
    w.once("tauri://error", (e) => console.error("[Loom] player window:", e));
  } finally {
    openingPlayer = false;
  }
}

function App() {
  const [showPlayerSettings, setShowPlayerSettings] = useState(false);
  const [sidecar, setSidecar] = useState<SidecarState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [slots, setSlots] = useState<Slots>({});
  const [errors, setErrors] = useState<SlotErrors>({});
  const [busy, setBusy] = useState<SlotKey | null>(null);
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [styles, setStyles] = useState<StyleConfig>(() => defaultStyleConfig());
  const [timingOffsets, setTimingOffsets] = useState<TimingOffsets>({
    bottom_ms: 0,
    top_ms: 0,
  });
  const [offsetsLinked, setOffsetsLinked] = useState(false);
  const [assFileId, setAssFileId] = useState<string | undefined>(undefined);
  const [pgsFileId, setPgsFileId] = useState<string | undefined>(undefined);

  const handleGenerateResult = useCallback(
    (r: { assFileId?: string; pgsFileId?: string }) => {
      setAssFileId(r.assFileId);
      setPgsFileId(r.pgsFileId);
    },
    [],
  );

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

  // Apply language-aware defaults whenever the target slot's language
  // changes. Ports Streamlit's annotation.enabled guard (loom_app.py:852)
  // and initial font selection (:762) — but only touches fields that still
  // equal a factory default, so user customizations survive track swaps.
  const appliedLangRef = useRef<string | null>(null);
  useEffect(() => {
    const lang = slots.target?.lang_code ?? "";
    if (!lang) {
      appliedLangRef.current = null;
      return;
    }
    if (appliedLangRef.current === lang) return;
    let cancelled = false;
    (async () => {
      try {
        const meta = await fetchLanguageConfig(lang);
        if (cancelled) return;
        appliedLangRef.current = lang;
        setStyles((s) => {
          const next = structuredClone(s);
          // annotation.enabled: always re-derive on lang change (matches
          // Streamlit's guard — off for Thai, on for CJK/Cyrillic by default).
          next.annotation.enabled = meta.annotation_default_enabled;
          // Top + Annotation fontnames: only swap if the user hasn't picked
          // a non-factory font manually.
          if (FACTORY_DEFAULT_FONTS.has(next.top.fontname)) {
            next.top.fontname = meta.default_font;
          }
          if (FACTORY_DEFAULT_FONTS.has(next.annotation.fontname)) {
            next.annotation.fontname = meta.default_font;
          }
          // annotation.phonetic_system: default to the first option for
          // the language (zh-Hant → zhuyin, zh-Hans → pinyin, yue →
          // jyutping, th → paiboon). Keep the user's pick if it's still
          // a valid option for the new language, otherwise reset.
          const opts = phoneticOptions(lang);
          const current = next.annotation.phonetic_system ?? null;
          const stillValid = opts.some((o) => o.value === current);
          if (!stillValid) {
            next.annotation.phonetic_system = opts.length ? opts[0].value : null;
          }
          return next;
        });
      } catch {
        // Non-fatal: leave styles as-is if the lookup fails (e.g. sidecar
        // restarting). Don't log — noisy on transient network blips.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slots.target?.lang_code]);

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
      // Subtitle slots (target/native): run language detection so the
      // downstream pipeline gets a real target_lang_code. Video slots
      // skip this — their language comes from per-track metadata via scan.
      if (slot.key !== "video") {
        try {
          const det = await detectSubtitleLanguage(slotData.id);
          if (det.code) {
            setSlots((s) => {
              const existing = s[slot.key];
              if (!existing || existing.id !== slotData.id) return s;
              return {
                ...s,
                [slot.key]: { ...existing, lang_code: det.code! },
              };
            });
          }
        } catch {
          // Non-fatal: the pipeline will run without per-lang wiring, but
          // the user still gets Bottom/Top text rendering.
        }
      }
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
        next.target = {
          id: track.file_id!,
          name: track.label,
          lang_code: track.lang_code ?? undefined,
        };
      } else if (role === "bottom") {
        next.native = {
          id: track.file_id!,
          name: track.label,
          lang_code: track.lang_code ?? undefined,
        };
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
      <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
        <h1 style={{ marginBottom: 4 }}>Loom</h1>
        <button onClick={() => void openPlayer()} style={{ fontSize: "0.85em" }}>
          ▶ Player
        </button>
        <button
          onClick={() => setShowPlayerSettings((v) => !v)}
          style={{ fontSize: "0.85em" }}
        >
          {showPlayerSettings ? "Hide settings" : "Player settings"}
        </button>
      </div>
      <div style={{ marginTop: 12, marginBottom: 8 }}>
        <PlayerRemote />
      </div>
      {showPlayerSettings && (
        <div style={{ marginTop: 8, marginBottom: 8 }}>
          <SettingsPanel />
        </div>
      )}
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

      <StyleSection
        styles={styles}
        setStyles={setStyles}
        targetLang={slots.target?.lang_code ?? ""}
      />

      {slots.native && slots.target && (
        <TimingOffsetsSection
          offsets={timingOffsets}
          setOffsets={setTimingOffsets}
          linked={offsetsLinked}
          setLinked={setOffsetsLinked}
          nativeFileId={slots.native.id}
          targetFileId={slots.target.id}
        />
      )}

      {slots.native && slots.target && (
        <PreviewSection
          nativeFileId={slots.native.id}
          targetFileId={slots.target.id}
          targetLang={slots.target.lang_code ?? ""}
          styles={styles}
          offsets={timingOffsets}
          videoFileId={slots.video?.id}
          duration={scan.kind === "ok" ? scan.data.metadata.duration_seconds : undefined}
          sourceResolution={
            scan.kind === "ok"
              ? { width: scan.data.metadata.width, height: scan.data.metadata.height }
              : undefined
          }
        />
      )}

      {slots.native && slots.target && (
        <GenerateSection
          nativeFileId={slots.native.id}
          targetFileId={slots.target.id}
          targetLang={slots.target.lang_code ?? ""}
          nativeLang={slots.native.lang_code}
          videoFileId={slots.video?.id}
          styles={styles}
          offsets={timingOffsets}
          sourceResolution={
            scan.kind === "ok"
              ? { width: scan.data.metadata.width, height: scan.data.metadata.height }
              : undefined
          }
          onResult={handleGenerateResult}
        />
      )}

      {slots.video && (assFileId || pgsFileId) && (
        <MuxSection
          videoFileId={slots.video.id}
          videoName={slots.video.name}
          assFileId={assFileId}
          pgsFileId={pgsFileId}
          targetLang={slots.target?.lang_code}
          nativeLang={slots.native?.lang_code}
          phoneticSystem={styles.annotation.phonetic_system ?? undefined}
          annotationEnabled={styles.annotation.enabled}
          audioTracks={scan.kind === "ok" ? scan.data.audio_tracks : undefined}
        />
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
