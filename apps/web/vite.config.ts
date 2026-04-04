import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const workspaceRoot = resolve(__dirname, "../..");

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, workspaceRoot, "");
  const appBasePath = environment.VITE_APP_BASE_PATH || "/conejolector/";

  return {
    base: appBasePath,
    envDir: workspaceRoot,
    plugins: [
      react(),
      VitePWA({
        includeAssets: ["favicon.svg"],
        manifest: {
          background_color: "#f2e7d1",
          description: "Biblioteca personal para leer y escuchar libros.",
          display: "standalone",
          icons: [
            {
              purpose: "any",
              sizes: "192x192",
              src: "favicon.svg",
              type: "image/svg+xml"
            },
            {
              purpose: "maskable",
              sizes: "512x512",
              src: "favicon.svg",
              type: "image/svg+xml"
            }
          ],
          lang: "es",
          name: "Lector de libros",
          short_name: "Lector",
          scope: appBasePath,
          start_url: appBasePath,
          theme_color: "#264f3d"
        },
        registerType: "autoUpdate"
      })
    ],
    publicDir: resolve(__dirname, "public")
  };
});