import { randomUUID } from "node:crypto";

export const OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses";
export const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";

// El free tier de OpenCode Zen solo acepta peticiones que simulan el cliente oficial:
// User-Agent "opencode/<versión>" y cabeceras x-opencode-client / x-opencode-session.
export const OPENCODE_USER_AGENT = "opencode/2026.9.0";

export function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

export function getOpenCodeGeminiEndpoint(model: string): string {
  return `${OPENCODE_ZEN_MODELS_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
}

export function getOpenCodeChatCompletionsEndpoint(model: string): string {
  return model.endsWith("-free") ? OPENCODE_ZEN_ENDPOINT : OPENCODE_GO_ENDPOINT;
}

export function getOpenCodeRequestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-session": `ses_${randomUUID().replace(/-/gu, "")}`
  };
}

export function getOpenCodeGeminiRequestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    "x-goog-api-key": apiKey ?? "",
    "Content-Type": "application/json",
    "User-Agent": OPENCODE_USER_AGENT,
    "x-opencode-client": "cli",
    "x-opencode-session": `ses_${randomUUID().replace(/-/gu, "")}`
  };
}

