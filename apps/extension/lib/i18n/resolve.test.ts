import { describe, it, expect } from "vitest";
import { resolveUiLocale } from "./resolve";

describe("resolveUiLocale", () => {
  const uiLang = (code: string) => {
    // @ts-expect-error test shim for the WebExtension global
    globalThis.browser = { i18n: { getUILanguage: () => code } };
  };

  it("maps an explicit code's primary subtag to a supported locale", () => {
    expect(resolveUiLocale("ja")).toBe("ja");
    expect(resolveUiLocale("ja-JP")).toBe("ja");
    expect(resolveUiLocale("de-AT")).toBe("de");
    expect(resolveUiLocale("uk")).toBe("uk");
    expect(resolveUiLocale("ru-RU")).toBe("ru");
  });

  it("routes Simplified-script Chinese to the zh table", () => {
    for (const c of ["zh", "zh-CN", "zh-Hans", "zh-SG", "cmn", "zh-Hans-CN"]) {
      expect(resolveUiLocale(c)).toBe("zh");
    }
  });

  it("routes Traditional-script Chinese to the zh-Hant table", () => {
    for (const c of ["zh-Hant", "zh-TW", "zh-HK", "zh-MO", "zh-Hant-HK"]) {
      expect(resolveUiLocale(c)).toBe("zh-Hant");
    }
  });

  it("routes explicit Cantonese to the yue table (but not zh-HK)", () => {
    expect(resolveUiLocale("yue")).toBe("yue");
    expect(resolveUiLocale("yue-HK")).toBe("yue");
    expect(resolveUiLocale("zh-yue")).toBe("yue");
    // zh-HK is Standard Written Chinese (Traditional), NOT colloquial Cantonese.
    expect(resolveUiLocale("zh-HK")).toBe("zh-Hant");
  });

  it("falls back to English for unsupported languages", () => {
    expect(resolveUiLocale("pt-BR")).toBe("en");
    expect(resolveUiLocale("th")).toBe("en");
    expect(resolveUiLocale("")).toBe("en");
  });

  it("reads the browser UI language when no code is passed", () => {
    uiLang("fr-FR");
    expect(resolveUiLocale()).toBe("fr");
  });

  it("survives browser.i18n being unavailable", () => {
    // @ts-expect-error test shim
    globalThis.browser = { i18n: { getUILanguage: () => { throw new Error("no i18n"); } } };
    expect(resolveUiLocale()).toBe("en");
  });
});
