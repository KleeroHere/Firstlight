import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/cascade.css";
import "./styles/global.css";
import "./styles/surfaces.css";
import "./styles/firstlight.css";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
