import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { initUiLocale } from "@/lib/i18n";
import { App } from "./app";

initUiLocale();

const root = document.getElementById("root");
if (!root) throw new Error("onboarding: #root not found");

ReactDOM.createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
