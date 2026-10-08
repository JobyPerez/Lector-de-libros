import { randomUUID } from "node:crypto";

export const OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_RESPONSES_ENDPOINT = "https://opencode.ai/zen/v1/responses";
export const OPENCODE_MESSAGES_ENDPOINT = "https://opencode.ai/zen/v1/messages";
export const OPENCODE_ZEN_MODELS_ENDPOINT = "https://opencode.ai/zen/v1/models";

// El free tier de OpenCode Zen solo acepta peticiones que simulan el cliente oficial:
// User-Agent "opencode/<versión>" y cabeceras x-opencode-client / x-opencode-session.
export const OPENCODE_USER_AGENT = "opencode/2026.9.0";

export function isGeminiModel(model: string): boolean {
  return model.startsWith("gemini-");
}

/**
 * Modelos que solo hablan el protocolo Responses API (/zen/v1/responses).
 * Por /chat/completions devuelven 400 "ModelProtocolUnsupported".
 * Segun https://opencode.ai/docs/zen: gpt-*, muse-spark-*, grok-*.
 */
export function isResponsesApiModel(model: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return normalizedModel.startsWith("gpt-") || normalizedModel.startsWith("muse-spark-") || normalizedModel.startsWith("grok-");
}

export function isAnthropicMessagesModel(model: string): boolean {
  return model.startsWith("claude-") || ["qwen3.8-flash", "qwen3.7-max", "qwen3.7-plus", "qwen3.6-plus", "qwen3.5-plus"].includes(model);
}

export function getOpenCodeMessagesRequestHeaders(apiKey: string | undefined): Record<string, string> {
  const { Authorization: _authorization, ...headers } = getOpenCodeRequestHeaders(apiKey);
  return { ...headers, "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" };
}

/**
 * Las claves Go (sk-...) rinden mejor en /zen/go/v1 y las Zen (z-...) en /zen/v1.
 * Como algunos modelos solo están enrutados en uno de los dos (p. ej.
 * deepseek-v4-flash devuelve 404 en /zen/v1 con clave Go), el orden solo es
 * preferencia: ante un 404 de ruta se prueba el otro endpoint.
 */
export function isGoApiKey(apiKey: string | null | undefined): boolean {
  return (apiKey ?? "").trim().toLowerCase().startsWith("sk-");
}

export function resolveOpenCodeChatEndpoints(apiKey: string | null | undefined): [string, string] {
  return isGoApiKey(apiKey)
    ? [OPENCODE_GO_ENDPOINT, OPENCODE_ZEN_ENDPOINT]
    : [OPENCODE_ZEN_ENDPOINT, OPENCODE_GO_ENDPOINT];
}

export type ResponsesApiResponse = {
  error?: {
    code?: string;
    message?: string;
    param?: string | null;
    type?: string;
  };
  incomplete_details?: {
    reason?: string;
  } | null;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
    type?: string;
  }>;
  output_text?: string;
  status?: string;
};

export function extractResponsesApiText(payload: ResponsesApiResponse): string {
  if (payload.output_text?.trim()) {
    return payload.output_text.trim();
  }

  return (payload.output ?? [])
    // Untyped items/blocks occur in existing compatible-provider fixtures. Explicit
    // reasoning/tool/refusal types are never final message text, even if they have text.
    .filter((item) => item.type === undefined || item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === undefined || item.type === "output_text")
    .map((item) => typeof item.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function getOpenCodeGeminiEndpoint(model: string): string {
  return `${OPENCODE_ZEN_MODELS_ENDPOINT}/${encodeURIComponent(model)}:generateContent`;
}

export function getOpenCodeChatCompletionsEndpoint(_model: string): string {
  // Compatibilidad: los resúmenes eligen endpoint según clave (Go/Zen) con
  // conmutación ante 404. Los "-free" están bloqueados fuera de OpenCode.
  return OPENCODE_ZEN_ENDPOINT;
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
