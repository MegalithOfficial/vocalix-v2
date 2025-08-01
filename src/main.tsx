import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./utils/logger"; // Initialize logger and console overrides

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
