import type { FastifyInstance } from "fastify";

import { AI_MODELS, OCR_MODEL_IDS, SUMMARY_AI_MODEL_IDS } from "../../config/ai-models.js";
import { appEnv } from "../../config/env.js";

type AiProvider = "opencode" | "google" | "multi";

type AiFeature = "ocr-vision" | "section-summary" | "ai-requests";

type AiConfigResponse = {
  configured: boolean;
  defaultModel: string;
  features: AiFeature[];
  models: Array<{
    contextWindowTokens: number;
    description: string;
    id: string;
    name: string;
    pricing: string;
    privacyNotice: string;
    provider: string;
    supportsVision: boolean;
  }>;
  ocrModel: string;
  ocrModelIds: string[];
  provider: AiProvider;
  summaryModelIds: string[];
};

const AI_FEATURES: AiFeature[] = ["ocr-vision", "section-summary", "ai-requests"];

export async function registerAiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ai-config", async () => {
    const hasOpenCodeKey = Boolean(appEnv.opencodeGoApiKey);
    const hasGoogleKey = Boolean(appEnv.geminiApiKey);
    const configured = hasOpenCodeKey || hasGoogleKey;
    const provider: AiProvider = hasOpenCodeKey && hasGoogleKey ? "multi" : hasGoogleKey ? "google" : "opencode";

    const response: AiConfigResponse = {
      configured,
      defaultModel: appEnv.opencodeModel,
      features: AI_FEATURES,
      models: AI_MODELS.map(({ contextWindowTokens, description, id, name, pricing, privacyNotice, provider: modelProvider, supportsVision }) => ({
        contextWindowTokens,
        description,
        id,
        name,
        pricing,
        privacyNotice,
        provider: modelProvider,
        supportsVision
      })),
      ocrModel: appEnv.opencodeOcrModel,
      ocrModelIds: [...OCR_MODEL_IDS],
      provider,
      summaryModelIds: [...SUMMARY_AI_MODEL_IDS]
    };

    return response;
  });
}
