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

  it("collapses every Chinese variant to the zh UI table", () => {
    for (const c of ["zh", "zh-CN", "zh-Hans", "zh-TW", "zh-HK", "yue", "cmn"]) {
      expect(resolveUiLocale(c)).toBe("zh");
    }
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
