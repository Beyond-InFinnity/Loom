import {
  createJellyfinPlaybackIdentity,
  jellyfinSubtitleTrackId,
  type JellyfinPlaybackIdentity,
} from "./server-scope";

type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function streamIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}
function label(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200)
    : "";
}

/** Jellyfin often uses ISO-639-2 tags (jpn/eng/fre), unlike streaming sites.
 * Intl canonicalization preserves explicit script/region tags and established
 * language aliases. Never infer a language from a human-readable track title. */
export function normalizeJellyfinLanguage(value: unknown): string {
  if (typeof value !== "string") return "und";
  const raw = value.trim().replace(/_/g, "-");
  if (raw.length > 80 || !/^[A-Za-z]{2,3}(?:-[A-Za-z\d]{2,8})*$/.test(raw)) return "und";
  try { return Intl.getCanonicalLocales(raw)[0] ?? "und"; }
  catch { return "und"; }
}

export interface JellyfinSubtitleTrack {
  readonly id: string;
  readonly streamIndex: number;
  readonly languageCode: string;
  readonly name: string;
  readonly codec: string;
  readonly isExternal: boolean;
  readonly isHearingImpaired: boolean;
  readonly isForced: boolean;
}

export interface JellyfinPlaybackSnapshot {
  readonly identity: JellyfinPlaybackIdentity;
  /** Monotonic MAIN-owned generation, including revisits to the same item. */
  readonly playbackEpoch: number;
  readonly tracks: readonly JellyfinSubtitleTrack[];
  readonly audioLanguageCode?: string;
  /** Image streams are unavailable, not evidence of a captionless file. */
  readonly imageSubtitleCount: number;
  readonly unsupportedSubtitleCount: number;
  readonly selectedSubtitleBurnedIn: boolean;
}

export interface JellyfinPlaybackContext {
  readonly serverBaseUrl: string;
  readonly itemId: string;
  readonly playbackEpoch: number;
  /** Must come from the active playback, never blindly MediaSources[0]. */
  readonly mediaSourceId: string;
  readonly audioStreamIndex?: number;
  readonly subtitleStreamIndex?: number;
}

export type JellyfinPlaybackMetadata =
  | { readonly ok: true; readonly snapshot: JellyfinPlaybackSnapshot }
  | { readonly ok: false; readonly reason: "invalid-context" | "invalid-playback-info" | "media-source-not-found" | "ambiguous-media-source" };

const TEXT_CODECS = new Set([
  "vtt", "webvtt", "srt", "subrip", "ass", "ssa", "text", "mov_text", "ttml",
]);
const IMAGE_CODECS = new Set([
  "pgssub", "hdmv_pgs_subtitle", "dvdsub", "dvd_subtitle", "vobsub", "dvbsub", "dvb_subtitle", "xsub",
]);

/** Read an untrusted PlaybackInfo response using the *active* item/source.
 * Only whitelisted metadata leaves this function. In particular DeliveryUrl,
 * Path, TranscodingUrl, HttpHeaders and user/access-token fields are not copied.
 * Text classification does not guarantee the deployed server can convert every
 * codec; a VTT conversion failure is a separate read result. */
export function readJellyfinPlaybackInfo(
  value: unknown,
  context: JellyfinPlaybackContext,
): JellyfinPlaybackMetadata {
  let identity: JellyfinPlaybackIdentity;
  try {
    identity = createJellyfinPlaybackIdentity(context.serverBaseUrl, context.itemId, context.mediaSourceId);
    if (
      !Number.isSafeInteger(context.playbackEpoch) || context.playbackEpoch < 0 ||
      (context.audioStreamIndex !== undefined && context.audioStreamIndex !== -1 && !streamIndex(context.audioStreamIndex)) ||
      (context.subtitleStreamIndex !== undefined && context.subtitleStreamIndex !== -1 && !streamIndex(context.subtitleStreamIndex))
    ) return { ok: false, reason: "invalid-context" };
  } catch { return { ok: false, reason: "invalid-context" }; }

  if (!record(value) || !Array.isArray(value.MediaSources) || value.MediaSources.length > 128 || value.ErrorCode) {
    return { ok: false, reason: "invalid-playback-info" };
  }
  const sources = value.MediaSources.filter((s): s is RecordValue => record(s) && s.Id === identity.mediaSourceId);
  if (sources.length === 0) return { ok: false, reason: "media-source-not-found" };
  if (sources.length !== 1) return { ok: false, reason: "ambiguous-media-source" };
  const source = sources[0];
  if (!Array.isArray(source.MediaStreams) || source.MediaStreams.length > 512) {
    return { ok: false, reason: "invalid-playback-info" };
  }

  const tracks: JellyfinSubtitleTrack[] = [];
  const seen = new Set<number>();
  let imageSubtitleCount = 0;
  let unsupportedSubtitleCount = 0;
  let selectedSubtitleBurnedIn = false;
  const audioIndex = context.audioStreamIndex ?? source.DefaultAudioStreamIndex;
  const subtitleIndex = context.subtitleStreamIndex ?? source.DefaultSubtitleStreamIndex;
  let audioLanguageCode: string | undefined;
  for (const s of source.MediaStreams) {
    if (!record(s)) return { ok: false, reason: "invalid-playback-info" };
    if (s.Type === "Audio" && streamIndex(audioIndex) && s.Index === audioIndex) {
      audioLanguageCode = normalizeJellyfinLanguage(s.Language);
    }
    if (s.Type !== "Subtitle") continue;
    if (!streamIndex(s.Index) || seen.has(s.Index)) return { ok: false, reason: "invalid-playback-info" };
    seen.add(s.Index);
    if (s.Index === subtitleIndex && s.DeliveryMethod === "Encode") {
      selectedSubtitleBurnedIn = true;
    }
    const codec = typeof s.Codec === "string" ? s.Codec.trim().toLowerCase() : "";
    if (IMAGE_CODECS.has(codec)) { imageSubtitleCount++; continue; }
    if (s.IsTextSubtitleStream === false || !(s.IsTextSubtitleStream === true || TEXT_CODECS.has(codec))) {
      unsupportedSubtitleCount++;
      continue;
    }
    const languageCode = normalizeJellyfinLanguage(s.Language);
    tracks.push(Object.freeze({
      id: jellyfinSubtitleTrackId(identity, s.Index), streamIndex: s.Index,
      languageCode, name: label(s.DisplayTitle) || label(s.Title) || languageCode,
      codec: codec.slice(0, 80), isExternal: s.IsExternal === true,
      isHearingImpaired: s.IsHearingImpaired === true, isForced: s.IsForced === true,
    }));
  }
  return {
    ok: true,
    snapshot: Object.freeze({
      identity, playbackEpoch: context.playbackEpoch, tracks: Object.freeze(tracks), imageSubtitleCount,
      unsupportedSubtitleCount, selectedSubtitleBurnedIn,
      ...(audioLanguageCode ? { audioLanguageCode } : {}),
    }),
  };
}