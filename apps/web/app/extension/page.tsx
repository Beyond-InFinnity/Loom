import Link from "next/link";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "Browser Extension — Loom",
  description:
    "Install the Loom browser extension for dual-language subtitles with per-token romanization on YouTube, Netflix, iQIYI, and WeTV.",
};

// Hosted at loom.nerv-analytic.ai/extension — the landing page's "Browser
// Extension" CTA points here. One card per browser, driven by BROWSER_TARGETS.
//
// To take a browser live: set its `url` to the store listing (or signed .xpi)
// link. An empty `url` (null) renders the "Coming soon" state instead of an
// install button — so the page is correct before any store URL exists.
//
// Firefox (AMO) and Chrome (Chrome Web Store) are both published; Edge installs
// the Chrome build directly from the Chrome Web Store, so it shares Chrome's URL.

type BrowserTarget = {
  name: string;
  store: string;
  /** Store-listing or signed-.xpi URL. `null` → renders "Coming soon". */
  url: string | null;
  note: string;
};

const BROWSER_TARGETS: BrowserTarget[] = [
  {
    name: "Firefox",
    store: "Firefox Add-ons",
    url: "https://addons.mozilla.org/en-US/firefox/addon/loom/",
    note: "The first supported browser — Loom is built and tested on Firefox.",
  },
  {
    name: "Chrome",
    store: "Chrome Web Store",
    url: "https://chromewebstore.google.com/detail/loom/nhibbclhffbjfcbjihgcheojpellpkpj",
    note: "A Manifest V3 build, published on the Chrome Web Store.",
  },
  {
    name: "Edge",
    store: "Chrome Web Store",
    // Edge installs the Chrome build directly from the Chrome Web Store.
    url: "https://chromewebstore.google.com/detail/loom/nhibbclhffbjfcbjihgcheojpellpkpj",
    note: "Runs the Chrome build directly from the Chrome Web Store.",
  },
];

function BrowserCard({ target }: { target: BrowserTarget }) {
  const available = target.url !== null;
  return (
    <div className="flex flex-col rounded-lg border border-border/60 bg-background/40 p-6">
      <h3 className="font-serif text-2xl font-medium text-foreground">
        {target.name}
      </h3>
      <p className="mt-1 font-mono text-xs uppercase tracking-[0.2em] text-accent">
        {target.store}
      </p>
      <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">
        {target.note}
      </p>
      <div className="mt-6">
        {available ? (
          <Link
            href={target.url as string}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-4 py-2 text-sm font-medium text-primary transition-colors hover:border-primary hover:bg-primary/20"
          >
            Add to {target.name} →
          </Link>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-md border border-border px-4 py-2 text-sm text-muted-foreground">
            Coming soon
          </span>
        )}
      </div>
    </div>
  );
}

export default function Extension() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-4xl">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              browser extension
            </p>
            <h1 className="mt-4 font-serif text-4xl font-light tracking-tight text-foreground sm:text-5xl">
              Loom for your browser
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              Dual-language subtitles with per-token romanization and annotation
              — furigana, Pinyin, Zhuyin, Jyutping, Korean Revised Romanization,
              and a secondary phonetic line for every supported script — rendered
              live over YouTube, Netflix, iQIYI, and WeTV. Activate it per tab;
              nothing runs until you click.
            </p>

            <div className="mt-12 grid gap-6 sm:grid-cols-3">
              {BROWSER_TARGETS.map((target) => (
                <BrowserCard key={target.name} target={target} />
              ))}
            </div>

            <p className="mt-10 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              Loom only sends subtitle text out of your browser, for
              romanization — see the{" "}
              <Link href="/privacy" className="text-primary hover:underline">
                privacy policy
              </Link>{" "}
              for exactly what is and isn&rsquo;t transmitted. Prefer working with
              video files directly?{" "}
              <Link href="/generate" className="text-primary hover:underline">
                Use the web application
              </Link>
              .
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
