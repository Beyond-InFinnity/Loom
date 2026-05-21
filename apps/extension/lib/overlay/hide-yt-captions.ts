// Hide / restore YouTube's native caption rail.
//
// 5c needs to suppress YT's own caption box while our overlay is
// active.  The rule has to apply to YouTube's own DOM, so it can't
// live inside the content script's shadow root — inject a global
// <style> into document.head instead, with a stable id so the
// inverse op is a single removeChild.

const STYLE_ID = "loom-yt-caption-suppress";

// `.ytp-caption-window-container` is the wrapper YT puts caption
// windows inside.  Hiding it removes the entire native caption rail
// without disturbing the player's own layout (controls strip, etc.).
const CSS = `.ytp-caption-window-container { display: none !important; }`;

export function hideYtCaptions(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function restoreYtCaptions(): void {
  document.getElementById(STYLE_ID)?.remove();
}
