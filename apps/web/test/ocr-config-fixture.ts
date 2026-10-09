import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import ts from "typescript";
import type * as OcrConfig from "../src/components/OcrConfig";

const require = createRequire(import.meta.url);
// Load actual shared controls and logic without importing the Vite-only API module.
export function loadOcrConfig(config?: unknown, settings?: unknown, live?: unknown, settingsStatus?: "pending" | "error", liveStatus?: "error", state = { userId: "user-a", settings }) {
  const code = ts.transpileModule(readFileSync(new URL("../src/components/OcrConfig.tsx", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText;
  const exports = {} as typeof OcrConfig;
  const mocks: Record<string, unknown> = {
    "../app/api": { aiSettingsQueryKey: (id: string) => ["ai-settings", id], aiCatalogQueryKey: (id: string, purpose: string) => ["opencode-top-models", purpose, id] },
    "../app/auth-store": { useAuthStore: (selector: (state: unknown) => unknown) => selector({ accessToken: "synthetic-token", user: { userId: state.userId } }) },
    "./AiModelBadge": { useAiConfig: () => ({ data: config }) },
    "@tanstack/react-query": { useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queryKey[0] === "ai-settings" ? state.settings : live, isPending: queryKey[0] === "ai-settings" && settingsStatus === "pending", isError: queryKey[0] === "ai-settings" ? settingsStatus === "error" : liveStatus === "error" }) }
  };
  new Function("exports", "require", code)(exports, (id: string) => mocks[id] ?? require(id));
  return exports;
}
