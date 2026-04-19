// HTTP client for the loom_api sidecar.
//
// Tauri-side everything goes through ``http://localhost:8765``. At step 4
// (web) the same module talks to the production base URL — flipped via
// one ``API_BASE`` constant or env var.

export const API_BASE = "http://localhost:8765";

export type FileSlot = {
  id: string;
  name: string;
  size: number;
  path: string;
};

export type HealthInfo = {
  name: string;
  version: string;
};

export async function probeHealth(): Promise<HealthInfo> {
  const [healthRes, rootRes] = await Promise.all([
    fetch(`${API_BASE}/health`),
    fetch(`${API_BASE}/`),
  ]);
  if (!healthRes.ok) {
    throw new Error(`/health → HTTP ${healthRes.status}`);
  }
  const health = await healthRes.json();
  if (health.status !== "ok") {
    throw new Error(`/health returned ${JSON.stringify(health)}`);
  }
  const root = await rootRes.json();
  return { name: root.name, version: root.version };
}

// Desktop fast path: register an absolute on-disk path with the sidecar
// without copying bytes. Returns a FileSlot the rest of the app holds onto.
export async function registerFileByPath(path: string): Promise<FileSlot> {
  const res = await fetch(`${API_BASE}/files/by-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/files/by-path → HTTP ${res.status}: ${detail}`);
  }
  const data = await res.json();
  return { id: data.id, name: data.filename, size: data.size, path };
}
