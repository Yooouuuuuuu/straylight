import ReactDOM from "react-dom/client";

import "./theme/dracula.css";
import "./theme/tokens.css";
import "./theme/fonts.css";
import "./styles/global.css";
import "@xterm/xterm/css/xterm.css";

import App from "./App";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root was not found");
}

// Note: StrictMode is intentionally omitted. Monaco and xterm.js manage their
// own imperative lifecycles and don't tolerate StrictMode's deliberate double
// mount/unmount in development.
ReactDOM.createRoot(container).render(<App />);
