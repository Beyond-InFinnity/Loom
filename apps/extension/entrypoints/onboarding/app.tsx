// Onboarding page (CORPUS_WIRING.md §1b) — opened once by the background
// script on fresh install (runtime.onInstalled, reason "install" only).
//
// Two jobs in one page:
//   1. The first-run "What is Loom?" explainer (UI_REVISIONS.md parked
//      item) — users were being dropped in with zero orientation.
//   2. The corpus-contribution consent ask.  Clicking the primary button
//      is the affirmative action Chrome's user-data policy requires;
//      declining or just closing the tab stores nothing (a dismissal
//      leaves consent unset → one in-overlay re-ask later, then never
//      again).  The settings panel remains the permanent control.

import { useEffect, useState } from "react";

import {
  getCorpusConsent,
  setCorpusConsent,
  type CorpusConsent,
} from "@/lib/corpus/consent";

const PLATFORMS = "YouTube, Netflix, iQIYI, and WeTV";

export function App() {
  // undefined = still loading from storage; null = never answered.
  const [consent, setConsentState] = useState<CorpusConsent | undefined>(
    undefined,
  );

  useEffect(() => {
    getCorpusConsent()
      .then(setConsentState)
      .catch(() => setConsentState(null));
  }, []);

  const choose = (value: boolean) => {
    setConsentState(value);
    void setCorpusConsent(value).catch((e) =>
      console.warn("[Loom] failed to persist corpus consent:", e),
    );
  };

  return (
    <main className="page">
      <header className="hero">
        <div className="wordmark">Loom</div>
        <p className="tagline">
          Learn languages from the shows you already watch.
        </p>
      </header>

      <section className="steps">
        <Step n={1} title="Open a video">
          Loom works on {PLATFORMS} — any video with subtitles in the
          language you're learning.
        </Step>
        <Step n={2} title="Click the Loom pill">
          A small <span className="pill-chip">Loom</span> pill appears in the
          player. Click it to activate — each tab stays off until you ask.
        </Step>
        <Step n={3} title="Read all four layers">
          Your language, the video's language, a phonetic line, and
          per-character readings (furigana, Pinyin, and more). The ⚙ panel
          on the pill customizes everything.
        </Step>
      </section>

      <section className="consent">
        <h2>Help improve Loom?</h2>
        <p>
          Contribute anonymous caption data: the videos you watch share
          their <strong>video ID and subtitle text</strong> with Loom's
          training corpus to improve annotations, romanization, and future
          OCR support. It's never linked to you — no account, no IP address,
          no identifiers — and identical content is stored only once no
          matter how many people watch it.
        </p>
        {consent === undefined ? null : consent === null ? (
          <div className="choices">
            <button
              type="button"
              className="primary"
              onClick={() => choose(true)}
            >
              Contribute caption data
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => choose(false)}
            >
              No thanks
            </button>
          </div>
        ) : (
          <p className="decided">
            {consent
              ? "Thank you! You're contributing caption data."
              : "No problem — nothing will be shared."}{" "}
            You can change this anytime in the Loom pill's ⚙ settings panel.
          </p>
        )}
      </section>

      <footer className="foot">
        <a
          href="https://loom.nerv-analytic.ai/privacy"
          target="_blank"
          rel="noopener noreferrer"
        >
          Privacy policy
        </a>
        <a
          href="https://loom.nerv-analytic.ai/support"
          target="_blank"
          rel="noopener noreferrer"
        >
          Help &amp; FAQ
        </a>
      </footer>
    </main>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="step">
      <div className="step-n">{n}</div>
      <div>
        <div className="step-title">{title}</div>
        <p className="step-body">{children}</p>
      </div>
    </div>
  );
}
