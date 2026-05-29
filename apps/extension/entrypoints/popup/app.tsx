import { useEffect, useState } from "react";

import { getApiClient } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/env";
import { getOwnerKey, setOwnerKey } from "@/lib/owner-key";

type CheckStatus =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ok"; status: number; body: string }
  | { kind: "err"; message: string };

export function App() {
  const [keyInput, setKeyInput] = useState("");
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [check, setCheck] = useState<CheckStatus>({ kind: "idle" });

  useEffect(() => {
    getOwnerKey()
      .then((stored) => {
        setSavedKey(stored);
        if (stored) setKeyInput(stored);
      })
      .catch((e) => {
        console.error("[Loom] failed to read owner key from storage:", e);
      });
  }, []);

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
        <p className="subtitle">Dual subs for foreign-language video.</p>
      </header>

      <section>
        <label htmlFor="owner-key">Owner key</label>
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

      <section>
        <button
          onClick={handleCheck}
          type="button"
          disabled={check.kind === "pending"}
        >
          {check.kind === "pending" ? "Checking…" : "Check API"}
        </button>
        {check.kind === "ok" && (
          <p className="status status-ok">
            HTTP {check.status}: <code>{check.body}</code>
          </p>
        )}
        {check.kind === "err" && (
          <p className="status status-err">Error: {check.message}</p>
        )}
      </section>

      <footer>
        <p className="footnote">
          API: <code>{new URL(API_BASE_URL).host}</code>
        </p>
      </footer>
    </div>
  );
}
