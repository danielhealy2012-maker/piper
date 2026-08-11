import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

// A tab left open across a new deploy still holds the OLD index.html, which
// references content-hashed chunk files (e.g. the lazy-loaded
// @babel/standalone chunk customComponents need) that may no longer exist
// once a newer build has replaced them. Vercel's catch-all rewrite then
// serves index.html (text/html) for that now-missing chunk instead of a
// 404, and the browser fails with "'text/html' is not a valid JavaScript
// MIME type" — a real error, but the fix is just "reload to get the
// current index.html", not something the user should have to diagnose.
// Vite fires this exact event for exactly this failure; auto-reload once
// (sessionStorage guard so a genuinely broken deploy can't reload-loop).
window.addEventListener("vite:preloadError", () => {
  if (sessionStorage.getItem("piper_reloaded_after_preload_error")) return;
  sessionStorage.setItem("piper_reloaded_after_preload_error", "1");
  window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// This run reached here at all, so the current index.html/module graph is
// healthy — clear the guard so a LATER deploy's staleness (a real scenario
// across a long tab session with frequent deploys) still gets one
// auto-reload of its own, instead of the guard silently blocking every
// preload error for the rest of this tab's life after the first one.
sessionStorage.removeItem("piper_reloaded_after_preload_error");
