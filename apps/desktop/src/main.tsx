import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initDesktopStorage } from "./player/host";

// Warm the shared settings store before mounting so the settings UI reads
// persisted values synchronously (no flash of defaults) and stays in sync
// with the player window.
void initDesktopStorage().then(() => {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
