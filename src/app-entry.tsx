import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { AppErrorBoundary } from "./app/AppErrorBoundary";
import { AppStoreProvider } from "./app/store";
import { startClientLifecycle } from "./services/client-lifecycle";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/tracker-pages.css";
import "./styles/settings.css";
import "./styles/quests.css";
import "./styles/items.css";
import "./styles/prices.css";
import "./styles/weapon-modding.css";
import "./styles/map.css";
import "./styles/app.css";

export function mountApp(): () => void {
  const container = document.getElementById("root");
  if (!container) throw new Error("The application root element is missing.");
  const root = createRoot(container);
  let stopLifecycle: (() => void) | null = null;
  try {
    stopLifecycle = startClientLifecycle();
    root.render(
      <StrictMode>
        <AppErrorBoundary>
          <AppStoreProvider>
            <App />
          </AppStoreProvider>
        </AppErrorBoundary>
      </StrictMode>,
    );
  } catch (error: unknown) {
    try {
      stopLifecycle?.();
    } finally {
      try { root.unmount(); } catch { /* Bootstrap records the original failure. */ }
    }
    throw error;
  }
  return () => {
    stopLifecycle?.();
    root.unmount();
  };
}
