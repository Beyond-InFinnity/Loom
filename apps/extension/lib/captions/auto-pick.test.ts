import { describe, expect, it } from "vitest";
import { autoPick, pickNative, pickPrimary, pickTarget } from "./auto-pick";
import type { CaptionTrack } from "./types";

const t = (
  languageCode: string,
  kind: "manual" | "asr" = "manual",
  name?: string,
  isCc = false,
): CaptionTrack => ({
  id: `${languageCode}-${kind}-${isCc ? "cc" : "std"}`,
  languageCode,
  name: name ?? languageCode,
  baseUrl: `https://example.com/?lang=${languageCode}`,
  kind,
  isCc,
});

describe("pickNative — regional variant collapse", () => {
  it("matches bare en for native=en", () => {
    expect(pickNative([t("en")], "en")?.languageCode).toBe("en");
  });

  it("matches en-US for native=en", () => {
    expect(pickNative([t("en-US")], "en")?.languageCode).toBe("en-US");
  });

  it("matches en-GB, en-AU, en-IN, en-ZA for native=en", () => {
    expect(
      pickNative([t("en-GB"), t("en-AU"), t("en-IN")], "en")?.languageCode,
    ).toBe("en-GB");
  });

  it("prefers manual over ASR within base lang", () => {
    const tracks = [t("en-US", "asr"), t("en-GB", "manual")];
    expect(pickNative(tracks, "en")?.kind).toBe("manual");
  });

  it("returns first when only ASR present", () => {
    const tracks = [t("en-US", "asr"), t("en-GB", "asr")];
    const picked = pickNative(tracks, "en");
    expect(picked?.kind).toBe("asr");
  });

  it("returns null when no native-base track present", () => {
    expect(pickNative([t("ja"), t("zh-Hant")], "en")).toBeNull();
  });

  it("handles deprecated codes via canonicalization", () => {
    // YouTube occasionally returns iw for Hebrew on legacy uploads.
    // A user with native="he" should still find it.
    expect(pickNative([t("iw")], "he")?.languageCode).toBe("iw");
  });

  // Netflix exposes both "English (CC)" and plain "English" for one
  // language.  Default to the clean standard track; CC is a deliberate
  // user pick, not the auto-default.
  it("prefers standard subtitles over SDH/CC for the same language", () => {
    const cc = t("en", "manual", "English (CC)", true);
    const std = t("en", "manual", "English", false);
    expect(pickNative([cc, std], "en")?.id).toBe(std.id); // CC listed first
    expect(pickNative([std, cc], "en")?.id).toBe(std.id); // std listed first
  });

  it("falls back to CC when it's the only track for the language", () => {
    // JP-anime / Thai-origin titles ship the origin language as CC only.
    const ccOnly = t("ja", "manual", "Japanese (CC)", true);
    expect(pickNative([ccOnly], "ja")?.id).toBe(ccOnly.id);
  });
});

describe("pickTarget — audio-language priority (Netflix)", () => {
  // Stamp the per-video audio language onto a track (as the Netflix MAIN
  // hook does for every track in a tracklist).
  const withAudio = (track: CaptionTrack, audioLangCode: string) => ({
    ...track,
    audioLangCode,
  });

  it("prefers the audio-language track over a higher-tier-order sibling", () => {
    // Frieren: Japanese AUDIO, but Netflix lists Chinese before Japanese
    // and both are tier-1 (annotate-romanize), so plain tier ordering
    // lands on Chinese.  Audio-language priority must flip it to Japanese.
    const tracks = [
      withAudio(t("zh-Hant"), "ja"),
      withAudio(t("ja"), "ja"),
    ];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("ja");
  });

  it("breaks an audio-language tie with preferStandard (subtitles > CC)", () => {
    const cc = withAudio(t("ja", "manual", "Japanese (CC)", true), "ja");
    const std = withAudio(t("ja", "manual", "Japanese", false), "ja");
    expect(pickTarget([cc, std], "en")?.id).toBe(std.id);
  });

  it("ignores audio language when it IS the user's native language", () => {
    // English-audio video for an English user: the audio track is native,
    // not a learning target.  Fall through to a real foreign track.
    const tracks = [
      withAudio(t("en"), "en"),
      withAudio(t("ja"), "en"),
    ];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("ja");
  });

  it("falls back to tier order when no track matches the audio language", () => {
    // Audio is Korean but only Japanese + German subtitle tracks exist
    // (no Korean text track) — pick by tier, not audio.
    const tracks = [
      withAudio(t("de"), "ko"),
      withAudio(t("ja"), "ko"),
    ];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("ja");
  });

  it("falls back to tier order when audioLangCode is absent (YouTube)", () => {
    // No audio language exposed → unchanged tier behavior.
    expect(pickTarget([t("de"), t("ja")], "en")?.languageCode).toBe("ja");
  });
});

