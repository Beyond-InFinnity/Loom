// Recent files + resume-position ("watch later") persistence for the Loom
// Player, in localStorage.  Pure + synchronous — no Tauri/mpv coupling, so it's
// trivially testable and safe to call from render.

const RECENTS_KEY = "loom_player_recents";
const MAX_RECENTS = 12;
/** Below this, a position isn't worth resuming (skipped intro / accidental open). */
const RESUME_MIN_MS = 30_000;
/** At/above this fraction of the runtime, treat the file as finished → no resume. */
const RESUME_MAX_FRAC = 0.97;

export interface RecentEntry {
  path: string;
  name: string;
  /** Last playback position (ms).  0 = start / finished. */
  posMs: number;
  /** Runtime (ms), 0 until known.  Used to detect "finished". */
  durMs: number;
  /** Last opened (ms epoch) — recents are ordered by this. */
  ts: number;
}

function read(): RecentEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    if (!Array.isArray(v)) return [];
    return v.filter(
      (e): e is RecentEntry =>
        !!e &&
        typeof e.path === "string" &&
        typeof e.name === "string" &&
        typeof e.posMs === "number" &&
        typeof e.durMs === "number" &&
        typeof e.ts === "number",
    );
  } catch {
    return [];
  }
}

function write(list: RecentEntry[]): void {
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

/** Recent files, most-recently-opened first. */
export function getRecents(): RecentEntry[] {
  return read().sort((a, b) => b.ts - a.ts);
}

/** Record that `path` was opened now (moves it to the front, preserving any
    saved position). */
export function recordOpen(path: string, name: string): void {
  const all = read();
  const prev = all.find((e) => e.path === path);
  const rest = all.filter((e) => e.path !== path);
  rest.unshift({
    path,
    name,
    posMs: prev?.posMs ?? 0,
    durMs: prev?.durMs ?? 0,
    ts: Date.now(),
  });
  write(rest);
}

/** Save the current playback position for `path` (clears it once finished, so a
    completed file doesn't resume at its final second).  No-op if `path` isn't a
    known recent (only files opened via the Player are tracked). */
export function savePosition(path: string, posMs: number, durMs: number): void {
  const all = read();
  const e = all.find((x) => x.path === path);
  if (!e) return;
  const finished = durMs > 0 && posMs > durMs * RESUME_MAX_FRAC;
  e.posMs = finished ? 0 : Math.max(0, Math.round(posMs));
  if (durMs > 0) e.durMs = Math.round(durMs);
  write(all);
}

/** The resume position for `path`, or null if there's nothing worth resuming. */
export function getResume(path: string): number | null {
  const e = read().find((x) => x.path === path);
  if (!e || e.posMs < RESUME_MIN_MS) return null;
  if (e.durMs > 0 && e.posMs > e.durMs * RESUME_MAX_FRAC) return null;
  return e.posMs;
}

export function removeRecent(path: string): void {
  write(read().filter((e) => e.path !== path));
}

/** Fraction watched (0–1) for a recent, or 0 when unknown. */
export function watchedFraction(e: RecentEntry): number {
  return e.durMs > 0 ? Math.min(1, e.posMs / e.durMs) : 0;
}

// ── Per-file track memory ────────────────────────────────────────────────
// Remember the Loom Top/Bottom track picks per file, so reopening a video (or
// advancing to the next episode of the same release, which shares track layout)
// restores the user's manual choice instead of re-running the auto-pick.  Track
// ids are stable for a given file, so path→ids is a reliable key.

const TRACKSEL_KEY = "loom_player_track_sel";
const MAX_TRACKSEL = 200;

export interface TrackSel {
  /** Loom Top (video-language) track id. */
  targetId?: string | null;
  /** Loom Bottom (your-language) track id; null = explicitly none. */
  nativeId?: string | null;
}

function readSel(): Record<string, TrackSel> {
  try {
    const v = JSON.parse(localStorage.getItem(TRACKSEL_KEY) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, TrackSel>)
      : {};
  } catch {
    return {};
  }
}

/** The remembered Loom track selection for `path`, or null if none saved. */
export function getTrackSel(path: string): TrackSel | null {
  const m = readSel();
  return Object.prototype.hasOwnProperty.call(m, path) ? m[path] : null;
}

/** Remember (merge) the Loom track selection for `path`. */
export function saveTrackSel(path: string, sel: Partial<TrackSel>): void {
  try {
    const m = readSel();
    m[path] = { ...m[path], ...sel };
    // Bound the map (oldest-inserted keys drop first).
    const keys = Object.keys(m);
    if (keys.length > MAX_TRACKSEL) {
      for (const k of keys.slice(0, keys.length - MAX_TRACKSEL)) delete m[k];
    }
    localStorage.setItem(TRACKSEL_KEY, JSON.stringify(m));
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}
