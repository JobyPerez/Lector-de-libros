import type { FastifyInstance } from "fastify";

import { AI_MODELS, SUMMARY_AI_MODEL_IDS } from "../../config/ai-models.js";
import { appEnv } from "../../config/env.js";

type AiProvider = "opencode";

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
    privacyNotice: string;
    supportsVision: boolean;
  }>;
  ocrModel: string;
  provider: AiProvider;
  summaryModelIds: string[];
};

const AI_FEATURES: AiFeature[] = ["ocr-vision", "section-summary", "ai-requests"];

export async function registerAiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ai-config", async () => {
    const configured = Boolean(appEnv.opencodeGoApiKey);

    const response: AiConfigResponse = {
      configured,
      defaultModel: appEnv.opencodeModel,
      features: AI_FEATURES,
      models: AI_MODELS.map(({ contextWindowTokens, description, id, name, privacyNotice, supportsVision }) => ({
        contextWindowTokens,
        description,
        id,
        name,
        privacyNotice,
        supportsVision
      })),
      ocrModel: appEnv.opencodeOcrModel,
      provider: "opencode",
      summaryModelIds: [...SUMMARY_AI_MODEL_IDS]
    };

    return response;
  });
}
