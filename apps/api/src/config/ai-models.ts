import { z } from "zod";

export const AI_MODELS = [
  {
    contextWindowTokens: 1_000_000,
    description: "Recomendado para libros completos o textos muy largos.",
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra",
    privacyNotice: "Uso de prueba: no envíes datos personales o confidenciales. NVIDIA registra el uso y puede emplearlo para mejorar sus productos.",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 200_000,
    description: "Recomendado para resúmenes por capítulos y buena redacción.",
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash",
    privacyNotice: "Durante el periodo gratuito, el contenido enviado puede utilizarse para mejorar el modelo.",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: false
  },
  {
    contextWindowTokens: 200_000,
    description: "Recomendado para PDF escaneado, imágenes y contenido multimodal.",
    id: "mimo-v2.5-free",
    name: "MiMo V2.5",
    privacyNotice: "Durante el periodo gratuito, el contenido enviado puede utilizarse para mejorar el modelo.",
    summaryChunkTargetCharacters: 320_000,
    supportsVision: true
  }
] as const;

export type AiModelId = (typeof AI_MODELS)[number]["id"];
export type SummaryAiModelId = Exclude<AiModelId, "mimo-v2.5-free">;

export const DEFAULT_AI_MODEL_ID: SummaryAiModelId = "deepseek-v4-flash-free";
export const DEFAULT_OCR_MODEL_ID = "mimo-v2.5-free" as const;
export const aiModelIdSchema = z.enum(AI_MODELS.map((model) => model.id) as [AiModelId, ...AiModelId[]]);
export const SUMMARY_AI_MODEL_IDS = ["nemotron-3-ultra-free", "deepseek-v4-flash-free"] as const satisfies readonly SummaryAiModelId[];
export const summaryAiModelIdSchema = z.enum(SUMMARY_AI_MODEL_IDS);
export const ocrModelIdSchema = z.literal(DEFAULT_OCR_MODEL_ID);

export function getAiModel(modelId: AiModelId) {
  return AI_MODELS.find((model) => model.id === modelId) ?? AI_MODELS[0];
}
