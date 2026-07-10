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
import { t } from "@/lib/i18n";

const PLATFORMS = "YouTube, Netflix, iQIYI, and WeTV";

// Render a template containing a single "{pill}" token with the styled Loom chip
// spliced in at the token's position (word order varies by language).
function withPillChip(template: string): React.ReactNode {
  const [before, after] = template.split("{pill}");
  if (after === undefined) return template; // token absent — plain string
  return (
    <>
      {before}
      <span className="pill-chip">Loom</span>
      {after}
    </>
  );
}

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
        <p className="tagline">{t("onboarding.tagline")}</p>
      </header>

      <section className="steps">
        <Step n={1} title={t("onboarding.step1.title")}>
          {t("onboarding.step1.body", { platforms: PLATFORMS })}
        </Step>
        <Step n={2} title={t("onboarding.step2.title")}>
          {withPillChip(t("onboarding.step2.body"))}
        </Step>
        <Step n={3} title={t("onboarding.step3.title")}>
          {t("onboarding.step3.body")}
        </Step>
      </section>

      <section className="consent">
        <h2>{t("onboarding.help.title")}</h2>
        <p>{t("onboarding.help.body")}</p>
        {consent === undefined ? null : consent === null ? (
          <div className="choices">
            <button
              type="button"
              className="primary"
              onClick={() => choose(true)}
            >
              {t("onboarding.help.contribute")}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => choose(false)}
            >
              {t("onboarding.help.decline")}
            </button>
          </div>
        ) : (
          <p className="decided">
            {consent
              ? t("onboarding.help.thanks")
              : t("onboarding.help.noProblem")}{" "}
            {t("onboarding.help.changeLater")}
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
