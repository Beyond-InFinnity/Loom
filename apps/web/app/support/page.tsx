import Link from "next/link";
import { SiteFooter } from "../../components/site-footer";
import { SiteNav } from "../../components/site-nav";

export const metadata = {
  title: "Support — Loom",
  description:
    "How to use the Loom browser extension, common questions, and troubleshooting for dual-language subtitles with romanization.",
};

// Hosted at loom.nerv-analytic.ai/support — the technical-support / FAQ surface,
// and the canonical "Support" URL listed on the Firefox AMO + Chrome Web Store
// submissions. (Donations live separately at /donate.)
//
// Keep the troubleshooting answers in lockstep with the extension's real
// behaviour: per-tab activation via the "Loom" pill, a single batch fetch on
// activation (~3-4s, then quiet), per-platform caption acquisition across
// YouTube / Netflix / iQIYI / WeTV. If the activation flow, the supported
// platforms, or a known failure mode changes, update the matching Q here.

const CONTACT_EMAIL = "support@nerv-analytic.ai";

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

function Faq({
  question,
  children,
}: {
  question: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/40 p-5">
      <h3 className="font-serif text-lg font-medium text-foreground">
        {question}
      </h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  );
}

export default function Support() {
  return (
    <>
      <SiteNav />
      <main className="flex flex-1 flex-col">
        <section className="px-6 py-12 sm:py-16">
          <div className="mx-auto max-w-3xl">
            <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">
              support
            </p>
            <h1 className="mt-4 font-serif text-4xl font-light tracking-tight sm:text-5xl">
              Support
            </h1>
            <p className="mt-6 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
              Loom adds dual-language subtitles with phonetic readings —
              furigana, Pinyin, Zhuyin, Jyutping, Korean romanization, and a
              romanization line for every supported script — on top of YouTube,
              Netflix, iQIYI, and WeTV playback. This page covers getting started
              and the questions that
              come up most. Still stuck?{" "}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="text-primary hover:underline"
              >
                Email us
              </a>
              .
            </p>

            <Section title="Getting started">
              <ol className="ml-5 list-decimal space-y-2">
                <li>
                  Install the extension from the{" "}
                  <Link href="/extension" className="text-primary hover:underline">
                    extension page
                  </Link>{" "}
                  (Firefox, Chrome, and Edge are all supported).
                </li>
                <li>
                  Open a video on YouTube, Netflix, iQIYI, or WeTV that has
                  subtitles/captions in the spoken language.
                </li>
                <li>
                  Click the small <strong className="text-foreground">“Loom”</strong>{" "}
                  pill that appears over the player to activate it for that tab.
                  Nothing runs until you click — each tab starts dormant.
                </li>
                <li>
                  Wait a few seconds while Loom fetches readings for the whole
                  video in one batch, then watch — the extra subtitle layers
                  render as the video plays.
                </li>
                <li>
                  Open the settings panel to pick languages, swap layer
                  positions, toggle the annotation and romanization lines, and
                  restyle every layer (color, font, size, outline, glow).
                </li>
              </ol>
            </Section>

            <Section title="Frequently asked questions">
              <div className="mt-2 space-y-4">
                <Faq question="Is Loom free?">
                  <p>
                    Yes — Loom is a free, ad-free research project. If it&rsquo;s
                    useful to you,{" "}
                    <Link href="/donate" className="text-primary hover:underline">
                      donations are welcome
                    </Link>{" "}
                    but entirely optional.
                  </p>
                </Faq>

                <Faq question="Which sites and browsers does Loom support?">
                  <p>
                    Loom works on{" "}
                    <strong className="text-foreground">
                      YouTube, Netflix, iQIYI, and WeTV
                    </strong>
                    , on Firefox, Chrome, and Edge. More streaming sites are on
                    the roadmap. Loom needs a fetchable text subtitle track in
                    the language being spoken, so titles with only burned-in or
                    image-based subtitles aren&rsquo;t supported yet.
                  </p>
                </Faq>

                <Faq question="Which languages can it romanize?">
                  <p>
                    Chinese (Pinyin / Zhuyin / Jyutping), Japanese (furigana +
                    romaji), Korean, plus a romanization line for Cyrillic, Thai,
                    several Indic scripts, Hebrew, and Arabic / Persian / Urdu.
                    Per-character readings appear above the foreign text for CJK
                    and Korean; other scripts get the full-line romanization.
                  </p>
                </Faq>

                <Faq question="No extra subtitles appear after I click “Loom.”">
                  <p>
                    The most common cause is that the video has no captions to
                    work from. Confirm the site&rsquo;s own CC/subtitle control
                    offers captions for the video. Loom reads the caption tracks
                    the site already serves — if there are none (or only
                    image-based subtitles, or only a language Loom can&rsquo;t
                    yet process), there&rsquo;s nothing to annotate. Reloading the
                    page and re-activating clears most transient cases.
                  </p>
                </Faq>

                <Faq question="The romanization line didn’t load.">
                  <p>
                    Readings are fetched once, in a single batch, right after you
                    activate Loom — it takes a few seconds, then goes quiet for
                    the rest of playback. If a layer is missing, re-activate (or
                    reload the tab) to retry the fetch. A slow or offline
                    connection during those first few seconds is the usual
                    culprit.
                  </p>
                </Faq>

                <Faq question="The subtitles are out of sync or look stale.">
                  <p>
                    Loom anchors its overlay to each site&rsquo;s video player, so
                    fullscreen and theater mode are supported. If timing looks off
                    after jumping between videos or episodes quickly, reload the
                    page to reset the overlay for the current video.
                  </p>
                </Faq>

                <Faq question="What data does Loom send?">
                  <p>
                    Only the subtitle text (and a target language code) needed for
                    romanization — nothing about your account, history, or device.
                    Full detail is in the{" "}
                    <Link href="/privacy" className="text-primary hover:underline">
                      privacy policy
                    </Link>
                    .
                  </p>
                </Faq>

                <Faq question="I have a video file, not a streaming link.">
                  <p>
                    Use the{" "}
                    <Link href="/generate" className="text-primary hover:underline">
                      web application
                    </Link>{" "}
                    to build dual-language subtitle files (.ass / .sup) from your
                    own subtitle and video files.
                  </p>
                </Faq>
              </div>
            </Section>

            <Section title="Report a bug or request a feature">
              <p>
                Found a problem or have an idea? Open an issue on{" "}
                <Link
                  href="https://github.com/Beyond-InFinnity/Loom/issues"
                  rel="noopener noreferrer"
                  target="_blank"
                  className="text-primary hover:underline"
                >
                  GitHub
                </Link>
                , or email{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-primary hover:underline"
                >
                  {CONTACT_EMAIL}
                </a>
                . When reporting a caption problem, the video URL and your browser
                help a lot.
              </p>
            </Section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
