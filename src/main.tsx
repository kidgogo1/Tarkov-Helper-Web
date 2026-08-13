import { startClientBootstrap } from "./services/client-bootstrap";

const stopBootstrap = startClientBootstrap(() => import("./app-entry"));
import.meta.hot?.dispose(stopBootstrap);
