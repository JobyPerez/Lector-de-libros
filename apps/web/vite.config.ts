import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const workspaceRoot = resolve(__dirname, "../..");
const rootPackageJsonPath = resolve(workspaceRoot, "package.json");

function resolveGitBranch() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspaceRoot,
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

function resolveAppVersion() {
  try {
    const rootPackageJson = JSON.parse(readFileSync(rootPackageJsonPath, "utf8")) as { version?: string };
    const baseVersion = rootPackageJson.version ?? "0.1.0";
    const [major = "0", minor = "1"] = baseVersion.split(".");
    const commitCount = execSync("git rev-list --count HEAD", {
      cwd: workspaceRoot,
      encoding: "utf8"
    }).trim();

    return `${major}.${minor}.${commitCount}`;
  } catch {
    return "0.1.0";
  }
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, workspaceRoot, "");
  const appBasePath = environment.VITE_APP_BASE_PATH || "/conejolector/";
  const appVersion = resolveAppVersion();
  const appBranch = resolveGitBranch();

  return {
    base: appBasePath,
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __APP_BRANCH__: JSON.stringify(appBranch)
    },
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
