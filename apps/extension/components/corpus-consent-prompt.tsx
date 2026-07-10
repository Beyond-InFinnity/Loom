// One-shot corpus-consent re-ask (CORPUS_WIRING.md §1a touch 2).
//
// For users who closed the onboarding tab without answering: the moment
// Loom first successfully renders captions (peak demonstrated value), show
// the contribute ask ONCE, anchored under the pill like the settings
// panel.  `loom_corpus_asked` is set when the card is SHOWN — not answered
// — so an ignore/dismiss is permanent-quiet; the settings panel's Data
// toggle remains the way in.  Dev builds never see it (capture already
// defaults on there).
//
// PERF (pill tripwires apply — this sits over the always-repainting
// player): memoized, subscribes only to `status` from context, state
// flips exactly once idle→visible and once on answer.  No backdrop-filter;
// solid rgba ≥ 0.94.  Clicks are swallowed so Netflix doesn't play/pause
// (lib/overlay/stop-player-events).

import { memo, useEffect, useRef, useState } from "react";

import { useCaptionStream } from "./caption-context";
import {
  getCorpusAsked,
  getCorpusConsent,
  markCorpusAsked,
  setCorpusConsent,
} from "@/lib/corpus/consent";
import { IS_DEV } from "@/lib/env";
import { t } from "@/lib/i18n";
import { getPillAnchor } from "@/lib/overlay/pill-position";
import { swallowPlayerEvents } from "@/lib/overlay/stop-player-events";

export const CorpusConsentPrompt = memo(function CorpusConsentPrompt() {
  const { status } = useCaptionStream();
  const [visible, setVisible] = useState(false);
  // Guards the storage-check + markAsked against firing more than once
  // per mount (status object identity changes on every emit).
  const checkedRef = useRef(false);

  const tracking = status.kind === "tracking";

  useEffect(() => {
    if (!tracking || checkedRef.current || IS_DEV) return;
    checkedRef.current = true;
    let cancelled = false;
    void (async () => {
      try {
        const [consent, asked] = await Promise.all([
          getCorpusConsent(),
          getCorpusAsked(),
        ]);
        if (cancelled || consent !== null || asked) return;
        await markCorpusAsked(); // shown = asked; never fires twice
        if (!cancelled) setVisible(true);
      } catch {
        // Storage trouble → just never show; the settings toggle exists.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tracking]);

  if (!visible) return null;

  const choose = (value: boolean) => {
    setVisible(false);
    void setCorpusConsent(value).catch(() => undefined);
  };

  const anchor = getPillAnchor();
  return (
    <div
      style={{
        position: "absolute",
        top: `${anchor.top + 44}px`,
        right: `${anchor.right}px`,
        width: "300px",
        background: "rgba(18, 18, 22, 0.96)",
        border: "1px solid rgba(179, 157, 219, 0.4)",
        borderRadius: "10px",
        padding: "14px 16px",
        color: "#e8e6e3",
        fontSize: "13px",
        lineHeight: 1.5,
        zIndex: 2147483646,
        pointerEvents: "auto",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
      }}
      {...swallowPlayerEvents}
    >
      <div style={{ fontWeight: 600, marginBottom: "6px" }}>
        {t("consent.title")}
      </div>
      <p style={{ margin: "0 0 10px", color: "#c4c0ba" }}>{t("consent.body")}</p>
      <div style={{ display: "flex", gap: "8px" }}>
        <button
          type="button"
          onClick={() => choose(true)}
          style={{
            font: "inherit",
            fontWeight: 600,
            padding: "6px 12px",
            borderRadius: "7px",
            border: "none",
            cursor: "pointer",
            background: "linear-gradient(120deg, #e6c86e, #d4af5f)",
            color: "#1a1408",
          }}
        >
          {t("consent.contribute")}
        </button>
        <button
          type="button"
          onClick={() => choose(false)}
          style={{
            font: "inherit",
            padding: "6px 12px",
            borderRadius: "7px",
            border: "1px solid rgba(255,255,255,0.25)",
            cursor: "pointer",
            background: "transparent",
            color: "#b8b4ae",
          }}
        >
          {t("consent.decline")}
        </button>
      </div>
    </div>
  );
});
