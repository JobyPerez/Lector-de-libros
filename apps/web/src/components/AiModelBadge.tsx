import { useQuery } from "@tanstack/react-query";

import { fetchAiConfig, type AiConfigResponse, type AiFeature } from "../app/api";

const AI_CONFIG_QUERY_KEY = ["ai-config"] as const;

type AiModelBadgeProps = {
  feature?: AiFeature;
  label?: string;
  size?: "compact" | "default";
};

const FEATURE_LABELS: Record<AiFeature, string> = {
  "ai-requests": "Peticiones IA",
  "ocr-vision": "OCR con IA",
  "outline-regenerate": "Regenerar índice",
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

export function AiModelBadge({ feature, label, size = "default" }: AiModelBadgeProps) {
  const query = useAiConfig();

  const data = query.data;
  if (!data) {
    return null;
  }

  const sizeClass = size === "compact" ? " ai-model-badge-compact" : "";
  const className = `ai-model-badge${sizeClass}`;
  const tooltip = feature
    ? `Esta pantalla usa ${FEATURE_LABELS[feature]} con el modelo de IA "${data.model}" del proveedor ${data.provider}.`
    : `Modelo de IA activo: ${data.model} (proveedor ${data.provider}).`;

  const displayLabel = label ? `${label}: ${data.model}` : `IA: ${data.model}`;

  return (
    <span aria-label={tooltip} className={className} title={tooltip}>
      {displayLabel}
    </span>
  );
}
