import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@station/ui/styles.css";
import "./listener.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
