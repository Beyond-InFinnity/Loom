// Folder-based playlist for the Loom Player: the video's sibling files in the
// same directory, naturally sorted (so "Ep 2" precedes "Ep 10").  Drives the
// prev/next controls + next-episode auto-advance — no explicit playlist file,
// just "what else is in this folder", which is how anime/TV is stored.

import { readDir } from "@tauri-apps/plugin-fs";
import { dirname, join } from "@tauri-apps/api/path";

const VIDEO_EXTS = ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"];

function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Full paths of the sibling video files in `videoPath`'s directory, naturally
    sorted by filename.  Returns [] on any fs error (playlist just disabled). */
export async function siblingVideos(videoPath: string): Promise<string[]> {
  let dir: string;
  try {
    dir = await dirname(videoPath);
  } catch {
    return [];
  }
  let names: string[];
  try {
    names = (await readDir(dir))
      .map((e) => (e as { name: string }).name)
      .filter((n) => VIDEO_EXTS.includes(ext(n)));
  } catch {
    return [];
  }
  // Numeric-aware sort: E9 before E10, "part 2" before "part 10".
  names.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
  try {
    return await Promise.all(names.map((n) => join(dir, n)));
  } catch {
    return [];
  }
}
