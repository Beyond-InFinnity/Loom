import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("onboarding: #root not found");

ReactDOM.createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
