import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { captureRecoveryFragment } from "./lib/auth";

// Before React, and before the router reads the URL. A recovery link arrives as
// `#access_token=...&type=recovery`, which a HashRouter interprets as a route by
// that name — nothing matches, the catch-all sends you to the login page, and
// the session in the link is thrown away. This lifts the values out and points
// the address bar at the reset route while there is still something to lift.
captureRecoveryFragment();

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
