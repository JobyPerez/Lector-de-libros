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
  },
  {
    contextWindowTokens: 1_000_000,
    description: "Modelo multimodal gratuito con política de retención cero.",
    id: "x-preview-f-free",
    name: "Ox Alpha Free",
    privacyNotice: "El proveedor aplica una política de retención cero y no utiliza los datos para entrenar modelos.",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: true
  },
  {
    contextWindowTokens: 1_048_576,
    description: "Modelo multimodal gratuito de Meta disponible para colaboradores.",
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 Contributor Free",
    privacyNotice: "Los prompts y las respuestas pueden utilizarse para entrenar futuros modelos de Meta.",
    summaryChunkTargetCharacters: 1_600_000,
    supportsVision: true
  }
] as const;

export type AiModelId = (typeof AI_MODELS)[number]["id"];
export const SUMMARY_AI_MODEL_IDS = ["nemotron-3-ultra-free", "deepseek-v4-flash-free"] as const;
export const OCR_MODEL_IDS = ["mimo-v2.5-free", "x-preview-f-free", "muse-spark-1.2-contributor-free"] as const;
export type SummaryAiModelId = (typeof SUMMARY_AI_MODEL_IDS)[number];
export type OcrModelId = (typeof OCR_MODEL_IDS)[number];

export const DEFAULT_AI_MODEL_ID: SummaryAiModelId = "deepseek-v4-flash-free";
export const DEFAULT_OCR_MODEL_ID: OcrModelId = "mimo-v2.5-free";
export const aiModelIdSchema = z.enum(AI_MODELS.map((model) => model.id) as [AiModelId, ...AiModelId[]]);
export const summaryAiModelIdSchema = z.enum(SUMMARY_AI_MODEL_IDS);
export const ocrModelIdSchema = z.enum(OCR_MODEL_IDS);

export function getAiModel(modelId: AiModelId) {
  return AI_MODELS.find((model) => model.id === modelId) ?? AI_MODELS[0];
}
