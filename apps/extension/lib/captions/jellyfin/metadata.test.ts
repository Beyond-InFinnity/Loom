import { describe, expect, it } from "vitest";
import { createJellyfinPlaybackIdentity, normalizeJellyfinServerBaseUrl } from "./server-scope";
import { normalizeJellyfinLanguage, readJellyfinPlaybackInfo, type JellyfinPlaybackContext } from "./metadata";

const ITEM = "0123456789abcdef0123456789abcdef";
const CONTEXT: JellyfinPlaybackContext = {
  serverBaseUrl: "https://media.example.test:8443/jellyfin/",
  itemId: ITEM, mediaSourceId: "source-a", playbackEpoch: 1,
};
const textStream = (index: number, extra: Record<string, unknown> = {}) => ({
  Type: "Subtitle", Index: index, Codec: "subrip", Language: "jpn",
  IsTextSubtitleStream: true, DisplayTitle: "Japanese", ...extra,
});
function info(streams: unknown[] = [textStream(2)]) {
  return { MediaSources: [{ Id: "source-a", MediaStreams: streams, DefaultAudioStreamIndex: 1 }] };
}
function snapshot(value: unknown, context = CONTEXT) {
  const result = readJellyfinPlaybackInfo(value, context);
  if (!result.ok) throw new Error(result.reason);
  return result.snapshot;
}

describe("Jellyfin server scope and identity", () => {
  it("preserves proxy base path, custom port, and explicit HTTP LAN scope", () => {
    expect(normalizeJellyfinServerBaseUrl("https://MEDIA.example.test:8443/jellyfin"))
      .toBe("https://media.example.test:8443/jellyfin/");
    expect(normalizeJellyfinServerBaseUrl("http://192.0.2.2:8096"))
      .toBe("http://192.0.2.2:8096/");
  });
  it.each([
    "file:///tmp/movie", "javascript:alert(1)", "ftp://media.example.test/",
    "https://user:synthetic-password@media.example.test/",
    "https://media.example.test/?api_key=synthetic-marker",
    "https://media.example.test/#synthetic-marker",
    "https://media.example.test/proxy%2fescape/",
    "https://media.example.test/proxy%255cescape/",
    "https://media.example.test/\\escape", "https://media.example.test/\npath",
  ])("rejects credential-bearing or unsafe scope %j", (value) => {
    expect(() => normalizeJellyfinServerBaseUrl(value)).toThrow();
  });
  it("canonicalizes a dashed item GUID without changing a source ID", () => {
    const id = createJellyfinPlaybackIdentity(CONTEXT.serverBaseUrl, "01234567-89AB-CDEF-0123-456789ABCDEF", "Source-A");
    expect(id.itemId).toBe(ITEM);
    expect(id.mediaSourceId).toBe("Source-A");
  });
  it("separates servers, proxy paths, items, and media sources", () => {
    const key = (base = CONTEXT.serverBaseUrl, item = ITEM, source = "source-a") =>
      createJellyfinPlaybackIdentity(base, item, source).key;
    expect(new Set([
      key(), key("https://other.example.test/jellyfin/"),
      key("https://media.example.test:8443/other/"),
      key(undefined, "1123456789abcdef0123456789abcdef"), key(undefined, undefined, "source-b"),
    ]).size).toBe(5);
  });
  it.each(["../escape", "..", "a/b", "a%2fb", "a?api_key=x", "a#x", "", "x".repeat(201)])("rejects unsafe source ID %j", (source) => {
    expect(() => createJellyfinPlaybackIdentity(CONTEXT.serverBaseUrl, ITEM, source)).toThrow();
  });
});

