import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { fetchAiConfig, type AiConfigResponse, type AiFeature, type AiModelId, type AiModelOption, type SummaryAiModelId } from "../app/api";

const AI_CONFIG_QUERY_KEY = ["ai-config"] as const;
const AI_MODEL_STORAGE_KEY = "lector.ai.model";

type AiModelBadgeProps = {
  feature?: AiFeature;
  label?: string;
  modelId?: AiModelId | null | undefined;
  size?: "compact" | "default";
};

type AiModelSelectorProps = {
  disabled?: boolean;
  models: AiModelOption[];
  onChange: (modelId: SummaryAiModelId) => void;
  value: SummaryAiModelId;
};

const FEATURE_LABELS: Record<AiFeature, string> = {
  "ai-requests": "Peticiones IA",
  "ocr-vision": "OCR con IA",
  "section-summary": "Resumen de sección"
};

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
  const [storedModelId, setStoredModelId] = useState<string>(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.localStorage.getItem(AI_MODEL_STORAGE_KEY) ?? "";
  });
  const summaryModelIds = query.data?.summaryModelIds ?? [];
  const summaryModels = (query.data?.models ?? []).filter(
    (model): model is AiModelOption & { id: SummaryAiModelId } => summaryModelIds.includes(model.id as SummaryAiModelId)
  );
  const configuredModel = summaryModels.find((model) => model.id === storedModelId);
  const selectedModelId = configuredModel?.id ?? query.data?.defaultModel;

  useEffect(() => {
    if (!selectedModelId || typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(AI_MODEL_STORAGE_KEY, selectedModelId);
  }, [selectedModelId]);

  return {
    ...query,
    models: summaryModels,
    selectedModel: summaryModels.find((model) => model.id === selectedModelId),
    selectedModelId,
    setSelectedModelId: (modelId: SummaryAiModelId) => setStoredModelId(modelId)
  };
}

export function AiModelSelector({ disabled = false, models, onChange, value }: AiModelSelectorProps) {
  const selectedModel = models.find((model) => model.id === value);

  return (
    <label className="ai-model-selector">
      <span>Modelo de IA</span>
      <select disabled={disabled} onChange={(event) => onChange(event.target.value as SummaryAiModelId)} value={value}>
        {models.map((model) => (
          <option key={model.id} value={model.id}>{model.name}</option>
        ))}
      </select>
      {selectedModel ? <span className="subdued">{selectedModel.description}</span> : null}
      {selectedModel ? <span className="ai-model-privacy-notice">{selectedModel.privacyNotice}</span> : null}
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
