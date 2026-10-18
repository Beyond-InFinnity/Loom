import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJellyfinPlaybackInfo, type JellyfinPlaybackSnapshot } from "./metadata";
import { buildJellyfinVttRequest, jellyfinCaptionTimeMs, JELLYFIN_SUBTITLE_TIMEOUT_MS, readJellyfinSubtitle } from "./subtitles";

function makeSnapshot(mediaSourceId = "source-a", burnedIn = false): JellyfinPlaybackSnapshot {
  const result = readJellyfinPlaybackInfo({ MediaSources: [{
    Id: mediaSourceId, MediaStreams: [
      { Type: "Subtitle", Index: 2, Codec: "subrip", Language: "jpn", DeliveryMethod: burnedIn ? "Encode" : "External" },
      { Type: "Subtitle", Index: 5, Codec: "webvtt", Language: "eng", IsExternal: true },
    ],
  }] }, {
    serverBaseUrl: "https://media.example.test:8443/jellyfin/",
    itemId: "0123456789abcdef0123456789abcdef", mediaSourceId, subtitleStreamIndex: 2, playbackEpoch: 1,
  });
  if (!result.ok) throw new Error(result.reason);
  return result.snapshot;
}
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<i>日本語</i> &amp; text\n\n00:00:03.500 --> 00:00:05.000\nSecond line\n";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("Jellyfin VTT request boundary", () => {
  it("builds a credential-free full-timeline route under the chosen base path", () => {
    const snapshot = makeSnapshot();
    const request = buildJellyfinVttRequest(snapshot, snapshot.tracks[0].id);
    expect(request).toEqual({
      method: "GET",
      url: "https://media.example.test:8443/jellyfin/Videos/0123456789abcdef0123456789abcdef/source-a/Subtitles/2/0/Stream.vtt?copyTimestamps=true",
    });
    expect(Object.keys(request!)).toEqual(["method", "url"]);
    expect(Object.isFrozen(request)).toBe(true);
  });
  it("addresses each subtitle stream without changing the selected media source", () => {
    const snapshot = makeSnapshot();
    expect(buildJellyfinVttRequest(snapshot, snapshot.tracks[1].id)?.url).toContain("/source-a/Subtitles/5/0/Stream.vtt");
  });
  it("rejects arbitrary URL-like requests and a track from another media source", () => {
    const snapshot = makeSnapshot();
    expect(buildJellyfinVttRequest(snapshot, "https://other.example.test/private")).toBeNull();
    expect(buildJellyfinVttRequest(snapshot, makeSnapshot("source-b").tracks[0].id)).toBeNull();
  });
  it("rejects a tampered snapshot identity or mismatched stream index", () => {
    const snapshot = makeSnapshot();
    expect(buildJellyfinVttRequest({ ...snapshot, identity: { ...snapshot.identity, mediaSourceId: "../escape" } }, snapshot.tracks[0].id)).toBeNull();
    expect(buildJellyfinVttRequest({ ...snapshot, tracks: [{ ...snapshot.tracks[0], streamIndex: 99 }] }, snapshot.tracks[0].id)).toBeNull();
  });
});

