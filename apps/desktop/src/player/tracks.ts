// Local-file caption acquisition for the Loom Player (7c) — the
// "local-file CaptionPlatform" from MOBILE_ROADMAP.md §3 seam #4.
//
// Two sources, merged into one track list:
//   1. EMBEDDED text tracks — POST /files/by-path → POST /video/scan (the
//      sidecar pre-extracts each text track) → GET /files/{id}.
//   2. EXTERNAL sibling subtitle files (.ass/.srt/.vtt/.ssa next to the
//      video — the anime norm, e.g. DBD-Raws `.scjp.ass`).  Discovered via
//      Tauri fs, registered through /files/by-path, downloaded, parsed, and
//      SPLIT by script into clean per-language tracks (subs-split.ts) so a
//      bilingual JP/CH file yields a JA track + a ZH track.
//
// Image subs (PGS) are skipped (OCR is out of scope) — but a video whose
// only embedded sub is PGS still gets its external text subs.

import { readDir } from "@tauri-apps/plugin-fs";
import { dirname, join } from "@tauri-apps/api/path";

import { parseSubtitleEvents } from "@loom/player-ui/subs/parse-events";
import type {
  CaptionEvent,
  CaptionTrack,
} from "@loom/player-ui/captions/types";
import {
  API_BASE,
  registerFileByPath,
  scanVideo,
  type ScanResponse,
  type TrackInfo,
  type VideoMetadata,
} from "../api";
import { splitEventsByLanguage } from "./subs-split";

export interface PlayerTrack {
  caption: CaptionTrack;
  /** Embedded extracted track: fetch events from this sidecar file id. */
  fileId?: string;
  /** External track: events already parsed + script-split (no fetch). */
  events?: CaptionEvent[];
}

export interface LoadedMedia {
  fileId: string;
  path: string;
  metadata: VideoMetadata;
  tracks: PlayerTrack[];
  audioLangCode: string | null;
}

const SUB_EXTS = ["ass", "ssa", "srt", "vtt"];
const VIDEO_EXTS = ["mkv", "mp4", "webm", "avi", "mov", "m4v", "ts"];

export function fileUrl(fileId: string): string {
  return `${API_BASE}/files/${fileId}`;
}

function toEmbeddedTrack(
  info: TrackInfo,
  audioLangCode: string | null,
): PlayerTrack {
  return {
    fileId: info.file_id!,
    caption: {
      id: `emb:${info.id}`,
      languageCode: info.lang_code ?? info.metadata_lang ?? "und",
      name: info.label,
      baseUrl: fileUrl(info.file_id!),
      kind: "manual",
      isCc: /\b(sdh|cc|closed)\b/i.test(info.track_title ?? ""),
      audioLangCode: audioLangCode ?? undefined,
    },
  };
}

/** Filename hint → base language, for labeling external tracks before the
    script split refines it (e.g. `.eng.srt` → en). */
