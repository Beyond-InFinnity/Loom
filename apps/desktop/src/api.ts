// HTTP client for the loom_api sidecar.
//
// Tauri-side everything goes through ``http://localhost:8765``. At step 4
// (web) the same module talks to the production base URL — flipped via
// one ``API_BASE`` constant or env var.

export const API_BASE = "http://localhost:8765";

export type FileSlot = {
  id: string;
  name: string;
  size?: number;
  path?: string;
  lang_code?: string;
};

export type HealthInfo = {
  name: string;
  version: string;
};

export type VideoMetadata = {
  title: string | null;
  year: number | null;
  duration_seconds: number;
  width: number;
  height: number;
};

export type TrackInfo = {
  id: number;
  sub_num: number | null;
  label: string;
  file_id: string | null;
  lang_code: string | null;
  source: string;
  selectable: boolean;
  codec: string | null;
  metadata_lang: string | null;
  track_title: string | null;
};

export type ScanResponse = {
  metadata: VideoMetadata;
  tracks: TrackInfo[];
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

// Probe a registered video file: returns container metadata + the list of
// subtitle tracks. Text tracks come back already extracted and registered
// (caller can drop the track's file_id into a slot directly). Image tracks
// (PGS, VobSub) carry selectable=false and file_id=null.
export async function scanVideo(fileId: string): Promise<ScanResponse> {
  const res = await fetch(`${API_BASE}/video/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`/video/scan → HTTP ${res.status}: ${detail}`);
  }
  return res.json();
}
