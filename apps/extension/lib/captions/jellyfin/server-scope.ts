// Pure Jellyfin scope/identity boundary. Never accepts or stores credentials.

export interface JellyfinPlaybackIdentity {
  readonly serverBaseUrl: string;
  readonly itemId: string;
  readonly mediaSourceId: string;
  readonly key: string;
}

/** API base URL, not the web client's /web/index.html page URL. */
export function normalizeJellyfinServerBaseUrl(input: string): string {
  if (typeof input !== "string" || input.length > 2048 || /[\\\u0000-\u0020\u007f]/.test(input)) {
    throw new Error("Invalid Jellyfin server base URL");
  }
  const url = new URL(input);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username || url.password || url.search || url.hash ||
    /%(?:2f|5c|25)/i.test(url.pathname)
  ) {
    throw new Error("Jellyfin server base must be an HTTP(S) URL without credentials or query parameters");
  }
  // Keep reverse-proxy paths and nonstandard ports; URL canonicalizes origins.
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}

export function createJellyfinPlaybackIdentity(
  serverBaseUrl: string,
  itemId: string,
  mediaSourceId: string,
): JellyfinPlaybackIdentity {
  const base = normalizeJellyfinServerBaseUrl(serverBaseUrl);
  // Item IDs are server GUIDs. Media-source IDs are opaque, but only a single
  // bounded path-safe component is admitted by this first integration slice.
  if (typeof itemId !== "string" || !/^(?:[a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})$/i.test(itemId)) {
    throw new Error("Invalid Jellyfin item identity");
  }
  if (typeof mediaSourceId !== "string" || !/^[A-Za-z\d_-]{1,200}$/.test(mediaSourceId)) {
    throw new Error("Unsupported Jellyfin media-source identity");
  }
  const item = itemId.replace(/-/g, "").toLowerCase();
  return Object.freeze({
    serverBaseUrl: base, itemId: item, mediaSourceId,
    key: JSON.stringify(["jellyfin", base, item, mediaSourceId]),
  });
}

export function jellyfinSubtitleTrackId(identity: JellyfinPlaybackIdentity, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 2_147_483_647) {
    throw new Error("Invalid Jellyfin subtitle stream index");
  }
  return JSON.stringify([identity.key, index]);
}