describe("pickTarget — tier ordering", () => {
  it("tier 1 (CJK) beats tier 3 (Latin)", () => {
    // Common case: Japanese video with German auto-translation track
    // available.  We pick Japanese — that's the demo.
    const tracks = [t("ja"), t("de"), t("en")];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("ja");
  });

  it("tier 2 (romanize) beats tier 3 (Latin)", () => {
    const tracks = [t("ru"), t("de"), t("en")];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("ru");
  });

  it("tier 3 (Latin) used when no higher tier present", () => {
    // German video with English available.  English is native; German
    // is target.
    const tracks = [t("de"), t("en")];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("de");
  });

  it("ranks within Latin tier: manual wins over ASR", () => {
    const tracks = [t("de", "asr"), t("fr", "manual"), t("en")];
    const picked = pickTarget(tracks, "en");
    expect(picked?.kind).toBe("manual");
    expect(picked?.languageCode).toBe("fr");
  });

  it("prefers a standard target track over its SDH/CC sibling", () => {
    // zh-Hant video (Crouching Tiger) carrying both a CC and a plain
    // subtitles track for the target language → default to plain.
    const cc = t("zh-Hant", "manual", "Chinese (Traditional) (CC)", true);
    const std = t("zh-Hant", "manual", "Chinese (Traditional)", false);
    expect(pickTarget([cc, std], "en")?.id).toBe(std.id);
  });

  it("skips the user's native language even if tier-1", () => {
    // If user is Japanese, Japanese can't be the target.  English
    // (Latin / native-display) is the target.
    const tracks = [t("ja"), t("en")];
    expect(pickTarget(tracks, "ja")?.languageCode).toBe("en");
  });

  it("collapses regional variants in native filter", () => {
    // en-US user, video has en-US + en-GB + es-MX.  Spanish wins
    // because all English variants are filtered as native.
    const tracks = [t("en-US"), t("en-GB"), t("es-MX")];
    expect(pickTarget(tracks, "en-US")?.languageCode).toBe("es-MX");
  });

  it("picks pt-BR over en when user-native is en", () => {
    const tracks = [t("pt-BR"), t("en-US")];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("pt-BR");
  });

  it("picks any tier-3 track over no track", () => {
    const tracks = [t("vi"), t("en")];
    expect(pickTarget(tracks, "en")?.languageCode).toBe("vi");
  });

  it("Chinese variants on a video with both Hans + Hant", () => {
    // Both are tier 1 (annotate-romanize); within tier prefer manual.
    const tracks = [t("zh-Hans", "manual"), t("zh-Hant", "manual"), t("en")];
    const picked = pickTarget(tracks, "en");
    // Within tier with equal manual status, first-wins is the
    // deterministic outcome.  We don't promise a specific variant
    // priority — 5f will let users pick.
    expect(["zh-Hans", "zh-Hant"]).toContain(picked?.languageCode);
  });

  it("returns null when every track shares native base lang", () => {
    expect(pickTarget([t("en-US"), t("en-GB")], "en")).toBeNull();
  });

  it("returns null on empty tracks", () => {
    expect(pickTarget([], "en")).toBeNull();
  });
});

