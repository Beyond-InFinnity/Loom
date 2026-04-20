import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { AudioTrackInfo, getJob, JobStatus, muxVideo } from "./api";

type MuxState =
  | { kind: "idle" }
  | { kind: "running"; phase: string | null }
  | { kind: "ok"; outputPath: string }
  | { kind: "error"; message: string };

type Props = {
  videoFileId: string;
  videoName: string;
  assFileId?: string;
  pgsFileId?: string;
  targetLang?: string;
  nativeLang?: string;
  phoneticSystem?: string;
  annotationEnabled: boolean;
  audioTracks?: AudioTrackInfo[];
};

const POLL_INTERVAL_MS = 500;

function defaultOutputName(videoName: string): string {
  const base = videoName.replace(/\.[^./\\]+$/, "");
  return `${base}_stitched.mkv`;
}

// Auto-pick the audio track whose language primary-subtag matches the
// target (foreign) language. Falls back to "no change" when nothing
// matches or the tracks list is empty. Undefined return ≡ leave the
// source MKV's audio disposition untouched.
function autoSelectAudioIndex(
  tracks: AudioTrackInfo[] | undefined,
  targetLang: string | undefined,
): number | undefined {
  if (!tracks || !tracks.length || !targetLang) return undefined;
  const primary = (lc: string | null | undefined) =>
    (lc || "").toLowerCase().split("-")[0].split("_")[0];
  const tgt = primary(targetLang);
  if (!tgt) return undefined;
  for (const t of tracks) {
    if (primary(t.lang_code) === tgt) return t.audio_index;
  }
  return undefined;
}

