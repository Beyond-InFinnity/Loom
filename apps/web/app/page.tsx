import Link from "next/link";
import { SiteFooter } from "../components/site-footer";
import { SiteNav } from "../components/site-nav";

const SUPPORTED_LANGS = [
  "Japanese · 日本語",
  "Mandarin · 普通话",
  "Cantonese · 廣東話",
  "Korean · 한국어",
  "Thai · ภาษาไทย",
  "Cyrillic · Кирилица",
  "Hindi · हिन्दी",
  "Bengali · বাংলা",
  "Tamil · தமிழ்",
  "Telugu · తెలుగు",
  "Hebrew · עברית",
  "Arabic · العربية",
  "Persian · فارسی",
  "Urdu · اُردُو",
];

export default function Home() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-24 sm:py-32">
          <div className="mx-auto max-w-3xl text-center">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              polyglot subtitle intelligence
            </p>
            <h1 className="mt-6 font-serif text-5xl font-light tracking-tight text-foreground sm:text-7xl">
              Loom
            </h1>
            <p className="mt-6 text-lg leading-relaxed text-muted-foreground sm:text-xl">
              Drop in any video, pick a native and a target track, and get back
              a stitched subtitle file with phonetic readings layered above the
              foreign script — all in your browser, no upload required.
            </p>
            <div className="mt-10 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-stretch">
              <Link
                href="/extension"
                className="inline-flex flex-col rounded-md border border-primary/40 bg-primary/10 px-5 py-3 text-left transition-colors hover:bg-primary/20 hover:border-primary"
              >
                <span className="text-sm font-medium text-primary">
                  Browser Extension →
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">
                  Dual subtitles + romanization, live on YouTube
                </span>
              </Link>
              <Link
                href="/generate"
                className="inline-flex flex-col rounded-md border border-border px-5 py-3 text-left transition-colors hover:border-muted-foreground"
              >
                <span className="text-sm font-medium text-foreground">
                  Web application →
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">
                  For video files, subtitle files, and container formats
                </span>
              </Link>
            </div>
            <div className="mt-4 flex items-center justify-center gap-4">
              <Link
                href="/support"
                className="text-xs text-muted-foreground transition-colors hover:text-primary"
              >
                ☕ Support Loom
              </Link>
              <span className="text-xs text-border">·</span>
              <Link
                href="/ffmpeg-test"
                className="text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                Diagnostics
              </Link>
            </div>
          </div>
        </section>

        <section className="border-t border-border/60 px-6 py-16">
          <div className="mx-auto max-w-3xl">
            <h2 className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              writing systems
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              Romanization + per-token annotation across CJK, Brahmic, Cyrillic,
              and RTL scripts.  Long-vowel modes for Japanese (macrons / doubled
              / unmarked).  Phonetic-system overrides for Thai (Paiboon+ / RTGS
              / IPA), Arabic, Persian, Urdu.
            </p>
            <ul className="mt-8 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-foreground/80 sm:grid-cols-3">
              {SUPPORTED_LANGS.map((lang) => (
                <li key={lang} className="border-l-2 border-accent/40 pl-3">
                  {lang}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-border/60 px-6 py-16">
          <div className="mx-auto grid max-w-3xl gap-8 sm:grid-cols-3">
            <Pillar
              title="In-browser"
              body="ffmpeg.wasm probes and demuxes the container.  html2canvas rasterizes layered subtitles for PGS encoding.  Nothing larger than ~100 KB ever leaves the page."
            />
            <Pillar
              title="Two outputs"
              body="A 4-layer .ass file (native, target, romanized, annotation) and a PGS .sup bitmap track.  Both at 1080p, ready to mux back into the source MKV."
            />
            <Pillar
              title="Server-light"
              body="The hosted API only handles romanization + furigana — the parts that need MeCab, jieba, pythainlp, aksharamukha.  Everything else is yours."
            />
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}

function Pillar({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="font-serif text-2xl font-medium text-primary">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}
