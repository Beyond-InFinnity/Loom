// A transport "remote" for the Loom Player, rendered in the MAIN window.
//
// Why here: the player window is a TRANSPARENT webview composited over the
// libmpv GtkGLArea, and its in-overlay buttons currently don't receive pointer
// input (a WebKitGTK/GTK compositing issue under investigation).  The main
// window is a normal opaque Tauri window with working input, and the mpv
// controls are cross-window Tauri commands + the "mpv-prop" playhead events
// broadcast app-wide — so this remote reliably drives + reflects playback while
// the overlay-input issue is sorted out.  It doubles as a VLC-style control bar.

import { useEffect, useState } from "react";
import {
  getMpvState,
  initMpvEvents,
  isMutedPersisted,
  onMpvState,
  seekToMs,
  setMute,
  setPause,
} from "../player/mpv";

function fmt(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function PlayerRemote() {
  const [st, setSt] = useState(getMpvState());
  const [muted, setMutedState] = useState(true);

  useEffect(() => {
    void initMpvEvents();
    void isMutedPersisted().then(setMutedState);
    return onMpvState(() => setSt(getMpvState()));
  }, []);

  const hasMedia = st.durationMs > 0;
  const toggleMute = () => {
    const next = !muted;
    setMutedState(next);
    void setMute(next);
  };

  return (
    <div style={bar}>
      <button style={btn} onClick={() => void setPause(!st.paused)} disabled={!hasMedia}>
        {st.paused ? "▶" : "⏸"}
      </button>
      <button style={btn} onClick={toggleMute} title={muted ? "Unmute" : "Mute"}>
        {muted ? "🔇" : "🔊"}
      </button>
      <span style={time}>
        {fmt(st.timeMs)} / {fmt(st.durationMs)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(1, st.durationMs)}
        value={Math.min(st.timeMs, st.durationMs)}
        onChange={(e) => void seekToMs(Number(e.target.value))}
        disabled={!hasMedia}
        style={{ flex: 1, accentColor: "#5dffaa" }}
      />
      {!hasMedia && <span style={hint}>Open a video in the player</span>}
    </div>
  );
}

const bar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  borderRadius: 8,
  background: "rgba(20,20,24,0.9)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "#fff",
  fontSize: 13,
  maxWidth: 460,
};
const btn: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: 6,
  border: "1px solid rgba(255,255,255,0.15)",
  background: "rgba(255,255,255,0.06)",
  color: "#fff",
  cursor: "pointer",
};
const time: React.CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontSize: 12,
  color: "rgba(255,255,255,0.75)",
  whiteSpace: "nowrap",
};
const hint: React.CSSProperties = {
  fontSize: 11,
  color: "rgba(255,255,255,0.45)",
  whiteSpace: "nowrap",
};
