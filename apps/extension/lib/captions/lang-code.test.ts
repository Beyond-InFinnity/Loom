import { describe, expect, it } from "vitest";
import {
  baseLang,
  canonicalBaseLang,
  parseBcp47,
  resolveScript,
} from "./lang-code";

describe("parseBcp47", () => {
  it("parses a bare 2-letter language", () => {
    expect(parseBcp47("en")).toEqual({
      raw: "en",
      language: "en",
      script: null,
      region: null,
    });
  });

  it("parses language + region", () => {
    expect(parseBcp47("en-US")).toEqual({
      raw: "en-US",
      language: "en",
      script: null,
      region: "US",
    });
  });

  it("uppercases lowercase region subtags", () => {
    expect(parseBcp47("en-gb").region).toBe("GB");
  });

  it("preserves 3-digit UN M.49 regions", () => {
    expect(parseBcp47("es-419").region).toBe("419");
  });

  it("parses language + script", () => {
    expect(parseBcp47("zh-Hans")).toEqual({
      raw: "zh-Hans",
      language: "zh",
      script: "Hans",
      region: null,
    });
  });

  it("title-cases lowercase script subtags", () => {
    expect(parseBcp47("zh-hant").script).toBe("Hant");
  });

  it("parses language + script + region", () => {
    expect(parseBcp47("zh-Hans-CN")).toEqual({
      raw: "zh-Hans-CN",
      language: "zh",
      script: "Hans",
      region: "CN",
    });
  });

  it("parses 3-letter ISO 639-3 base", () => {
    expect(parseBcp47("yue-HK")).toEqual({
      raw: "yue-HK",
      language: "yue",
      script: null,
      region: "HK",
    });
  });

  it("returns empty fields on empty input", () => {
    expect(parseBcp47("")).toEqual({
      raw: "",
      language: "",
      script: null,
      region: null,
    });
  });

  it("disambiguates by shape, not position", () => {
    // Hypothetical out-of-order tag — script in trailing position.
    // Real BCP-47 forbids this but we should not crash.
    const parsed = parseBcp47("en-US-Latn");
    expect(parsed.language).toBe("en");
    expect(parsed.region).toBe("US");
    expect(parsed.script).toBe("Latn");
  });
});

describe("resolveScript", () => {
  it("trusts explicit script subtag", () => {
    expect(resolveScript(parseBcp47("sr-Latn"))).toBe("Latn");
    expect(resolveScript(parseBcp47("sr-Cyrl"))).toBe("Cyrl");
  });

  it("defaults zh to Hans (mainland convention)", () => {
    expect(resolveScript(parseBcp47("zh"))).toBe("Hans");
    expect(resolveScript(parseBcp47("zh-CN"))).toBe("Hans");
  });

  it("upgrades zh-TW/HK/MO to Hant", () => {
    expect(resolveScript(parseBcp47("zh-TW"))).toBe("Hant");
    expect(resolveScript(parseBcp47("zh-HK"))).toBe("Hant");
    expect(resolveScript(parseBcp47("zh-MO"))).toBe("Hant");
  });

  it("resolves CJK defaults", () => {
    expect(resolveScript(parseBcp47("ja"))).toBe("Jpan");
    expect(resolveScript(parseBcp47("ko"))).toBe("Kore");
    expect(resolveScript(parseBcp47("yue"))).toBe("Hant");
  });

  it("resolves Cyrillic defaults", () => {
    expect(resolveScript(parseBcp47("ru"))).toBe("Cyrl");
    expect(resolveScript(parseBcp47("uk"))).toBe("Cyrl");
    expect(resolveScript(parseBcp47("sr"))).toBe("Cyrl");
  });

  it("resolves Hebrew / Arabic family defaults", () => {
    expect(resolveScript(parseBcp47("he"))).toBe("Hebr");
    expect(resolveScript(parseBcp47("ar"))).toBe("Arab");
    expect(resolveScript(parseBcp47("fa"))).toBe("Arab");
    expect(resolveScript(parseBcp47("ur"))).toBe("Arab");
  });

  it("resolves Indic defaults", () => {
    expect(resolveScript(parseBcp47("hi"))).toBe("Deva");
    expect(resolveScript(parseBcp47("bn"))).toBe("Beng");
    expect(resolveScript(parseBcp47("ta"))).toBe("Taml");
  });

  it("falls back to Latn for unknown / long-tail languages", () => {
    // Every Roman-alphabet language not in the override table —
    // this is the "free" addition path.
    expect(resolveScript(parseBcp47("de"))).toBe("Latn");
    expect(resolveScript(parseBcp47("fr"))).toBe("Latn");
    expect(resolveScript(parseBcp47("es"))).toBe("Latn");
    expect(resolveScript(parseBcp47("pt"))).toBe("Latn");
    expect(resolveScript(parseBcp47("vi"))).toBe("Latn");
    expect(resolveScript(parseBcp47("tr"))).toBe("Latn");
    expect(resolveScript(parseBcp47("fil"))).toBe("Latn");
    expect(resolveScript(parseBcp47("sw"))).toBe("Latn");
    expect(resolveScript(parseBcp47("haw"))).toBe("Latn"); // long-tail Hawaiian
  });
});

describe("baseLang / canonicalBaseLang", () => {
  it("lowercases and returns the base subtag", () => {
    expect(baseLang("EN-US")).toBe("en");
    expect(baseLang("Zh-Hant")).toBe("zh");
  });

  it("canonicalizes deprecated codes", () => {
    expect(canonicalBaseLang("iw")).toBe("he"); // Hebrew old code
    expect(canonicalBaseLang("iw-IL")).toBe("he");
    expect(canonicalBaseLang("in")).toBe("id"); // Indonesian old code
    expect(canonicalBaseLang("ji")).toBe("yi"); // Yiddish old code
  });

  it("passes through current codes", () => {
    expect(canonicalBaseLang("he")).toBe("he");
    expect(canonicalBaseLang("ja-JP")).toBe("ja");
  });
});
