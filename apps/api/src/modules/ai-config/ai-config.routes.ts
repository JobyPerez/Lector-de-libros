import type { FastifyInstance } from "fastify";

import { appEnv } from "../../config/env.js";

type AiProvider = "opencode";

type AiFeature = "ocr-vision" | "section-summary" | "ai-requests" | "outline-regenerate";

type AiConfigResponse = {
  configured: boolean;
  features: AiFeature[];
  model: string;
  provider: AiProvider;
};

const AI_FEATURES: AiFeature[] = ["ocr-vision", "section-summary", "ai-requests", "outline-regenerate"];

export async function registerAiConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get("/ai-config", async () => {
    const model = appEnv.opencodeModel;
    const configured = Boolean(appEnv.opencodeGoApiKey) && model.length > 0;

    const response: AiConfigResponse = {
      configured,
      features: AI_FEATURES,
      model,
      provider: "opencode"
    };

    return response;
  });
}
