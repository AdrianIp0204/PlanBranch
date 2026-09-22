import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import { initializePreferences } from "./preferences";
initializePreferences();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
