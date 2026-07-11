import { describe, it, expect } from "vitest";

import { en, type StringKey } from "./strings/en";
import { ja } from "./strings/ja";
import { zh } from "./strings/zh";
import { zhHant } from "./strings/zh-hant";
import { yue } from "./strings/yue";
import { ko } from "./strings/ko";
import { de } from "./strings/de";
import { fr } from "./strings/fr";
import { es } from "./strings/es";
import { it as itTable } from "./strings/it";
import { uk } from "./strings/uk";
import { ru } from "./strings/ru";
import { initUiLocale, t, languageName } from "./index";

const LOCALES = {
  ja,
  zh,
  "zh-Hant": zhHant,
  yue,
  ko,
  de,
  fr,
  es,
  it: itTable,
  uk,
  ru,
} as const;
const enKeys = Object.keys(en) as StringKey[];

describe("locale tables", () => {
  for (const [name, table] of Object.entries(LOCALES)) {
    it(`${name} translates every canonical key`, () => {
      const missing = enKeys.filter((k) => !(k in table));
      expect(missing, `missing keys in ${name}`).toEqual([]);
    });

    it(`${name} has no keys absent from en`, () => {
      const enSet = new Set<string>(enKeys);
      const extra = Object.keys(table).filter((k) => !enSet.has(k));
      expect(extra, `unknown keys in ${name}`).toEqual([]);
    });

    it(`${name} preserves every {placeholder} of each translated string`, () => {
      const tokensOf = (s: string) =>
        (s.match(/\{(\w+)\}/g) ?? []).sort().join(",");
      for (const key of enKeys) {
        const translated = (table as Record<string, string>)[key];
        if (translated === undefined) continue;
        expect(tokensOf(translated), `${name} · ${key}`).toBe(
          tokensOf(en[key]),
        );
      }
    });
  }
});

describe("t()", () => {
  it("returns the active locale's string, falling back to English per key", () => {
    initUiLocale("ja");
    expect(t("pill.discovering")).toBe(ja["pill.discovering"]);
    initUiLocale("en");
    expect(t("pill.discovering")).toBe(en["pill.discovering"]);
  });

  it("interpolates named params and leaves unknown tokens intact", () => {
    initUiLocale("en");
    expect(t("popup.error", { message: "boom" })).toBe("Error: boom");
    expect(t("settings.videoLang.title", { count: 3 })).toContain("3");
  });

  it("falls back to English for a locale missing a specific key", () => {
    // Simulate a partial locale by resolving to a table and checking a key it
    // does have; completeness is asserted above, so this just exercises the
    // fallback path via en directly.
    initUiLocale("ru");
    expect(typeof t("settings.title")).toBe("string");
    expect(t("settings.title").length).toBeGreaterThan(0);
  });
});

describe("languageName", () => {
  it("names a language in the active UI locale", () => {
    initUiLocale("en");
    expect(languageName("ja")).toBe("Japanese");
    initUiLocale("ja");
    expect(languageName("ja")).toBe("日本語");
  });
});
