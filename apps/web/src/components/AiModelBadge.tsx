import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchAiConfig, fetchAiSettings, fetchOpencodeTopModels, type AiConfigResponse, type AiFeature } from "../app/api";
import { useAuthStore } from "../app/auth-store";

const AI_CONFIG_QUERY_KEY = ["ai-config"] as const;
const AI_MODEL_STORAGE_KEY = "lector.ai.model";

export type SelectableAiModel = {
  description: string;
  id: string;
  name: string;
  pricing: string;
  privacyNotice?: string;
  provider?: string;
  supportsVision?: boolean;
};

type AiModelBadgeProps = {
  feature?: AiFeature;
  label?: string;
  modelId?: string | null | undefined;
  size?: "compact" | "default";
};

type AiModelSelectorProps = {
  disabled?: boolean;
  models: SelectableAiModel[];
  onChange: (modelId: string) => void;
  value: string;
};

const FEATURE_LABELS: Record<AiFeature, string> = {
  "ai-requests": "Peticiones IA",
  "ocr-vision": "OCR con IA",
  "section-summary": "Resumen de sección"
};

// Los gratuitos de Zen solo funcionan dentro del cliente OpenCode (403 FreeTierError
// con clave de servidor). El gratis de Google va por AI Studio y sí vale.
function isFreeZenModelId(id: string | null | undefined): boolean {
  const cleanId = (id ?? "").trim().toLowerCase();
  if (!cleanId) return false;
  if (cleanId === "test" || cleanId === "big-pickle") return true;
  return cleanId.endsWith("-free");
}

export function useAiConfig() {
  return useQuery<AiConfigResponse>({
    queryFn: () => fetchAiConfig(),
    queryKey: AI_CONFIG_QUERY_KEY,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5 * 60 * 1000
  });
}

export function useAiModelSelection() {
  const query = useAiConfig();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [storedModelId, setStoredModelId] = useState<string>(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? "";
  });

  const settingsQuery = useQuery({
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchAiSettings(accessToken);
    },
    queryKey: ["ai-settings"],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 60 * 1000
  });

  const liveModelsQuery = useQuery({
    enabled: Boolean(accessToken),
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchOpencodeTopModels(accessToken, "summary");
    },
    queryKey: ["opencode-top-models", "summary"],
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 5 * 60 * 1000
  });

  // Mapa de metadatos: estáticos curados de pago + top-5 en vivo (solo pago).
  const metadataById = new Map<string, SelectableAiModel>();
  const summaryModelIds = (query.data?.summaryModelIds ?? []) as string[];
  for (const model of query.data?.models ?? []) {
    if (isFreeZenModelId(model.id)) continue;
    if (summaryModelIds.includes(model.id)) {
      metadataById.set(model.id, {
        description: model.description,
        id: model.id,
        name: model.name,
        pricing: model.pricing,
        privacyNotice: model.privacyNotice,
        provider: model.provider,
        supportsVision: model.supportsVision
      });
    }
  }
  // Asegurar también el modelo gratuito de Google aunque no esté en summaryModelIds por cambios de config.
  for (const model of query.data?.models ?? []) {
    if (model.id === "gemini-2.5-flash-lite-google" && !metadataById.has(model.id)) {
      metadataById.set(model.id, {
        description: model.description,
        id: model.id,
        name: model.name,
        pricing: model.pricing,
        privacyNotice: model.privacyNotice,
        provider: model.provider,
        supportsVision: model.supportsVision
      });
    }
  }
  for (const model of liveModelsQuery.data?.models ?? []) {
    if (isFreeZenModelId(model.id)) continue;
    if (!metadataById.has(model.id)) {
      metadataById.set(model.id, {
        description: model.description,
        id: model.id,
        name: model.name,
        pricing: model.pricing,
        provider: "opencode",
        supportsVision: model.supportsVision
      });
    }
  }

  const visibleIds = (settingsQuery.data?.settings.opencodeSummaryVisibleModels ?? []).filter((id) => !isFreeZenModelId(id));
  const rawUserDefault = settingsQuery.data?.settings.opencodeSummaryModel
    ?? settingsQuery.data?.effectiveModels.summaryModel
    ?? undefined;
  // Un por-defecto gratuito guardado ya no sirve: se ignora y se usa el del servidor.
  const userDefaultModel = rawUserDefault && !isFreeZenModelId(rawUserDefault) ? rawUserDefault : undefined;

  let finalModels: SelectableAiModel[];
  if (visibleIds.length > 0) {
    // El usuario marcó qué modelos quiere ver en Configuración IA: respetar exactamente esa lista.
    finalModels = visibleIds.map((id) => metadataById.get(id) ?? {
      description: "Modelo guardado en tu configuración.",
      id,
      name: id,
      pricing: "Guardado"
    });
    if (userDefaultModel && !finalModels.some((model) => model.id === userDefaultModel)) {
      finalModels = [
        ...finalModels,
        metadataById.get(userDefaultModel) ?? {
          description: "Modelo por defecto guardado en tu configuración.",
          id: userDefaultModel,
          name: userDefaultModel,
          pricing: "Guardado"
        }
      ];
    }
  } else {
    // Sin filtro guardado ("ver todos"): estáticos + en vivo.
    finalModels = Array.from(metadataById.values());
    if (userDefaultModel && !finalModels.some((model) => model.id === userDefaultModel)) {
      finalModels = [
        ...finalModels,
        {
          description: "Modelo por defecto guardado en tu configuración.",
          id: userDefaultModel,
          name: userDefaultModel,
          pricing: "Guardado"
        }
      ];
    }
    if (finalModels.length === 0) {
      finalModels = (query.data?.models ?? []).filter((model) => !isFreeZenModelId(model.id)).map((model) => ({
        description: model.description,
        id: model.id,
        name: model.name,
        pricing: model.pricing,
        privacyNotice: model.privacyNotice,
        provider: model.provider,
        supportsVision: model.supportsVision
      }));
    }
  }

  const configuredModel = finalModels.find((model) => model.id === storedModelId);
  const selectedModelId = configuredModel?.id
    ?? (userDefaultModel && finalModels.some((model) => model.id === userDefaultModel) ? userDefaultModel : undefined)
    ?? query.data?.defaultModel
    ?? finalModels[0]?.id
    ?? "";

  useEffect(() => {
    if (!selectedModelId || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(AI_MODEL_STORAGE_KEY, selectedModelId);
  }, [selectedModelId]);

  return {
    ...query,
    models: finalModels,
    selectedModel: finalModels.find((model) => model.id === selectedModelId),
    selectedModelId,
    setSelectedModelId: (modelId: string) => setStoredModelId(modelId)
  };
}