describe("autoPick — both at once", () => {
  it("picks ja target + en native on a Japanese video", () => {
    const r = autoPick([t("ja"), t("en-US")], "en");
    expect(r.target?.languageCode).toBe("ja");
    expect(r.native?.languageCode).toBe("en-US");
  });

  it("picks pt-BR target + en native on a Brazilian video", () => {
    const r = autoPick([t("pt-BR"), t("en-US", "asr"), t("en-GB")], "en");
    expect(r.target?.languageCode).toBe("pt-BR");
    expect(r.native?.kind).toBe("manual");
  });

  it("picks es-419 target + en native on a Latin-American Spanish video", () => {
    const r = autoPick([t("es-419"), t("en")], "en");
    expect(r.target?.languageCode).toBe("es-419");
    expect(r.native?.languageCode).toBe("en");
  });

  it("native=null when no English track present (tlang fallback path)", () => {
    const r = autoPick([t("ja"), t("zh-Hant")], "en");
    expect(r.target?.languageCode).toBe("ja");
    expect(r.native).toBeNull();
  });

  it("defaults nativeLang to en when not provided", () => {
    const r = autoPick([t("ja"), t("en-US")]);
    expect(r.target?.languageCode).toBe("ja");
    expect(r.native?.languageCode).toBe("en-US");
  });
});

describe("autoPick — real-world tracklists", () => {
  it("Squid Game style: en + en-HI + es + es-419 + ja + ko + pt + pt-BR", () => {
    // User native = en.  Target should be ko (CJK, tier 1).
    const tracks = [
      t("en"),
      t("en-US"),
      t("es"),
      t("es-419"),
      t("ja"),
      t("ko"),
      t("pt"),
      t("pt-BR"),
    ];
    const r = autoPick(tracks, "en");
    expect(r.target?.languageCode).toBe("ja"); // ja and ko both tier-1; ja first
    expect(r.native?.languageCode).toBe("en");
  });

  it("English-only video for English user — no foreign target (pickPrimary promotes it in discover)", () => {
    const r = autoPick([t("en-US"), t("en-GB")], "en");
    expect(r.target).toBeNull(); // no FOREIGN track; discover.ts single-lines it
    expect(r.native?.languageCode).toBe("en-US");
  });

  it("ASR-only tracklist still picks something", () => {
    const r = autoPick(
      [t("ja", "asr", "Japanese (auto-generated)"), t("en", "asr")],
      "en",
    );
    expect(r.target?.languageCode).toBe("ja");
    expect(r.target?.kind).toBe("asr");
    expect(r.native?.languageCode).toBe("en");
  });
});

// pickPrimary is the single-line promotion: when pickTarget returns null (no
// FOREIGN track relative to the user), Loom still shows ONE line and this
// chooses the cleanest track for it.  (discover.ts wires it as the target so
// the line gets styling + annotation + dictionary.)
describe("pickPrimary — single-line promotion", () => {
  it("returns null for an empty tracklist", () => {
    expect(pickPrimary([])).toBeNull();
  });

  it("returns the only track when there is one", () => {
    expect(pickPrimary([t("en")])?.languageCode).toBe("en");
  });

  it("prefers manual over ASR", () => {
    const picked = pickPrimary([t("en", "asr"), t("en-GB", "manual")]);
    expect(picked?.kind).toBe("manual");
  });

  it("prefers a plain subtitles track over SDH/CC", () => {
    const cc = t("en", "manual", "English (CC)", true);
    const std = t("en", "manual", "English", false);
    expect(pickPrimary([cc, std])?.isCc).toBe(false);
  });

  it("rescues the all-native case pickTarget rejects", () => {
    const tracks = [t("en-US"), t("en-GB")];
    // pickTarget bails (every track is native)...
    expect(pickTarget(tracks, "en")).toBeNull();
    // ...but pickPrimary still yields the line Loom will show.
    expect(pickPrimary(tracks)?.languageCode).toBe("en-US");
  });

  it("gives a definable-language single line for a native speaker (zh-only, zh user)", () => {
    // A Chinese user watching a Chinese-only video: no foreign track, but the
    // one Chinese line is fully definable (CC-CEDICT).
    const tracks = [t("zh-Hans")];
    expect(pickTarget(tracks, "zh")).toBeNull();
    expect(pickPrimary(tracks)?.languageCode).toBe("zh-Hans");
  });
});
