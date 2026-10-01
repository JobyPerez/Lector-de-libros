import { getAiModel, type AiModelId } from "./ai-models.js";

// Endpoint OpenAI-compatible de Google AI Studio (ver https://itsfree.ai/provider/google-ai-studio/).
// La ruta termina en /openai; el SDK nativo de Google usa otra base distinta.
export const GOOGLE_AI_OPENAI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// Mapeo de id interno (único en AI_MODELS) a id nativo del modelo en Google.
const GOOGLE_NATIVE_MODEL_IDS: Record<string, string> = {
  "gemini-2.5-flash-lite-google": "gemini-2.5-flash-lite"
};

export function isGoogleAiModel(modelId: string): boolean {
  if (modelId.endsWith("-google")) {
    return true;
  }
  return getAiModel(modelId as AiModelId).provider === "google";
}

export function getGoogleAiNativeModelId(modelId: string): string {
  return GOOGLE_NATIVE_MODEL_IDS[modelId] ?? modelId;
}

export function getGoogleAiRequestHeaders(apiKey: string | undefined): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey ?? ""}`,
    "Content-Type": "application/json"
  };
}
