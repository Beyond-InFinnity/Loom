import { describe, expect, it } from "vitest";
import {
  classifyLang,
  defaultPhoneticSystemFor,
  defaultRomanizeLineEnabledFor,
  sameBaseLang,
} from "./lang-support";

describe("classifyLang — Latin / native-display", () => {
  it.each([
    "en",
    "en-US",
    "en-GB",
    "en-AU",
    "en-IN",
    "en-ZA",
    "de",
    "de-AT",
    "de-CH",
    "fr",
    "fr-CA",
    "es",
    "es-ES",
    "es-MX",
    "es-419",
    "pt",
    "pt-BR",
    "pt-PT",
    "it",
    "nl",
    "pl",
    "cs",
    "sk",
    "ro",
    "hu",
    "tr",
    "vi",
    "id",
    "ms",
    "sw",
    "fil",
    "sv",
    "da",
    "no",
    "fi",
    "ca",
    "gl",
    "haw",
  ])("classifies %s as native-display Latin", (code) => {
    const c = classifyLang(code);
    expect(c.script).toBe("Latn");
    expect(c.family).toBe("latin");
    expect(c.processing).toBe("native-display");
    expect(c.chineseVariant).toBeNull();
  });

  it("Serbian Latin variant overrides default Cyrillic", () => {
    const c = classifyLang("sr-Latn");
    expect(c.script).toBe("Latn");
    expect(c.processing).toBe("native-display");
  });
});

describe("classifyLang — CJK / annotate-romanize", () => {
  it("classifies Japanese", () => {
    const c = classifyLang("ja");
    expect(c.family).toBe("kana");
    expect(c.processing).toBe("annotate-romanize");
    expect(c.chineseVariant).toBeNull();
  });

  it("classifies Korean", () => {
    const c = classifyLang("ko");
    expect(c.family).toBe("hangul");
    expect(c.processing).toBe("annotate-romanize");
  });

  it("classifies zh (no script) as Simplified Mandarin", () => {
    const c = classifyLang("zh");
    expect(c.family).toBe("cjk-han");
    expect(c.processing).toBe("annotate-romanize");
    expect(c.chineseVariant).toBe("simplified");
  });

  it("classifies zh-CN as Simplified", () => {
    expect(classifyLang("zh-CN").chineseVariant).toBe("simplified");
    expect(classifyLang("zh-Hans").chineseVariant).toBe("simplified");
    expect(classifyLang("zh-Hans-CN").chineseVariant).toBe("simplified");
  });

  it("classifies zh-TW/HK/MO as Traditional", () => {
    expect(classifyLang("zh-TW").chineseVariant).toBe("traditional");
    expect(classifyLang("zh-HK").chineseVariant).toBe("traditional");
    expect(classifyLang("zh-MO").chineseVariant).toBe("traditional");
    expect(classifyLang("zh-Hant").chineseVariant).toBe("traditional");
    expect(classifyLang("zh-Hant-TW").chineseVariant).toBe("traditional");
  });

  it("classifies yue as Cantonese (Jyutping target)", () => {
    expect(classifyLang("yue").chineseVariant).toBe("cantonese");
    expect(classifyLang("yue-HK").chineseVariant).toBe("cantonese");
  });
});

describe("classifyLang — romanize", () => {
  it.each(["ru", "uk", "be", "bg", "mk", "sr", "mn"])(
    "classifies Cyrillic %s as romanize",
    (code) => {
      const c = classifyLang(code);
      expect(c.family).toBe("cyrillic");
      expect(c.processing).toBe("romanize");
    },
  );

  it("classifies Thai", () => {
    const c = classifyLang("th");
    expect(c.family).toBe("thai");
    expect(c.processing).toBe("romanize");
  });

  it.each(["he", "iw"])("classifies Hebrew %s", (code) => {
    expect(classifyLang(code).family).toBe("hebrew");
    expect(classifyLang(code).processing).toBe("romanize");
  });

  it.each(["ar", "fa", "ur", "ps"])(
    "classifies Arabic-family %s",
    (code) => {
      expect(classifyLang(code).family).toBe("arabic");
      expect(classifyLang(code).processing).toBe("romanize");
    },
  );

  it.each(["hi", "bn", "ta", "te", "gu", "pa", "ml", "kn"])(
    "classifies Indic %s",
    (code) => {
      expect(classifyLang(code).family).toBe("indic");
      expect(classifyLang(code).processing).toBe("romanize");
    },
  );
});

describe("classifyLang — unsupported scripts (still display)", () => {
  it.each(["km", "my", "lo", "ka", "hy", "am"])(
    "classifies %s as unsupported (no romanizer yet)",
    (code) => {
      expect(classifyLang(code).processing).toBe("unsupported");
    },
  );
});

