import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";

import { getRouter } from "./router";
import "./styles.css";

// Plain SPA entrypoint — replaces TanStack Start's server-side
// rendering with client-side mount. The router still does the same
// thing; it just renders into a div instead of a streamed HTML doc.
const router = getRouter();

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("#root element missing — check index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
