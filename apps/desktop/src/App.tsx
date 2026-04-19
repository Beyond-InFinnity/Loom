import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  API_BASE,
  FileSlot,
  HealthInfo,
  probeHealth,
  registerFileByPath,
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function App() {
  const [sidecar, setSidecar] = useState<SidecarState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  const [slots, setSlots] = useState<Slots>({});
  const [errors, setErrors] = useState<SlotErrors>({});
  const [busy, setBusy] = useState<SlotKey | null>(null);

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

  const disabled = sidecar.kind !== "ok";

  return (
    <main className="container" style={{ maxWidth: 760, margin: "0 auto", padding: "32px 24px" }}>
      <h1 style={{ marginBottom: 4 }}>Loom</h1>
      <p style={{ opacity: 0.6, fontSize: "0.9em", marginTop: 0 }}>
        Step 3b · file picker
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
              <button
                onClick={() => pickFile(slot)}
                disabled={disabled || busy === slot.key}
                style={{ padding: "6px 14px" }}
              >
                {busy === slot.key ? "registering…" : value ? "Choose another…" : "Choose file…"}
              </button>
              {value && (
                <div
                  style={{
                    marginTop: 10,
                    fontFamily: "monospace",
                    fontSize: "0.85em",
                    opacity: 0.85,
                  }}
                >
                  <div>{value.name} <span style={{ opacity: 0.6 }}>· {formatBytes(value.size)}</span></div>
                  <div style={{ opacity: 0.5, fontSize: "0.85em", wordBreak: "break-all" }}>
                    id={value.id}
                  </div>
                  <div style={{ opacity: 0.5, fontSize: "0.85em", wordBreak: "break-all" }}>
                    {value.path}
                  </div>
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
