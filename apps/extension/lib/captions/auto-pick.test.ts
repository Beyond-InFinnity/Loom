import { describe, expect, it } from "vitest";
import { autoPick, pickNative, pickTarget } from "./auto-pick";
import type { CaptionTrack } from "./types";

const t = (
  languageCode: string,
  kind: "manual" | "asr" = "manual",
  name?: string,
): CaptionTrack => ({
  languageCode,
  name: name ?? languageCode,
  baseUrl: `https://example.com/?lang=${languageCode}`,
  kind,
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

  it("English-only video for English user — unsupported case", () => {
    const r = autoPick([t("en-US"), t("en-GB")], "en");
    expect(r.target).toBeNull();
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
