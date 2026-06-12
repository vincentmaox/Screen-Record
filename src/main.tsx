import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import SubtitleWindow from "./SubtitleWindow";
import MiniBar from "./MiniBar";
import "./index.css";
import "./App.css";

const params = new URLSearchParams(window.location.search);
const which = params.get("window");

let view: React.ReactNode;
if (which === "subtitle") view = <SubtitleWindow />;
else if (which === "minibar") view = <MiniBar />;
else view = <App />;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>{view}</React.StrictMode>
);
