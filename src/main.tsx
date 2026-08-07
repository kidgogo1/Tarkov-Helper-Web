import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { AppStoreProvider } from "./app/store";
import "./styles/global.css";
import "./styles/components.css";
import "./styles/shell.css";
import "./styles/tracker-pages.css";
import "./styles/settings.css";
import "./styles/quests.css";
import "./styles/items.css";
import "./styles/map.css";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppStoreProvider>
      <App />
    </AppStoreProvider>
  </StrictMode>,
);