describe("sameBaseLang — regional variant collapse", () => {
  it("English variants all match", () => {
    expect(sameBaseLang("en", "en-US")).toBe(true);
    expect(sameBaseLang("en", "en-GB")).toBe(true);
    expect(sameBaseLang("en", "en-AU")).toBe(true);
    expect(sameBaseLang("en", "en-IN")).toBe(true);
    expect(sameBaseLang("en", "en-ZA")).toBe(true);
    expect(sameBaseLang("en-US", "en-GB")).toBe(true);
    expect(sameBaseLang("en-AU", "en-IN")).toBe(true);
  });

  it("Portuguese Brazil/Portugal collapse", () => {
    expect(sameBaseLang("pt", "pt-BR")).toBe(true);
    expect(sameBaseLang("pt-BR", "pt-PT")).toBe(true);
  });

  it("Spanish global variants all collapse", () => {
    expect(sameBaseLang("es", "es-ES")).toBe(true);
    expect(sameBaseLang("es", "es-MX")).toBe(true);
    expect(sameBaseLang("es", "es-419")).toBe(true);
    expect(sameBaseLang("es-MX", "es-419")).toBe(true);
  });

  it("French regional variants collapse", () => {
    expect(sameBaseLang("fr", "fr-CA")).toBe(true);
    expect(sameBaseLang("fr-CA", "fr-FR")).toBe(true);
  });

  it("Chinese Hans/Hant share base zh", () => {
    // Both are "Chinese" in ISO 639 even though scripts differ — the
    // base-lang collapse intentionally allows this; consumers needing
    // to distinguish Simplified vs Traditional use chineseVariant.
    expect(sameBaseLang("zh-Hans", "zh-Hant")).toBe(true);
    expect(sameBaseLang("zh-CN", "zh-TW")).toBe(true);
  });

  it("Cantonese (yue) is a separate base lang from zh", () => {
    expect(sameBaseLang("yue", "zh")).toBe(false);
    expect(sameBaseLang("yue-HK", "zh-HK")).toBe(false);
  });

  it("different languages do not collapse", () => {
    expect(sameBaseLang("en", "es")).toBe(false);
    expect(sameBaseLang("ja", "ko")).toBe(false);
    expect(sameBaseLang("pt", "es")).toBe(false);
  });

  it("canonicalizes deprecated codes before comparing", () => {
    expect(sameBaseLang("iw", "he-IL")).toBe(true);
    expect(sameBaseLang("in", "id-ID")).toBe(true);
  });

  it("returns false on empty / malformed input", () => {
    expect(sameBaseLang("", "en")).toBe(false);
    expect(sameBaseLang("en", "")).toBe(false);
  });
});

describe("defaultRomanizeLineEnabledFor — romanization-line default", () => {
  it("ONLY Japanese is on among CJK + Korean", () => {
    // The headline request: among ja / zh-Hans / zh-Hant / ko, only
    // Japanese gets the romaji line by default (its ruby is kana, not a
    // romanization; the others' ruby already IS the romanization).
    expect(defaultRomanizeLineEnabledFor("ja")).toBe(true);
    expect(defaultRomanizeLineEnabledFor("ko")).toBe(false);
    expect(defaultRomanizeLineEnabledFor("zh-Hans")).toBe(false);
    expect(defaultRomanizeLineEnabledFor("zh-Hant")).toBe(false);
    expect(defaultRomanizeLineEnabledFor("yue")).toBe(false);
  });

  it("pure-romanize scripts stay on (the line is their only phonetic surface)", () => {
    for (const code of ["ru", "uk", "th", "hi", "he", "ar", "fa", "ur"]) {
      expect(defaultRomanizeLineEnabledFor(code)).toBe(true);
    }
  });

  it("Latin / unsupported default off (no phonetic layer anyway)", () => {
    expect(defaultRomanizeLineEnabledFor("en")).toBe(false);
    expect(defaultRomanizeLineEnabledFor("de")).toBe(false);
    expect(defaultRomanizeLineEnabledFor("km")).toBe(false);
  });
});

describe("defaultPhoneticSystemFor — phonetic-system default", () => {
  it("Traditional Chinese defaults to Pinyin (not Zhuyin)", () => {
    expect(defaultPhoneticSystemFor("zh-Hant")).toBe("pinyin");
    expect(defaultPhoneticSystemFor("zh-TW")).toBe("pinyin");
  });

  it("Simplified Chinese defaults to Pinyin", () => {
    expect(defaultPhoneticSystemFor("zh-Hans")).toBe("pinyin");
    expect(defaultPhoneticSystemFor("zh")).toBe("pinyin");
  });

  it("Cantonese defaults to Jyutping", () => {
    expect(defaultPhoneticSystemFor("yue")).toBe("jyutping");
  });

  it("non-Chinese languages fall through to null (backend default)", () => {
    expect(defaultPhoneticSystemFor("ja")).toBeNull();
    expect(defaultPhoneticSystemFor("ko")).toBeNull();
    expect(defaultPhoneticSystemFor("th")).toBeNull();
    expect(defaultPhoneticSystemFor("ar")).toBeNull();
  });
});
