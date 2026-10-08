type ModelMetadata = {
  opencode?: { models?: Record<string, { modalities?: { input?: unknown[]; output?: unknown[] } }> };
};

let metadataCache: { expiresAt: number; payload: ModelMetadata } | null = null;

// Public capabilities only, never authenticated model availability or saved choices.
export function getCachedOpenCodeVisionCapability(modelId: string): boolean | undefined {
  const models = metadataCache?.payload.opencode?.models;
  const model = models && Object.hasOwn(models, modelId) ? models[modelId] : undefined;
  if (!Array.isArray(model?.modalities?.input) || !Array.isArray(model?.modalities?.output)) return undefined;
  return model.modalities.input.includes("image") && model.modalities.output.includes("text");
}

export async function fetchModelMetadata(refresh: boolean): Promise<unknown> {
  if (!refresh && metadataCache && metadataCache.expiresAt > Date.now()) return metadataCache.payload;
  if (refresh) metadataCache = null;
  const response = await fetch("https://models.dev/api.json", { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`models.dev devolvio ${response.status}.`);
  const payload = await response.json() as ModelMetadata;
  if (!payload?.opencode?.models || typeof payload.opencode.models !== "object" || Array.isArray(payload.opencode.models)) {
    throw new Error("models.dev no publico metadatos del proveedor opencode.");
  }
  metadataCache = { expiresAt: Date.now() + 5 * 60 * 1000, payload };
  return payload;
}
