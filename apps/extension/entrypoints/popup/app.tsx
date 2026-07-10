import { useEffect, useState } from "react";

import { getApiClient } from "@/lib/api-client";
import { getEnabled, setEnabled } from "@/lib/enabled";
import { API_BASE_URL, IS_DEV } from "@/lib/env";
import { t } from "@/lib/i18n";
import { getOwnerKey, setOwnerKey } from "@/lib/owner-key";

type CheckStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; status: number; body: string }
  | { kind: "err"; message: string };

export function App() {
  // Global on/off for this browser (both builds). Defaults on; persisted to
  // browser.storage.local; the content script subscribes and tears down live.
  const [enabled, setEnabledState] = useState<boolean>(true);

  // Owner key is DEV-ONLY (the input section below is gated on IS_DEV). The
  // state + effect stay unconditional — harmless in prod where the section
  // never renders and getOwnerKey resolves to null (public rate limits).
  const [keyInput, setKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckStatus>({ kind: "idle" });

  useEffect(() => {
    getEnabled()
      .then(setEnabledState)
      .catch((e) => {
        console.error("[Loom] failed to read enabled flag from storage:", e);
      });
  }, []);

  useEffect(() => {
    if (!IS_DEV) return;
    getOwnerKey()
      .then((stored) => {
        setSavedKey(stored);
        if (stored) setKeyInput(stored);
      })
      .catch((e) => {
        console.error("[Loom] failed to read owner key from storage:", e);
      });
  }, []);

  async function handleToggle() {
    const next = !enabled;
    setEnabledState(next); // optimistic
    try {
      await setEnabled(next);
    } catch (e) {
      setEnabledState(!next); // roll back on failure
      console.error("[Loom] failed to persist enabled flag:", e);
    }
  }

  async function handleSave() {
    await setOwnerKey(keyInput);
    setSavedKey(keyInput.trim() || null);
  }

  async function handleCheck() {
    setCheck({ kind: "pending" });
    try {
      const client = getApiClient();
      const { data, response } = await client.GET("/health");
      if (!response.ok) {
        setCheck({
          kind: "err",
          message: `HTTP ${response.status} ${response.statusText}`,
        });
        return;
      }
      setCheck({
        kind: "ok",
        status: response.status,
        body: JSON.stringify(data),
      });
    } catch (e) {
      setCheck({
        kind: "err",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return (
    <div className="loom-popup">
      <header>
        <h1>Loom</h1>
        <p className="subtitle">{t("popup.tagline")}</p>
      </header>

      <section>
        <label>{t("popup.enableLabel")}</label>
        <button onClick={handleToggle} type="button">
          {enabled ? t("popup.turnOff") : t("popup.turnOn")}
        </button>
        <p className={enabled ? "status status-on" : "status status-off"}>
          {enabled ? t("popup.statusOn") : t("popup.statusOff")}
        </p>
      </section>

      {IS_DEV && (
        <section>
          <label htmlFor="owner-key">Owner key (dev)</label>
          <input
            id="owner-key"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="Paste your X-Loom-Auth bypass key"
            autoComplete="off"
            spellCheck={false}
          />
          <button onClick={handleSave} type="button">
            Save
          </button>
          <p className={savedKey ? "status status-on" : "status status-off"}>
            {savedKey
              ? "Owner mode: ON — bypasses rate limits"
              : "Owner mode: off — using public rate limits"}
          </p>
        </section>
      )}

      <section>
        <button
          onClick={handleCheck}
          type="button"
          disabled={check.kind === "pending"}
        >
          {check.kind === "pending" ? t("popup.checking") : t("popup.checkApi")}
        </button>
        {check.kind === "ok" && (
          <p className="status status-ok">
            {t("popup.httpStatus", { status: check.status, body: "" })}
            <code>{check.body}</code>
          </p>
        )}
        {check.kind === "err" && (
          <p className="status status-err">
            {t("popup.error", { message: check.message })}
          </p>
        )}
      </section>

      <footer>
        <p className="footnote">
          {t("popup.apiHost", { host: "" })}
          <code>{new URL(API_BASE_URL).host}</code>
        </p>
      </footer>
    </div>
  );
}
