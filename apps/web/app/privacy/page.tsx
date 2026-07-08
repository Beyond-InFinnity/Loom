import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "Privacy Policy — Loom",
  description:
    "What the Loom browser extension and web app send out of your browser, and why.",
};

// Hosted at loom.nerv-analytic.ai/privacy — the canonical privacy URL listed
// on the Firefox AMO + Chrome Web Store submissions. Content mirrors the
// extension's actual data flow (subtitle text + optional owner key only); keep
// this page in lockstep if the extension ever sends anything new.

const LAST_UPDATED = "8 July 2026";
const CONTACT_EMAIL = "privacy@nerv-analytic.ai";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="font-serif text-2xl font-light tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-muted-foreground sm:text-base">
        {children}
      </div>
    </section>
  );
}

export default function Privacy() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              privacy policy
            </p>
            <h1 className="mt-4 font-serif text-4xl font-light tracking-tight sm:text-5xl">
              Privacy Policy
            </h1>
            <p className="mt-4 text-sm text-muted-foreground">
              Last updated {LAST_UPDATED}
            </p>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Loom is a browser extension (and companion web app) that renders
              dual-language subtitles with phonetic annotations on streaming
              video. This page explains exactly what data Loom sends out of your
              browser, and why. The short version: subtitle text for processing,
              and an optional owner key if you set one. Nothing else.
            </p>

            <Section title="What we send">
              <p>
                When you activate Loom on a video, the extension reads the
                subtitle text from the tracks the site already serves to your
                browser, deduplicates it, and sends the unique subtitle strings
                to <code className="font-mono text-foreground/80">api.loom.nerv-analytic.ai</code>{" "}
                for romanization (e.g. “東京” → “Tōkyō”) and per-character
                annotation (e.g. furigana, Pinyin). Each video produces roughly
                one request per subtitle track when you activate Loom; we do not
                send anything during playback after that.
              </p>
              <p>
                The request carries only the subtitle text and the target
                language code. Romanization and annotation require server-side
                language tools (MeCab, pypinyin, aksharamukha, and others) that
                can’t run in the browser — that is the sole reason any text
                leaves your device.
              </p>
              <p>
                For Japanese and Chinese, Loom also offers a per-word dictionary
                lookup: while the video is paused, clicking a word sends just
                that word (and its dictionary form) to the same API to fetch its
                definition. This is the same kind of subtitle-derived text
                already described above, sent only on a click — never in the
                background.
              </p>
            </Section>

            <Section title="What we don’t send">
              <p>
                We do not send your account information, your viewing history,
                your playhead position, any unique device identifier, or any
                browser-level telemetry. The API receives the subtitle text and
                the language code, and nothing more.
              </p>
            </Section>

            <Section title="Optional owner key (web app only)">
              <p>
                The companion web app supports an optional owner key — set via{" "}
                <code className="font-mono text-foreground/80">
                  loom.nerv-analytic.ai/?owner_key=…
                </code>{" "}
                — which is sent as an HTTP header on API requests to bypass rate
                limits. It is stored only in your browser’s local storage and is
                removed when you clear it. The published browser extension does
                not offer or transmit an owner key; its only stored data is your
                display preferences and the on/off toggle.
              </p>
            </Section>

            <Section title="Retention">
              <p>
                To avoid recomputing identical text, the Loom API keeps a
                processing cache: the subtitle strings it has romanized or
                annotated, stored as anonymous text with no record of which
                video they came from, who requested them, or any IP address.
                Identical text is stored once, no matter how many people
                process it.
              </p>
            </Section>

            <Section title="Training corpus (opt-in)">
              <p>
                Separately, and only when you choose to contribute, Loom keeps
                a training corpus used to improve its annotations,
                romanization, and optical-character-recognition research. A
                contribution records the media’s title or platform ID, the
                caption text with its timing, and — for uploaded subtitle
                files — the subtitle styling. It records nothing about you:
                no account, no IP address, no device or install identifier.
                Identical content is stored once regardless of how many
                people contribute it, so the corpus describes media, not
                viewers.
              </p>
              <p>
                In the browser extension, contribution is off until you
                accept the ask shown after installation (or turn on
                “Contribute caption data” in the settings panel — the same
                place you can turn it off at any time). In the web app’s
                generator, it is controlled by the visible “Contribute
                caption data” checkbox next to the Generate button, which
                you can untick per run. Turning contribution off stops all
                future contribution immediately.
              </p>
            </Section>

            <Section title="Dictionary data & licenses">
              <p>
                The per-word definitions Loom shows come from two open community
                dictionaries, used under the Creative Commons
                Attribution-ShareAlike 4.0 license (CC BY-SA 4.0):
              </p>
              <ul className="ml-5 list-disc space-y-2">
                <li>
                  <strong className="text-foreground/80">Japanese —</strong>{" "}
                  JMdict, © the{" "}
                  <a
                    href="https://www.edrdg.org/"
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Electronic Dictionary Research and Development Group (EDRDG)
                  </a>
                  , used under{" "}
                  <a
                    href="https://creativecommons.org/licenses/by-sa/4.0/"
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    CC BY-SA 4.0
                  </a>
                  .
                </li>
                <li>
                  <strong className="text-foreground/80">Chinese —</strong>{" "}
                  <a
                    href="https://www.mdbg.net/chinese/dictionary?page=cc-cedict"
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    CC-CEDICT
                  </a>
                  , used under{" "}
                  <a
                    href="https://creativecommons.org/licenses/by-sa/4.0/"
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    CC BY-SA 4.0
                  </a>
                  .
                </li>
              </ul>
              <p>
                Each definition card also names its source dictionary. Loom’s use
                of this data does not imply either project endorses Loom.
              </p>
            </Section>

            <Section title="Third parties">
              <p>
                We do not share data with third parties. We do not use analytics
                services. We do not run advertising.
              </p>
            </Section>

            <Section title="Your rights">
              <p>
                Uninstalling the extension removes all locally-stored preferences
                and the owner key. The Loom API holds no per-user records, so
                there is nothing server-side to delete.
              </p>
            </Section>

            <Section title="Contact">
              <p>
                Questions about this policy?{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-primary hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </Section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
