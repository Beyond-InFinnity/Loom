// Corpus capture + consent (CORPUS_WIRING.md §1g).
//
// Pure layers tested directly (payload builder, consent resolution, title/
// media-id helpers).  The consent store runs against a minimal in-memory
// browser.storage stub; captureTracks runs against a mocked api-client to
// lock the sent-set dedup + skip semantics.  NOTE: under vitest the env
// defines are absent, so IS_DEV resolves true → unset consent resolves to
// capture-ON (the dev-build default).  Tests account for that explicitly.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptionEvent, CaptionTrack } from "../captions/types";

const postMock = vi.fn(async (_path: string, _init?: unknown) => ({
  data: { stored: true },
  error: undefined,
}));
vi.mock("../api-client", () => ({
  getApiClient: () => ({ POST: postMock }),
}));

import {
  buildCapturePayload,
  captureTracks,
  cleanTitle,
  resolveMediaId,
  sentKey,
  _resetSentForTests,
} from "./capture";
import {
  getCorpusAsked,
  getCorpusConsent,
  markCorpusAsked,
  resolveCaptureEnabled,
  setCorpusConsent,
  _resetConsentStateForTests,
  STORAGE_KEY_CORPUS_ASKED,
  STORAGE_KEY_CORPUS_OPT_IN,
} from "./consent";

// ---- In-memory browser.storage stub ---------------------------------

function installFakeBrowser(): Record<string, unknown> {
  const store: Record<string, unknown> = {};
  const listeners: Array<(changes: unknown, area: string) => void> = [];
  (globalThis as Record<string, unknown>).browser = {
    storage: {
      local: {
        get: async (key: string) =>
          key in store ? { [key]: store[key] } : {},
        set: async (obj: Record<string, unknown>) => {
          const changes: Record<string, { newValue: unknown }> = {};
          for (const [k, v] of Object.entries(obj)) {
            store[k] = v;
            changes[k] = { newValue: v };
          }
          listeners.forEach((l) => l(changes, "local"));
        },
      },
      onChanged: {
        addListener: (l: (changes: unknown, area: string) => void) => {
          listeners.push(l);
        },
      },
    },
  };
  return store;
}

const track = (over: Partial<CaptionTrack> = {}): CaptionTrack => ({
  id: "ja-manual-std",
  languageCode: "ja",
  name: "Japanese",
  baseUrl: "https://example.com/?lang=ja",
  kind: "manual",
  ...over,
});

const ev = (start: number, end: number, text: string): CaptionEvent => ({
  start,
  end,
  text,
});

const ctx = {
  platform: "netflix",
  videoId: "81234567",
  title: "Frieren - Netflix",
  pathname: "/watch/81234567",
};

beforeEach(() => {
  installFakeBrowser();
  _resetConsentStateForTests();
  _resetSentForTests();
  postMock.mockClear();
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).browser;
});

// ---- resolveCaptureEnabled -------------------------------------------

describe("resolveCaptureEnabled", () => {
  it("unset → follows the build default (dev on, prod off)", () => {
    expect(resolveCaptureEnabled(null, true)).toBe(true);
    expect(resolveCaptureEnabled(null, false)).toBe(false);
  });

  it("an explicit answer beats the build default in both directions", () => {
    expect(resolveCaptureEnabled(false, true)).toBe(false);
    expect(resolveCaptureEnabled(true, false)).toBe(true);
  });
});

// ---- consent store ----------------------------------------------------

describe("consent store", () => {
  it("defaults to unset / not-asked", async () => {
    expect(await getCorpusConsent()).toBeNull();
    expect(await getCorpusAsked()).toBe(false);
  });

  it("an explicit answer persists and marks asked", async () => {
    await setCorpusConsent(false);
    expect(await getCorpusConsent()).toBe(false);
    expect(await getCorpusAsked()).toBe(true);
  });

  it("markCorpusAsked alone leaves consent unset", async () => {
    await markCorpusAsked();
    expect(await getCorpusAsked()).toBe(true);
    expect(await getCorpusConsent()).toBeNull();
  });

  it("garbage stored values coerce to unset, not truthy", async () => {
    const store = installFakeBrowser();
    _resetConsentStateForTests();
    store[STORAGE_KEY_CORPUS_OPT_IN] = "yes";
    store[STORAGE_KEY_CORPUS_ASKED] = "yes";
    expect(await getCorpusConsent()).toBeNull();
    expect(await getCorpusAsked()).toBe(false);
  });

  it("cross-context writes propagate via storage.onChanged", async () => {
    expect(await getCorpusConsent()).toBeNull(); // prime cache + watcher
    // Simulate the onboarding page (another context) writing through the
    // same storage area.
    await (globalThis as any).browser.storage.local.set({
      [STORAGE_KEY_CORPUS_OPT_IN]: true,
    });
    expect(await getCorpusConsent()).toBe(true);
  });
});