export function AiModelSelector({ disabled = false, models, onChange, value }: AiModelSelectorProps) {
  const selectedModel = models.find((model) => model.id === value);

  return (
    <label className="ai-model-selector">
      <span>Modelo de IA</span>
      <select disabled={disabled} onChange={(event) => onChange(event.target.value)} value={value}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>{model.name} · {model.pricing}</option>
        ))}
      </select>
      {selectedModel ? <span className="subdued">{selectedModel.description} ({selectedModel.pricing}).</span> : null}
      {selectedModel?.privacyNotice ? <span className="ai-model-privacy-notice">{selectedModel.privacyNotice}</span> : null}
    </label>
  );
}

export function AiModelBadge({ feature, label, modelId, size = "default" }: AiModelBadgeProps) {
  const query = useAiConfig();

  const data = query.data;
  if (!data) {
    return null;
  }

  const sizeClass = size === "compact" ? " ai-model-badge-compact" : "";
  const className = `ai-model-badge${sizeClass}`;
  const activeModelId = modelId === null
    ? null
    : modelId ?? (feature === "ocr-vision" ? data.ocrModel : data.defaultModel);
  const activeModel = data.models.find((model) => model.id === activeModelId);
  const modelLabel = activeModel?.name ?? activeModelId ?? "modelo histórico desconocido";
  const tooltip = feature
    ? `Esta pantalla usa ${FEATURE_LABELS[feature]} con el modelo de IA "${modelLabel}" del proveedor ${data.provider}.`
    : `Modelo de IA: ${modelLabel} (proveedor ${data.provider}).`;

  const displayLabel = label ? `${label}: ${modelLabel}` : `IA: ${modelLabel}`;

  return (
    <span aria-label={tooltip} className={className} title={tooltip}>
      {displayLabel}
    </span>
  );
}
