import ReactDOM from "react-dom/client";
import { PlayerWindow } from "./player-window/main";
import { initDesktopStorage } from "./player/host";

// Single integrated Loom Player window (MOBILE_ROADMAP.md §5a): libmpv renders
// the video into a GtkGLArea behind this (transparent) webview; the DOM is the
// transport bar + caption stack + in-window settings + pause-gloss card.
//
// NO React.StrictMode: the player's mount effect owns NATIVE resources (the
// libmpv handle + render context via player_attach).  StrictMode's double
// mount→unmount→mount would terminate mpv mid-setup and race commands on the
// freed handle (segfault).  Warm the settings store first so the UI reads
// persisted values synchronously (no flash of defaults).
void initDesktopStorage().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <PlayerWindow />,
  );
});