// ---- payload builder ---------------------------------------------------

describe("buildCapturePayload", () => {
  it("maps events to seq/start_ms/end_ms/text with rounding + clamping", () => {
    const body = buildCapturePayload(ctx, track(), [
      ev(0.4, 900.6, "こんにちは"),
      ev(-5, 1900, "ありがとう"),
    ]);
    expect(body.lines).toEqual([
      { seq: 0, start_ms: 0, end_ms: 901, text: "こんにちは" },
      { seq: 1, start_ms: 0, end_ms: 1900, text: "ありがとう" },
    ]);
    expect(body.opt_in_training).toBe(true);
    expect(body.platform).toBe("netflix");
    expect(body.media_id).toBe("81234567");
    expect(body.track_id).toBe("ja-manual-std");
    expect(body.track_lang).toBe("ja");
    expect(body.track_kind).toBe("manual");
    expect(body.is_cc).toBe(false);
  });

  it("preserves original indices as seq when dropping bad lines", () => {
    const body = buildCapturePayload(ctx, track(), [
      ev(0, 900, "a"),
      ev(1000, 1900, ""), // empty → dropped
      ev(2000, 2900, "x".repeat(6000)), // oversized → dropped (would 422 the whole request)
      ev(3000, 3900, "b"),
    ]);
    expect(body.lines.map((l) => l.seq)).toEqual([0, 3]);
  });

  it("carries track metadata: audioLangCode → origin_lang, isCc, cleaned title", () => {
    const body = buildCapturePayload(
      ctx,
      track({ audioLangCode: "ja", isCc: true }),
      [ev(0, 1, "a")],
    );
    expect(body.origin_lang).toBe("ja");
    expect(body.is_cc).toBe(true);
    expect(body.title).toBe("Frieren");
  });
});

describe("cleanTitle / resolveMediaId", () => {
  it("strips platform suffixes and trims", () => {
    expect(cleanTitle("Frieren - YouTube")).toBe("Frieren");
    expect(cleanTitle("玉骨遥 | WeTV")).toBe("玉骨遥");
    expect(cleanTitle("  Plain title  ")).toBe("Plain title");
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });

  it("media id: videoId wins, pathname is the fallback", () => {
    expect(resolveMediaId("abc123", "/watch")).toBe("abc123");
    expect(resolveMediaId(null, "/play/xyz")).toBe("/play/xyz");
    expect(resolveMediaId("  ", "/play/xyz")).toBe("/play/xyz");
    expect(resolveMediaId(null, "")).toBe("/");
  });
});

// ---- captureTracks: consent gate + sent-set dedup ----------------------

describe("captureTracks", () => {
  // vitest runs with IS_DEV=true (env defines absent) → unset consent
  // resolves to capture-ON, matching a dev build.

  it("POSTs once per (platform, media, track); repeats are deduped", async () => {
    const entries = [{ track: track(), events: [ev(0, 900, "a")] }];
    await captureTracks(ctx, entries);
    await captureTracks(ctx, entries);
    expect(postMock).toHaveBeenCalledTimes(1);
    expect(postMock.mock.calls[0][0]).toBe("/corpus/capture");
  });

  it("different tracks on the same media each capture", async () => {
    await captureTracks(ctx, [
      { track: track(), events: [ev(0, 900, "a")] },
      { track: track({ id: "en-manual-std", languageCode: "en" }), events: [ev(0, 900, "b")] },
    ]);
    expect(postMock).toHaveBeenCalledTimes(2);
  });

  it("explicit opt-out stops all captures even in dev", async () => {
    await setCorpusConsent(false);
    await captureTracks(ctx, [{ track: track(), events: [ev(0, 900, "a")] }]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("empty event lists are skipped without consuming the dedup key", async () => {
    await captureTracks(ctx, [{ track: track(), events: [] }]);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sentKey is platform+media+track scoped", () => {
    expect(sentKey(ctx, track())).toBe("netflix::81234567::ja-manual-std");
  });
});