describe("Jellyfin language metadata", () => {
  it.each([
    ["jpn", "ja"], ["eng", "en"], ["fre", "fr"], ["ger", "de"],
    ["chi", "zh"], ["por", "pt"], ["pol", "pl"], ["vie", "vi"],
    ["zh_Hant_TW", "zh-Hant-TW"], ["sr-Cyrl", "sr-Cyrl"], ["iw", "he"],
  ])("normalizes %s without guessing script variants", (input, output) => {
    expect(normalizeJellyfinLanguage(input)).toBe(output);
  });
  it.each([null, undefined, {}, "", "Japanese", "en SDH", "<script>", "en/../ja"])("uses und for unknown input %j", (input) => {
    expect(normalizeJellyfinLanguage(input)).toBe("und");
  });
});

describe("Jellyfin PlaybackInfo sanitization", () => {
  it("keeps two text streams separate and does not conflate forced with SDH", () => {
    const result = snapshot(info([
      { Type: "Audio", Index: 1, Language: "jpn" },
      textStream(2, { IsExternal: true, IsHearingImpaired: true }),
      textStream(3, { Codec: "ass", IsForced: true, IsHearingImpaired: false }),
    ]));
    expect(result.tracks).toHaveLength(2);
    expect(result.audioLanguageCode).toBe("ja");
    expect(result.tracks[0]).toMatchObject({ languageCode: "ja", isExternal: true, isHearingImpaired: true, isForced: false });
    expect(result.tracks[1]).toMatchObject({ codec: "ass", isExternal: false, isHearingImpaired: false, isForced: true });
    expect(result.tracks[0].id).not.toBe(result.tracks[1].id);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.tracks)).toBe(true);
    expect(Object.isFrozen(result.tracks[0])).toBe(true);
  });
  it("selects the explicit media source, never the first source", () => {
    const value = { MediaSources: [
      { Id: "wrong-source", MediaStreams: [textStream(9)] },
      { Id: "source-a", MediaStreams: [textStream(2)] },
    ] };
    expect(snapshot(value).tracks.map((t) => t.streamIndex)).toEqual([2]);
  });
  it("does not silently substitute a different or ambiguously duplicated source", () => {
    expect(readJellyfinPlaybackInfo(info(), { ...CONTEXT, mediaSourceId: "absent" }))
      .toEqual({ ok: false, reason: "media-source-not-found" });
    const value = info();
    value.MediaSources.push(value.MediaSources[0]);
    expect(readJellyfinPlaybackInfo(value, CONTEXT)).toEqual({ ok: false, reason: "ambiguous-media-source" });
  });
  it("honors the actively selected audio stream, not track order or source default", () => {
    const value = info([
      { Type: "Audio", Index: 1, Language: "jpn" },
      { Type: "Audio", Index: 3, Language: "eng" }, textStream(2),
    ]);
    expect(snapshot(value, { ...CONTEXT, audioStreamIndex: 3 }).audioLanguageCode).toBe("en");
  });
  it("does not copy URLs, paths, HTTP headers or session fields from the payload", () => {
    const marker = "SYNTHETIC_DO_NOT_COPY";
    const value = info([textStream(2, {
      DeliveryUrl: `/Stream.vtt?api_key=${marker}`, Path: `/private/${marker}.srt`,
    })]);
    Object.assign(value, { AccessToken: marker, PlaySessionId: marker });
    Object.assign(value.MediaSources[0], {
      TranscodingUrl: `/stream?api_key=${marker}`, HttpHeaders: { Authorization: marker },
    });
    expect(JSON.stringify(snapshot(value))).not.toContain(marker);
  });
  it("does not mistake image or unknown codecs for usable text", () => {
    const result = snapshot(info([
      textStream(2, { Codec: "pgssub", IsTextSubtitleStream: true }),
      textStream(3, { Codec: "dvd_subtitle", IsTextSubtitleStream: false }),
      textStream(4, { Codec: "future-format", IsTextSubtitleStream: undefined }),
      textStream(5, { Codec: "subrip", IsTextSubtitleStream: false }),
    ]));
    expect(result.tracks).toEqual([]);
    expect(result.imageSubtitleCount).toBe(2);
    expect(result.unsupportedSubtitleCount).toBe(2);
  });
  it("allows a known text codec when an older response omits the derived flag", () => {
    expect(snapshot(info([textStream(2, { IsTextSubtitleStream: undefined })])).tracks).toHaveLength(1);
  });
  it("does not derive a language from an English display title", () => {
    const result = snapshot(info([textStream(2, { Language: null, DisplayTitle: "Japanese SDH" })]));
    expect(result.tracks[0].languageCode).toBe("und");
    expect(result.tracks[0].name).toBe("Japanese SDH");
  });
  it("bounds labels and removes control characters", () => {
    const name = snapshot(info([textStream(2, { DisplayTitle: "\u0000" + "x".repeat(400) })])).tracks[0].name;
    expect(name).toHaveLength(200);
    expect(name).not.toContain("\u0000");
  });
  it("marks selected burned-in subtitles so a reader can refuse takeover", () => {
    const result = snapshot(info([textStream(2, { DeliveryMethod: "Encode" })]), { ...CONTEXT, subtitleStreamIndex: 2 });
    expect(result.selectedSubtitleBurnedIn).toBe(true);
  });
  it("honors a default burned-in subtitle, but not when subtitles were explicitly disabled", () => {
    const value = info([textStream(2, { DeliveryMethod: "Encode" })]);
    Object.assign(value.MediaSources[0], { DefaultSubtitleStreamIndex: 2 });
    expect(snapshot(value).selectedSubtitleBurnedIn).toBe(true);
    expect(snapshot(value, { ...CONTEXT, subtitleStreamIndex: -1 }).selectedSubtitleBurnedIn).toBe(false);
  });
  it.each([-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1])("requires a valid playback generation %j", (playbackEpoch) => {
    expect(readJellyfinPlaybackInfo(info(), { ...CONTEXT, playbackEpoch }))
      .toEqual({ ok: false, reason: "invalid-context" });
  });
  it("distinguishes a legitimate captionless file from malformed stream metadata", () => {
    expect(snapshot(info([])).tracks).toEqual([]);
    expect(readJellyfinPlaybackInfo({ MediaSources: [{ Id: "source-a" }] }, CONTEXT))
      .toEqual({ ok: false, reason: "invalid-playback-info" });
  });
  it.each([-1, 1.5, NaN, Infinity, "2", 2 ** 32])("rejects a bad subtitle stream index %j", (Index) => {
    expect(readJellyfinPlaybackInfo(info([textStream(2, { Index })]), CONTEXT))
      .toEqual({ ok: false, reason: "invalid-playback-info" });
  });
  it("rejects duplicate subtitle indices instead of aliasing tracks", () => {
    expect(readJellyfinPlaybackInfo(info([textStream(2), textStream(2)]), CONTEXT))
      .toEqual({ ok: false, reason: "invalid-playback-info" });
  });
  it.each([null, [], {}, { MediaSources: null }, { MediaSources: [], ErrorCode: "NotAllowed" }])("rejects malformed playback info %j", (value) => {
    expect(readJellyfinPlaybackInfo(value, CONTEXT).ok).toBe(false);
  });
  it("rejects a context with an invalid item or selected stream", () => {
    expect(readJellyfinPlaybackInfo(info(), { ...CONTEXT, itemId: "../escape" }))
      .toEqual({ ok: false, reason: "invalid-context" });
    expect(readJellyfinPlaybackInfo(info(), { ...CONTEXT, audioStreamIndex: -2 }))
      .toEqual({ ok: false, reason: "invalid-context" });
  });
  it("keeps subtitles available when there is explicitly no selected audio stream", () => {
    const result = snapshot(info(), { ...CONTEXT, audioStreamIndex: -1 });
    expect(result.audioLanguageCode).toBeUndefined();
    expect(result.tracks).toHaveLength(1);
  });
});