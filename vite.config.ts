import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { createWeaponPreviewMiddleware } from "./server/weapon-preview.mjs";

export default defineConfig({
  base: "./",
  plugins: [react(), {
    name: "local-weapon-preview",
    configureServer(server) {
      server.middlewares.use(createWeaponPreviewMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createWeaponPreviewMiddleware());
    },
  }],
  server: {
    host: "127.0.0.1",
    port: 4173,
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./tests/setup.ts",
  },
});