export function MuxSection({
  videoFileId, videoName, assFileId, pgsFileId, targetLang, nativeLang,
  phoneticSystem, annotationEnabled, audioTracks,
}: Props) {
  const [includeAss, setIncludeAss] = useState<boolean>(!!assFileId);
  const [includePgs, setIncludePgs] = useState<boolean>(!!pgsFileId);
  const [keepSubs, setKeepSubs] = useState(true);
  const [keepAttachments, setKeepAttachments] = useState(true);
  const [defaultAudio, setDefaultAudio] = useState<number | undefined>(() =>
    autoSelectAudioIndex(audioTracks, targetLang),
  );
  const [outputPath, setOutputPath] = useState<string>("");
  const [state, setState] = useState<MuxState>({ kind: "idle" });
  const pollTimer = useRef<number | null>(null);

  // Re-run auto-select whenever the audio track list or target language
  // changes (e.g. scanned a new video, or swapped the Top slot).
  useEffect(() => {
    setDefaultAudio(autoSelectAudioIndex(audioTracks, targetLang));
  }, [audioTracks, targetLang]);

  useEffect(() => {
    return () => {
      if (pollTimer.current !== null) {
        window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, []);

  // Whenever the set of available generated tracks changes, re-sync the
  // include toggles to match (both on by default, disabled if missing).
  useEffect(() => {
    setIncludeAss(!!assFileId);
  }, [assFileId]);
  useEffect(() => {
    setIncludePgs(!!pgsFileId);
  }, [pgsFileId]);

  async function pickOutputPath() {
    const chosen = await save({
      defaultPath: defaultOutputName(videoName),
      filters: [{ name: "Matroska video", extensions: ["mkv"] }],
    });
    if (typeof chosen === "string") setOutputPath(chosen);
  }

  function pollMux(jobId: string) {
    (async () => {
      try {
        const status: JobStatus = await getJob(jobId);
        if (status.state === "completed") {
          setState({ kind: "ok", outputPath });
          return;
        }
        if (status.state === "failed") {
          setState({
            kind: "error",
            message: status.error ?? "Mux failed",
          });
          return;
        }
        setState({ kind: "running", phase: status.phase });
        pollTimer.current = window.setTimeout(() => pollMux(jobId), POLL_INTERVAL_MS);
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }

  async function runMux() {
    if (!outputPath) return;
    setState({ kind: "running", phase: "starting" });
    try {
      const accepted = await muxVideo({
        video_file_id: videoFileId,
        ass_file_id: includeAss ? assFileId : undefined,
        sup_file_id: includePgs ? pgsFileId : undefined,
        output_path: outputPath,
        target_lang_code: targetLang,
        native_lang_code: nativeLang,
        phonetic_system: phoneticSystem,
        annotation_enabled: annotationEnabled,
        keep_existing_subs: keepSubs,
        keep_attachments: keepAttachments,
        default_audio_index: defaultAudio,
      });
      pollMux(accepted.id);
    } catch (err) {
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hasAny = (includeAss && !!assFileId) || (includePgs && !!pgsFileId);
  const busy = state.kind === "running";
  const canMux = hasAny && !!outputPath && !busy;

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
        <strong>Mux into MKV</strong>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: "0.85em" }}>
          <span style={{ opacity: 0.7, width: 90 }}>Source</span>
          <span style={{ fontFamily: "monospace", opacity: 0.85, wordBreak: "break-all" }}>
            {videoName}
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ fontSize: "0.85em", opacity: 0.7, width: 90 }}>Tracks</span>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em", opacity: assFileId ? 1 : 0.4 }}>
            <input
              type="checkbox"
              checked={includeAss}
              disabled={!assFileId}
              onChange={(e) => setIncludeAss(e.target.checked)}
            />
            Include .ass
            {!assFileId && <span style={{ opacity: 0.5 }}> (generate first)</span>}
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em", opacity: pgsFileId ? 1 : 0.4 }}>
            <input
              type="checkbox"
              checked={includePgs}
              disabled={!pgsFileId}
              onChange={(e) => setIncludePgs(e.target.checked)}
            />
            Include PGS
            {!pgsFileId && <span style={{ opacity: 0.5 }}> (generate first)</span>}
          </label>
        </div>

        <AdvancedOptions
          keepSubs={keepSubs} setKeepSubs={setKeepSubs}
          keepAttachments={keepAttachments} setKeepAttachments={setKeepAttachments}
          audioTracks={audioTracks}
          defaultAudio={defaultAudio} setDefaultAudio={setDefaultAudio}
        />

        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: "0.85em", opacity: 0.7, width: 90 }}>Output</span>
          <button onClick={pickOutputPath} style={{ padding: "4px 12px", fontSize: "0.85em" }}>
            {outputPath ? "Change…" : "Choose output…"}
          </button>
          {outputPath && (
            <span style={{ fontSize: "0.8em", opacity: 0.7, fontFamily: "monospace", wordBreak: "break-all" }}>
              {outputPath}
            </span>
          )}
        </div>

        <div>
          <button
            onClick={runMux}
            disabled={!canMux}
            style={{ padding: "6px 14px" }}
            title={
              !hasAny ? "Generate a track first and include it"
                : !outputPath ? "Choose an output path"
                : ""
            }
          >
            {busy ? "muxing…" : "Mux"}
          </button>
        </div>
      </div>

      <StatusRow state={state} />
    </section>
  );
}

function AdvancedOptions({
  keepSubs, setKeepSubs, keepAttachments, setKeepAttachments,
  audioTracks, defaultAudio, setDefaultAudio,
}: {
  keepSubs: boolean; setKeepSubs: (b: boolean) => void;
  keepAttachments: boolean; setKeepAttachments: (b: boolean) => void;
  audioTracks?: AudioTrackInfo[];
  defaultAudio: number | undefined;
  setDefaultAudio: (n: number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          background: "transparent", border: "none",
          color: "#bbb", fontSize: "0.8em", cursor: "pointer",
          padding: 0,
        }}
      >
        {open ? "▾" : "▸"} Advanced
      </button>
      {open && (
        <div style={{ marginTop: 8, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em" }}>
            <input
              type="checkbox"
              checked={keepSubs}
              onChange={(e) => setKeepSubs(e.target.checked)}
            />
            Keep existing subtitle tracks
          </label>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em" }}>
            <input
              type="checkbox"
              checked={keepAttachments}
              onChange={(e) => setKeepAttachments(e.target.checked)}
            />
            Keep font attachments
          </label>
          {audioTracks && audioTracks.length > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "0.85em" }}>
              <span style={{ opacity: 0.7 }}>Default audio</span>
              <select
                value={defaultAudio ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setDefaultAudio(v === "" ? undefined : Number(v));
                }}
                style={{ padding: "2px 6px", fontSize: "0.85em" }}
                title="Set the default audio track in the muxed output. 'No change' keeps the source MKV's disposition."
              >
                <option value="">No change (keep source default)</option>
                {audioTracks.map((t) => (
                  <option key={t.audio_index} value={t.audio_index}>
                    {audioTrackLabel(t)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function audioTrackLabel(t: AudioTrackInfo): string {
  const lang = t.lang_code ? t.lang_code : "unknown";
  const parts: string[] = [`Track ${t.audio_index + 1}: ${lang}`];
  if (t.title) parts.push(`— ${t.title}`);
  const tags: string[] = [];
  if (t.codec) tags.push(t.codec);
  if (t.channels) tags.push(`${t.channels}ch`);
  if (tags.length) parts.push(`[${tags.join(", ")}]`);
  return parts.join(" ");
}

function StatusRow({ state }: { state: MuxState }) {
  if (state.kind === "idle") return null;
  return (
    <div style={{
      marginTop: 12, paddingTop: 10, borderTop: "1px solid #222",
      display: "flex", alignItems: "center", gap: 10, fontSize: "0.85em",
      flexWrap: "wrap",
    }}>
      {state.kind === "running" && (
        <>
          <span style={{ opacity: 0.7 }}>● muxing</span>
          <span style={{ opacity: 0.5, fontFamily: "monospace" }}>{state.phase ?? "running"}</span>
        </>
      )}
      {state.kind === "error" && (
        <span style={{ color: "#f87171", fontFamily: "monospace", wordBreak: "break-word" }}>
          {state.message}
        </span>
      )}
      {state.kind === "ok" && (
        <span style={{ color: "#4ade80", fontFamily: "monospace", wordBreak: "break-all" }}>
          → {state.outputPath}
        </span>
      )}
    </div>
  );
}