function langHintFromName(name: string): string | null {
  const n = name.toLowerCase();
  if (/\b(jpn|jap|ja|jp)\b/.test(n) || n.includes("jp")) return "ja";
  if (/\b(eng|en)\b/.test(n)) return "en";
  if (/\b(chs|sc|gb|zh-hans|hans)\b/.test(n) || n.includes("sc")) return "zh-Hans";
  if (/\b(cht|tc|big5|zh-hant|hant)\b/.test(n) || n.includes("tc")) return "zh-Hant";
  if (/\b(kor|ko)\b/.test(n)) return "ko";
  return null;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function ext(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

/** Discover + register + parse + language-split external sibling subs. */
async function externalTracks(
  videoPath: string,
  audioLangCode: string | null,
): Promise<PlayerTrack[]> {
  let dir: string;
  let stem: string;
  try {
    dir = await dirname(videoPath);
    stem = stripExt(baseName(videoPath));
  } catch {
    return [];
  }
  let entries: { name: string }[];
  try {
    entries = (await readDir(dir)) as { name: string }[];
  } catch {
    return []; // no fs access / permission — embedded tracks still work
  }

  const subFiles = entries
    .map((e) => e.name)
    .filter(
      (name) =>
        SUB_EXTS.includes(ext(name)) &&
        // sibling of THIS video (share the stem) and not another episode
        (name.startsWith(stem + ".") || name === stem + "." + ext(name)),
    );

  const out: PlayerTrack[] = [];
  for (const name of subFiles) {
    if (VIDEO_EXTS.includes(ext(name))) continue;
    let path: string;
    try {
      path = await join(dir, name);
    } catch {
      continue;
    }
    let text: string;
    try {
      const slot = await registerFileByPath(path);
      const res = await fetch(fileUrl(slot.id));
      if (!res.ok) continue;
      text = await res.text();
    } catch {
      continue;
    }
    const events = parseSubtitleEvents(text);
    if (events.length === 0) continue;

    const hint = langHintFromName(name);
    // Chinese script (Hans/Hant) comes from the filename hint (.scjp→Hans,
    // .tcjp→Hant), not per-line guessing; default Traditional for anime.
    const zhScript =
      hint === "zh-Hans" ? "zh-Hans" : hint === "zh-Hant" ? "zh-Hant" : "zh-Hant";
    const resolveLang = (l: string): string => (l === "zh" ? zhScript : l);

    const buckets = splitEventsByLanguage(events);
    // If the split found nothing usable, fall back to one track tagged by
    // the filename hint (or "und").
    if (buckets.length === 0) {
      out.push(oneExternal(name, hint ?? "und", events, audioLangCode));
      continue;
    }
    for (const b of buckets) {
      out.push(oneExternal(name, resolveLang(b.lang), b.events, audioLangCode));
    }
  }
  return out;
}

function oneExternal(
  fileName: string,
  lang: string,
  events: CaptionEvent[],
  audioLangCode: string | null,
): PlayerTrack {
  return {
    events,
    caption: {
      id: `ext:${fileName}:${lang}`,
      languageCode: lang,
      name: `${fileName} · ${lang}`,
      baseUrl: "",
      kind: "manual",
      isCc: false,
      audioLangCode: audioLangCode ?? undefined,
    },
  };
}

/** Register + scan a local media path, merging embedded text tracks with
    external sibling subtitle files (script-split). */
export async function loadMedia(path: string): Promise<LoadedMedia> {
  const slot = await registerFileByPath(path);
  const scan: ScanResponse = await scanVideo(slot.id);
  const audioLangCode =
    scan.audio_tracks.find((a) => a.lang_code)?.lang_code ?? null;

  const embedded = scan.tracks
    .filter((t) => t.selectable && t.file_id)
    .map((info) => toEmbeddedTrack(info, audioLangCode));

  const external = await externalTracks(path, audioLangCode);

  return {
    fileId: slot.id,
    path,
    metadata: scan.metadata,
    tracks: [...embedded, ...external],
    audioLangCode,
  };
}

// ---- study-language track selection ------------------------------------
//
// The user is studying a specific language (default Japanese); when a video
// has that language's subs + audio (anime norm: JA audio + JA/EN subs), we
// want the STUDY language as the Top/target line (with furigana + romaji)
// and the user's language (English) as the Bottom/native line — regardless
// of which audio track the file lists first (multi-dub files list English
// first, which is why raw auto-pick landed on the wrong language).

function baseLang(code: string): string {
  return (code || "").toLowerCase().split("-")[0];
}

/** Track quality within a language: full > sdh > forced (forced = partial
    sign-only subs; sdh carries sound descriptions but is complete). */
function trackScore(name: string): number {
  const n = name.toLowerCase();
  let s = 0;
  if (n.includes("forced")) s -= 10;
  if (n.includes("sdh")) s -= 2;
  if (n.includes("full")) s += 3;
  return s;
}

function bestInLang(
  tracks: PlayerTrack[],
  lang: string,
): PlayerTrack | null {
  const matches = tracks.filter(
    (t) => baseLang(t.caption.languageCode) === baseLang(lang),
  );
  if (matches.length === 0) return null;
  return matches
    .slice()
    .sort((a, b) => trackScore(b.caption.name) - trackScore(a.caption.name))[0];
}

export interface StudySelection {
  targetId: string | null;
  nativeId: string | null;
}

/** Pick Top (study language) + Bottom (user language) tracks by preference,
    honoring the rule: study-lang subs on top, user-lang subs on bottom. */
export function selectStudyTracks(
  tracks: PlayerTrack[],
  studyLang: string,
  nativeLang: string,
): StudySelection {
  const target = bestInLang(tracks, studyLang) ?? bestInLang(tracks, "und");
  // Native must not be the same track as target (single-language file).
  const native = bestInLang(tracks, nativeLang);
  return {
    targetId: (target ?? tracks[0])?.caption.id ?? null,
    nativeId:
      native && native.caption.id !== target?.caption.id
        ? native.caption.id
        : null,
  };
}

/** ISO-639-2/1 alias list for mpv's `alang` — play the audio in the language
    being studied (matches the Top subs). */
export function audioLangAliases(studyLang: string): string {
  const map: Record<string, string> = {
    ja: "jpn,ja",
    ko: "kor,ko",
    zh: "chi,zho,zh",
    en: "eng,en",
    es: "spa,es",
    fr: "fre,fra,fr",
    de: "ger,deu,de",
    it: "ita,it",
    pt: "por,pt",
    ru: "rus,ru",
    hi: "hin,hi",
  };
  return map[baseLang(studyLang)] ?? baseLang(studyLang);
}

/** Events for one track — parsed already (external) or fetched (embedded). */
export async function fetchTrackEvents(
  track: PlayerTrack,
): Promise<CaptionEvent[]> {
  if (track.events) return track.events;
  if (!track.fileId) return [];
  const res = await fetch(fileUrl(track.fileId));
  if (!res.ok) {
    throw new Error(`track download → HTTP ${res.status}`);
  }
  return parseSubtitleEvents(await res.text());
}
