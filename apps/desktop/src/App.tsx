import { useEffect, useState } from "react";
import "./App.css";

const API_BASE = "http://localhost:8765";

type ProbeState =
  | { kind: "starting" }
  | { kind: "ok"; data: { name: string; version: string } }
  | { kind: "error"; message: string };

async function probe(): Promise<ProbeState> {
  try {
    const [healthRes, rootRes] = await Promise.all([
      fetch(`${API_BASE}/health`),
      fetch(`${API_BASE}/`),
    ]);
    if (!healthRes.ok) {
      return { kind: "error", message: `/health → HTTP ${healthRes.status}` };
    }
    const health = await healthRes.json();
    const root = await rootRes.json();
    if (health.status !== "ok") {
      return { kind: "error", message: `/health returned ${JSON.stringify(health)}` };
    }
    return { kind: "ok", data: { name: root.name, version: root.version } };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function App() {
  const [state, setState] = useState<ProbeState>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await probe();
      if (!cancelled) setState(result);
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // Auto-retry every 1s while starting (sidecar takes ~1-2s to come up).
  useEffect(() => {
    if (state.kind !== "error") return;
    const t = window.setTimeout(() => setAttempt((n) => n + 1), 1000);
    return () => window.clearTimeout(t);
  }, [state]);

  return (
    <main className="container">
      <h1>Loom</h1>
      <p style={{ opacity: 0.7, fontSize: "0.9em" }}>
        Step 3a — Tauri shell + Python sidecar IPC
      </p>

      <div
        style={{
          marginTop: 32,
          padding: 20,
          border: "1px solid #444",
          borderRadius: 8,
          fontFamily: "monospace",
          fontSize: "0.95em",
        }}
      >
        {state.kind === "starting" && <span>connecting to sidecar…</span>}

        {state.kind === "ok" && (
          <>
            <div style={{ color: "#4ade80" }}>● sidecar up</div>
            <div style={{ marginTop: 8, opacity: 0.8 }}>
              {state.data.name} v{state.data.version}
            </div>
            <div style={{ marginTop: 4, opacity: 0.6, fontSize: "0.85em" }}>
              {API_BASE}
            </div>
          </>
        )}

        {state.kind === "error" && (
          <>
            <div style={{ color: "#f87171" }}>● sidecar unreachable</div>
            <div style={{ marginTop: 8, opacity: 0.8 }}>{state.message}</div>
            <div style={{ marginTop: 4, opacity: 0.5, fontSize: "0.85em" }}>
              retrying… (attempt {attempt + 1})
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default App;
