import { describe, expect, it, vi } from "vitest";

import {
  baseLang,
  normalizeDefineSourceLang,
  isDefinable,
  resolveGlossLang,
} from "./define-lang";
import type { DefineCapabilities } from "./capabilities";

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
  const caps: DefineCapabilities = {
    sourceLangs: new Set(["ja", "zh"]),
    glossLangs: ["en"],
  };

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
    const withKorean: DefineCapabilities = {
      sourceLangs: new Set(["ja", "zh", "ko"]),
      glossLangs: ["en"],
    };
    expect(isDefinable(withKorean, "ko")).toBe(true);
  });
});

describe("resolveGlossLang", () => {
  const uiLang = (code: string) => {
    // @ts-expect-error test shim for the WebExtension global
    globalThis.browser = { i18n: { getUILanguage: () => code } };
  };

  it("prefers an explicit override the server offers", () => {
    const caps: DefineCapabilities = { sourceLangs: new Set(["ja"]), glossLangs: ["en", "ja"] };
    uiLang("en-US");
    expect(resolveGlossLang(caps, "ja")).toBe("ja");
    expect(resolveGlossLang(caps, "ja-JP")).toBe("ja");
  });

  it("falls back to the browser UI language when offered", () => {
    const caps: DefineCapabilities = { sourceLangs: new Set(["zh"]), glossLangs: ["en", "ja"] };
    uiLang("ja-JP");
    expect(resolveGlossLang(caps)).toBe("ja");
  });

  it("falls back to English when neither override nor UI lang is offered", () => {
    const caps: DefineCapabilities = { sourceLangs: new Set(["zh"]), glossLangs: ["en"] };
    uiLang("ja-JP");
    expect(resolveGlossLang(caps)).toBe("en");
    expect(resolveGlossLang(caps, "de")).toBe("en");
  });

  it("survives browser.i18n throwing", () => {
    const caps: DefineCapabilities = { sourceLangs: new Set(["ja"]), glossLangs: ["en"] };
    // @ts-expect-error test shim
    globalThis.browser = { i18n: { getUILanguage: () => { throw new Error("no i18n"); } } };
    expect(resolveGlossLang(caps)).toBe("en");
  });
});
