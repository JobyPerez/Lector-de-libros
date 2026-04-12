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
        includeAssets: ["apple-touch-icon.png", "conejo-lector-mark.jpg", "favicon.png", "pwa-192x192.png", "pwa-512x512.png"],
        manifest: {
          background_color: "#f2e7d1",
          description: "Biblioteca personal para leer y escuchar libros.",
          display: "standalone",
          icons: [
            {
              purpose: "any",
              sizes: "192x192",
              src: "pwa-192x192.png",
              type: "image/png"
            },
            {
              purpose: "any",
              sizes: "512x512",
              src: "pwa-512x512.png",
              type: "image/png"
            },
            {
              purpose: "maskable",
              sizes: "512x512",
              src: "pwa-512x512.png",
              type: "image/png"
            }
          ],
          lang: "es",
          name: "El conejo lector",
          short_name: "Conejo lector",
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