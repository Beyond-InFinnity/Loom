import ReactDOM from "react-dom/client";

import { CaptionStreamProvider } from "@/components/caption-context";
import { LoomPill } from "@/components/loom-pill";

// Content script for YouTube watch pages.
//
// 5a: mounted a static "Loom active" pill in a shadow root.
// 5b: wraps the tree in <CaptionStreamProvider> which:
//   - discovers YT caption tracks from ytInitialPlayerResponse
//   - auto-picks ja/zh family for v1
//   - fetches the chosen track + a tlang=en translation in parallel
//   - hooks <video>.timeupdate to find the active caption each tick
//   - listens for yt-navigate-finish so SPA navigations re-init cleanly
//
// LoomPill is now status-aware — its label reflects the stream's
// lifecycle (detecting → tracking → unsupported / error).  Until 5c
// renders an overlay, the pill is the only visible 5b signal.
//
// Shadow-root isolation prevents YouTube's stylesheets from leaking
// into our DOM (and vice versa).  `position: "inline"` anchored to
// <body> is the minimal mount — the pill's `position: fixed` styling
// handles actual placement.

export default defineContentScript({
  matches: ["*://*.youtube.com/watch*"],
  cssInjectionMode: "ui",
  runAt: "document_idle",

  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: "loom-overlay-root",
      position: "inline",
      anchor: "body",
      onMount: (container) => {
        const root = ReactDOM.createRoot(container);
        root.render(
          <CaptionStreamProvider>
            <LoomPill />
          </CaptionStreamProvider>,
        );
        return root;
      },
      onRemove: (root) => {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
