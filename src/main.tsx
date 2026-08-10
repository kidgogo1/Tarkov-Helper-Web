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
import "./styles/map.css";
import "./styles/app.css";

startClientLifecycle();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <AppStoreProvider>
        <App />
      </AppStoreProvider>
    </AppErrorBoundary>
  </StrictMode>,
);
