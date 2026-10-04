import { z } from "zod";

export const AI_MODELS = [
  {
    contextWindowTokens: 1_000_000,
    description: "Recomendado para libros completos o textos muy largos.",
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra",
    pricing: "Gratuito (solo dentro de OpenCode)",
    privacyNotice: "Uso de prueba: no envíes datos personales o confidenciales. NVIDIA registra el uso y puede emplearlo para mejorar sus productos.",
    provider: "opencode",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 200_000,
    description: "Recomendado para resúmenes por capítulos y buena redacción.",
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash",
    pricing: "Gratuito (solo dentro de OpenCode)",
    privacyNotice: "Durante el periodo gratuito, el contenido enviado puede utilizarse para mejorar el modelo.",
    provider: "opencode",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 200_000,
    description: "El más barato para resúmenes por capítulos y buena redacción en español.",
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    pricing: "Zen: $0.14 entrada / $0.28 salida por 1M tokens",
    privacyNotice: "El contenido enviado se procesa a través de OpenCode Zen con retención cero. No se usa para entrenar modelos.",
    provider: "opencode",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 200_000,
    description: "Alternativa económica para resúmenes por capítulos.",
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    pricing: "Zen: $0.15 entrada / $0.50 salida por 1M tokens",
    privacyNotice: "El contenido enviado se procesa a través de OpenCode Zen con retención cero. No se usa para entrenar modelos.",
    provider: "opencode",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 400_000,
    description: "Opción económica para OCR de páginas nítidas y extracción de texto.",
    id: "gpt-5.4-nano",
    name: "GPT-5.4 Nano",
    pricing: "Zen: $0.20 entrada / $1.25 salida por 1M tokens",
    privacyNotice: "El contenido se procesa a través de OpenCode Zen / OpenAI. OpenAI puede conservar las peticiones durante 30 días; no se usan para entrenar modelos.",
    provider: "opencode",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: true
  },
  {
    contextWindowTokens: 400_000,
    description: "Alternativa de mayor capacidad para OCR de páginas difíciles y maquetación compleja.",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    pricing: "Zen: $0.75 entrada / $4.50 salida por 1M tokens",
    privacyNotice: "El contenido se procesa a través de OpenCode Zen / OpenAI. OpenAI puede conservar las peticiones durante 30 días; no se usan para entrenar modelos.",
    provider: "opencode",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: true
  },
  {
    contextWindowTokens: 1_000_000,
    description: "Modelo multimodal rápido y eficiente de Google recomendado para OCR y resúmenes.",
    id: "gemini-3.5-flash-lite",
    name: "Gemini 3.5 Flash Lite",
    pricing: "Zen: $0.30 entrada / $2.50 salida por 1M tokens",
    privacyNotice: "El contenido enviado se procesa a través de la API de OpenCode Zen / Google.",
    provider: "opencode",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: true
  },
  {
    contextWindowTokens: 1_000_000,
    description: "Opción gratuita directa de Google para resúmenes por capítulos y libros largos.",
    id: "gemini-2.5-flash-lite-google",
    name: "Gemini 2.5 Flash Lite (Google gratis)",
    pricing: "Google AI Studio: gratis (15 req/min, 1.500 req/día)",
    privacyNotice: "El plan gratuito de Google puede usar los prompts y respuestas para mejorar sus modelos. No envíes datos confidenciales. Sin tarjeta mientras no vincules facturación.",
    provider: "google",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: false
  }
] as const;

export type AiModelId = (typeof AI_MODELS)[number]["id"];
export const SUMMARY_AI_MODEL_IDS = ["deepseek-v4-flash", "glm-5.3-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite-google"] as const;
export const OCR_MODEL_IDS = ["gemini-3.5-flash-lite", "gpt-5.4-nano", "gpt-5.4-mini"] as const;
export type SummaryAiModelId = (typeof SUMMARY_AI_MODEL_IDS)[number];
export type OcrModelId = (typeof OCR_MODEL_IDS)[number];

export const DEFAULT_AI_MODEL_ID: SummaryAiModelId = "deepseek-v4-flash";
export const DEFAULT_OCR_MODEL_ID: OcrModelId = "gemini-3.5-flash-lite";
export const aiModelIdSchema = z.enum(AI_MODELS.map((model) => model.id) as [AiModelId, ...AiModelId[]]);
export const summaryAiModelIdSchema = z.enum(SUMMARY_AI_MODEL_IDS);
export const ocrModelIdSchema = z.enum(OCR_MODEL_IDS);

export function getAiModel(modelId: string) {
  return AI_MODELS.find((model) => model.id === modelId) ?? AI_MODELS[0]!;
}
