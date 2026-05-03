"use client";

import { useEffect, useState } from "react";
import { createLoomClient } from "@loom/api-client";

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8765";

const api = createLoomClient(API_BASE);

type Status =
  | { kind: "loading" }
  | { kind: "ok"; payload: unknown }
  | { kind: "error"; message: string };

export function HealthCheck() {
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    api.GET("/health").then(({ data, error }) => {
      if (cancelled) return;
      if (error) {
        setStatus({ kind: "error", message: JSON.stringify(error) });
      } else {
        setStatus({ kind: "ok", payload: data });
      }
    }).catch((e) => {
      if (!cancelled) {
        setStatus({ kind: "error", message: String(e) });
      }
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="rounded border border-zinc-300 bg-white px-6 py-4 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900">
      <div className="text-zinc-500">API: {API_BASE}</div>
      {status.kind === "loading" && (
        <div className="text-zinc-400">checking /health…</div>
      )}
      {status.kind === "ok" && (
        <div className="text-emerald-600 dark:text-emerald-400">
          /health → {JSON.stringify(status.payload)}
        </div>
      )}
      {status.kind === "error" && (
        <div className="text-red-600 dark:text-red-400">
          /health failed: {status.message}
        </div>
      )}
    </div>
  );
}