describe("Jellyfin read-only subtitle acquisition", () => {
  let snapshot: JellyfinPlaybackSnapshot;
  let controller: AbortController;
  let currentKey: string | null;
  let currentEpoch: number | null;
  let active: boolean;
  const transport = vi.fn();
  function options() {
    return {
      signal: controller.signal, currentPlaybackKey: () => currentKey,
      currentPlaybackEpoch: () => currentEpoch, isActive: () => active, transport,
    };
  }
  const read = () => readJellyfinSubtitle(snapshot, snapshot.tracks[0].id, options());
  beforeEach(() => {
    vi.useFakeTimers();
    snapshot = makeSnapshot();
    controller = new AbortController();
    currentKey = snapshot.identity.key;
    currentEpoch = snapshot.playbackEpoch;
    active = true;
    transport.mockReset().mockResolvedValue({ status: 200, body: VTT });
  });
  afterEach(() => {
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("parses original millisecond timestamps and safe text through the existing parser", async () => {
    expect(await read()).toEqual({ ok: true, status: 200, events: [
      { start: 1000, end: 3000, text: "日本語 & text" },
      { start: 3500, end: 5000, text: "Second line" },
    ] });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
  });
  it("does not dispatch when already cancelled", async () => {
    controller.abort();
    expect(await read()).toEqual({ ok: false, reason: "aborted" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not dispatch when switched off before the dispatch microtask", async () => {
    const pending = read();
    active = false;
    expect(await pending).toEqual({ ok: false, reason: "inactive" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not dispatch after cancellation in the dispatch window", async () => {
    const pending = read();
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not dispatch an inactive or stale session", async () => {
    active = false;
    expect(await read()).toEqual({ ok: false, reason: "inactive" });
    active = true;
    currentKey = makeSnapshot("source-b").identity.key;
    expect(await read()).toEqual({ ok: false, reason: "stale-playback" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not use a VTT overlay to claim it can erase already-burned-in captions", async () => {
    snapshot = makeSnapshot("source-a", true);
    expect(await read()).toEqual({ ok: false, reason: "burned-in" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not dispatch an unknown track", async () => {
    expect(await readJellyfinSubtitle(snapshot, "absent", options())).toEqual({ ok: false, reason: "unknown-track" });
    expect(transport).not.toHaveBeenCalled();
  });
  it("drops late text after an episode or media-source change", async () => {
    const response = deferred<{ status: number; body: string }>();
    transport.mockReturnValue(response.promise);
    const pending = read();
    await Promise.resolve();
    expect(transport).toHaveBeenCalledTimes(1);
    currentKey = makeSnapshot("source-b").identity.key;
    response.resolve({ status: 200, body: VTT });
    expect(await pending).toEqual({ ok: false, reason: "stale-playback" });
  });
  it("does not publish after the user disables Loom while a read is in flight", async () => {
    const response = deferred<{ status: number; body: string }>();
    transport.mockReturnValue(response.promise);
    const pending = read();
    await Promise.resolve();
    active = false;
    response.resolve({ status: 200, body: VTT });
    expect(await pending).toEqual({ ok: false, reason: "inactive" });
  });
  it("rejects a late read after leaving and returning to the exact same item/source", async () => {
    const response = deferred<{ status: number; body: string }>();
    transport.mockReturnValue(response.promise);
    const pending = read();
    await Promise.resolve();
    // Stable identity is the same again, but this is a new playback session.
    currentEpoch = 3;
    response.resolve({ status: 200, body: VTT });
    expect(await pending).toEqual({ ok: false, reason: "stale-playback" });
  });
  it("settles immediately on abort even when the transport ignores cancellation", async () => {
    transport.mockReturnValue(new Promise(() => {}));
    const pending = read();
    await Promise.resolve();
    const sentSignal = transport.mock.calls[0][1] as AbortSignal;
    controller.abort();
    expect(await pending).toEqual({ ok: false, reason: "aborted" });
    expect(sentSignal.aborted).toBe(true);
  });
  it("enforces one overall deadline even when the transport never settles", async () => {
    transport.mockReturnValue(new Promise(() => {}));
    const pending = read();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(JELLYFIN_SUBTITLE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    expect((transport.mock.calls[0][1] as AbortSignal).aborted).toBe(true);
  });
  it("never starts a retry after timeout, even if disabled later", async () => {
    transport.mockReturnValue(new Promise(() => {}));
    const pending = read();
    await vi.advanceTimersByTimeAsync(JELLYFIN_SUBTITLE_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
    active = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 429, 500])("reports HTTP %i without echoing server text", async (status) => {
    transport.mockResolvedValue({ status, body: "SYNTHETIC_PRIVATE_ERROR_MARKER" });
    expect(await read()).toEqual({ ok: false, reason: "http", status });
  });
  it("does not echo a transport exception that could contain an authenticated URL", async () => {
    transport.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_ERROR_MARKER"));
    expect(await read()).toEqual({ ok: false, reason: "network" });
  });
  it.each(["<html>login</html>", "not vtt", "WEBVTTbad\n\n", ""])("rejects non-VTT content %j", async (body) => {
    transport.mockResolvedValue({ status: 200, body });
    expect(await read()).toEqual({ ok: false, reason: "invalid-vtt", status: 200 });
  });
  it("recognizes a successfully empty VTT document separately from failure", async () => {
    transport.mockResolvedValue({ status: 200, body: "WEBVTT\n\nNOTE no dialogue\n" });
    expect(await read()).toEqual({ ok: true, status: 200, events: [] });
  });
  it("accepts BOM/CRLF and preserves positioned dialogue cues", async () => {
    transport.mockResolvedValue({ status: 200, body: "\uFEFFWEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000 line:10%\r\nSign\r\n" });
    const result = await read();
    expect(result.ok && result.events[0].layout?.block).toBe("top");
  });
  it("accepts a CR-only WebVTT document", async () => {
    transport.mockResolvedValue({ status: 200, body: VTT.replace(/\n/g, "\r") });
    const result = await read();
    expect(result.ok && result.events.length).toBe(2);
  });
  it("drops reversed and zero-duration cues", async () => {
    transport.mockResolvedValue({ status: 200, body: "WEBVTT\n\n00:00:02.000 --> 00:00:01.000\nReversed\n\n00:00:01.000 --> 00:00:01.000\nZero\n" });
    expect(await read()).toEqual({ ok: true, status: 200, events: [] });
  });
  it("bounds the VTT payload before parsing", async () => {
    transport.mockResolvedValue({ status: 200, body: "WEBVTT\n" + "x".repeat(8 * 1024 * 1024) });
    expect(await read()).toEqual({ ok: false, reason: "invalid-vtt", status: 200 });
  });
  it("removes the caller abort listener on successful completion", async () => {
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await read();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    remove.mockRestore();
  });
});

describe("Jellyfin original-media subtitle clock", () => {
  it.each([
    [10, 0, 0, 10_000],
    [5, 90 * 10_000_000, 0, 95_000],
    [90, 0, 0, 90_000], // HLS may already have absolute time: no guessed resume offset.
    [5, 90 * 10_000_000, 2, 97_000], // Positive subtitle offset displays raw cues earlier.
    [5, 90 * 10_000_000, -2, 93_000],
    [0, 0, -2, -2000], // Do not clamp: a delayed first cue is not active at media time zero.
  ])("maps video=%s offsetTicks=%s subtitleOffset=%s to %s ms", (video, ticks, subtitleOffset, expected) => {
    expect(jellyfinCaptionTimeMs(video, ticks, subtitleOffset)).toBe(expected);
  });
  it.each([
    [NaN, 0, 0], [Infinity, 0, 0], [-1, 0, 0], [1, -1, 0],
    [1, 0.5, 0], [1, Number.MAX_SAFE_INTEGER + 1, 0], [1, 0, Infinity],
    [Number.MAX_VALUE, 0, 0],
  ])("rejects invalid clock input %j", (video, ticks, subtitleOffset) => {
    expect(jellyfinCaptionTimeMs(video, ticks, subtitleOffset)).toBeNull();
  });
});