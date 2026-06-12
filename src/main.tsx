import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SubtitleWindow from "./SubtitleWindow";
import "./index.css";
import "./App.css";

const params = new URLSearchParams(window.location.search);
const isSubtitle = params.get("window") === "subtitle";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {isSubtitle ? <SubtitleWindow /> : <App />}
  </React.StrictMode>
);
