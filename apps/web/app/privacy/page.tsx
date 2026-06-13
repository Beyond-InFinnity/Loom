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

const LAST_UPDATED = "14 June 2026";
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
                The Loom API processes requests in memory and does not archive
                subtitle text by default. A future opt-in research pipeline may
                store anonymized text to train language models; if and when that
                ships, it will be governed by an explicit per-request opt-in flag
                that you control from the extension’s settings, and this page
                will be updated before it does.
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
