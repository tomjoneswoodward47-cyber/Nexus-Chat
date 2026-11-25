import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/query-client.js";
import App from "./App.jsx";
import { initializeNativeNotifications } from "./lib/nativeNotifications.js";
import "./index.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {
      console.warn("Service worker registration failed")
    })
  })
}

// Runs before render so a notification that launched the app is buffered rather
// than lost. It is a no-op on the web.
void initializeNativeNotifications()

createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
