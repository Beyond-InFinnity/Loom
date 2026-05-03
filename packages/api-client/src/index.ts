// @loom/api-client — typed fetch client for loom_api.
//
// Call createClient with the API base URL.  Types in ./types are
// auto-generated from loom_api's OpenAPI schema; regenerate via
// `npm run gen:api-client` from repo root after backend changes.
//
// Usage:
//   import { createLoomClient } from "@loom/api-client";
//   const api = createLoomClient("http://localhost:8765");
//   const { data, error } = await api.GET("/health");

import createClient from "openapi-fetch";
import type { paths } from "./types.js";

export type LoomClient = ReturnType<typeof createClient<paths>>;

export function createLoomClient(baseUrl: string): LoomClient {
  return createClient<paths>({ baseUrl });
}

export type { paths, components } from "./types.js";
