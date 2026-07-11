import { describe, expect, it, vi } from "vitest";
import { setUiLocaleProvider } from "../i18n/resolve";

import {
  baseLang,
  normalizeDefineSourceLang,
  isDefinable,
  resolveGlossLang,
  glossLangsForSource,
} from "./define-lang";
import type { DefineCapabilities } from "./capabilities";

/** Build a DefineCapabilities for tests without repeating the empty map. */
function mkCaps(
  partial: Partial<DefineCapabilities> & Pick<DefineCapabilities, "sourceLangs" | "glossLangs">,
): DefineCapabilities {
  return { glossLangsBySource: new Map(), ...partial };
}

describe("baseLang", () => {
  it("strips region/script subtags and lowercases", () => {
    expect(baseLang("zh-Hant")).toBe("zh");
    expect(baseLang("en-US")).toBe("en");
    expect(baseLang("JA")).toBe("ja");
    expect(baseLang("ja_JP")).toBe("ja");
  });

  it("is empty for nullish input", () => {
    expect(baseLang(null)).toBe("");
    expect(baseLang(undefined)).toBe("");
    expect(baseLang("")).toBe("");
  });
});

describe("normalizeDefineSourceLang", () => {
  it("maps Japanese to ja", () => {
    expect(normalizeDefineSourceLang("ja")).toBe("ja");
    expect(normalizeDefineSourceLang("ja-JP")).toBe("ja");
    expect(normalizeDefineSourceLang("JA")).toBe("ja");
  });

  it("collapses every Chinese variant (incl. Cantonese) to zh", () => {
    for (const code of ["zh", "zh-Hans", "zh-Hant", "zh-TW", "zh-HK", "yue", "zh_hant", "cmn", "nan"]) {
      expect(normalizeDefineSourceLang(code)).toBe("zh");
    }
  });

  it("passes other languages through as their base subtag (never null)", () => {
    expect(normalizeDefineSourceLang("ko")).toBe("ko");
    expect(normalizeDefineSourceLang("hi-IN")).toBe("hi");
    expect(normalizeDefineSourceLang("")).toBe("");
  });
});

describe("isDefinable", () => {
  const caps: DefineCapabilities = mkCaps({ sourceLangs: new Set(["ja", "zh"]), glossLangs: ["en"] });

  it("is true for languages the server declares", () => {
    expect(isDefinable(caps, "ja")).toBe(true);
    expect(isDefinable(caps, "zh-Hant")).toBe(true);
    expect(isDefinable(caps, "yue")).toBe(true);
  });

  it("is false for languages the server does not declare", () => {
    expect(isDefinable(caps, "ko")).toBe(false);
    expect(isDefinable(caps, "en")).toBe(false);
    expect(isDefinable(caps, null)).toBe(false);
  });

  it("lights up a newly-served language with no code change", () => {
    const withKorean = mkCaps({
      sourceLangs: new Set(["ja", "zh", "ko"]),
      glossLangs: ["en"],
    });
    expect(isDefinable(withKorean, "ko")).toBe(true);
  });
});

describe("resolveGlossLang", () => {
  // Host locale via the LocaleProvider seam (the extension registers
  // browser.i18n.getUILanguage; tests stub the provider directly).
  const uiLang = (code: string) => {
    setUiLocaleProvider(() => code);
  };

  it("prefers an explicit override the server offers", () => {
    const caps: DefineCapabilities = mkCaps({ sourceLangs: new Set(["ja"]), glossLangs: ["en", "ja"] });
    uiLang("en-US");
    expect(resolveGlossLang(caps, "ja")).toBe("ja");
    expect(resolveGlossLang(caps, "ja-JP")).toBe("ja");
  });

  it("falls back to the browser UI language when offered", () => {
    const caps: DefineCapabilities = mkCaps({ sourceLangs: new Set(["zh"]), glossLangs: ["en", "ja"] });
    uiLang("ja-JP");
    expect(resolveGlossLang(caps)).toBe("ja");
  });

  it("falls back to English when neither override nor UI lang is offered", () => {
    const caps: DefineCapabilities = mkCaps({ sourceLangs: new Set(["zh"]), glossLangs: ["en"] });
    uiLang("ja-JP");
    expect(resolveGlossLang(caps)).toBe("en");
    expect(resolveGlossLang(caps, "de")).toBe("en");
  });

  it("survives the locale provider throwing", () => {
    const caps: DefineCapabilities = mkCaps({ sourceLangs: new Set(["ja"]), glossLangs: ["en"] });
    setUiLocaleProvider(() => {
      throw new Error("no i18n");
    });
    expect(resolveGlossLang(caps)).toBe("en");
  });

  it("restricts the override to the SOURCE language's available gloss langs", () => {
    // de is a global gloss lang and available for ja, but NOT for es.
    const caps = mkCaps({
      sourceLangs: new Set(["ja", "es"]),
      glossLangs: ["en", "de", "es"],
      glossLangsBySource: new Map([
        ["ja", ["en", "de"]],
        ["es", ["en", "es"]],
      ]),
    });
    uiLang("en-US");
    expect(resolveGlossLang(caps, "de", "ja")).toBe("de"); // available for ja
    expect(resolveGlossLang(caps, "de", "es")).toBe("en"); // NOT for es → fallback
  });
});

describe("glossLangsForSource", () => {
  const caps = mkCaps({
    sourceLangs: new Set(["ja", "es"]),
    glossLangs: ["en", "de", "es"],
    glossLangsBySource: new Map([
      ["ja", ["en", "de"]],
      ["es", ["en", "es"]],
    ]),
  });

  it("returns the per-source list when declared", () => {
    expect(glossLangsForSource(caps, "ja")).toEqual(["en", "de"]);
    expect(glossLangsForSource(caps, "zh-Hant" as string)).toBeDefined();
  });

  it("normalizes the source subtag before lookup", () => {
    expect(glossLangsForSource(caps, "es-MX")).toEqual(["en", "es"]);
  });

  it("falls back to the global gloss list for an undeclared source", () => {
    const bare = mkCaps({ sourceLangs: new Set(["ja"]), glossLangs: ["en", "fr"] });
    expect(glossLangsForSource(bare, "ja")).toEqual(["en", "fr"]);
  });

  it("falls back to en when nothing is available", () => {
    const empty = mkCaps({ sourceLangs: new Set(), glossLangs: [] });
    expect(glossLangsForSource(empty, "ja")).toEqual(["en"]);
  });
});
