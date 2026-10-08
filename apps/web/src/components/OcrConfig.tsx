import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { fetchAiSettings, fetchOpencodeTopModels, type AiConfigResponse, type AiSettingsResponse, type ImageOcrMode, type OpencodeTopModelsResponse } from "../app/api";
import { useAuthStore } from "../app/auth-store";
import { useAiConfig, type SelectableAiModel } from "./AiModelBadge";

export const defaultOcrMode: ImageOcrMode = "TEXTRACT";
export const usesOcrModel = (mode: ImageOcrMode, advanced: boolean) => mode === "VISION" || mode === "TEXTRACT" && advanced;

export type OcrSelectableModel = SelectableAiModel & { visionStatus: "supported" | "unsupported" | "unconfirmed" };

export function ocrCompatibilityMessage(model: OcrSelectableModel) {
  if (model.visionStatus === "supported") return null;
  return model.visionStatus === "unsupported"
    ? `${model.name}: no admite imagenes y no es compatible con OCR de vision ni reconstruccion avanzada. Elige un modelo con vision; tu preferencia guardada no se ha cambiado.`
    : `${model.name || "Modelo OCR"}: no esta disponible en el catalogo OpenCode en vivo; capacidad de vision sin confirmar. No se puede ejecutar OCR con este modelo hasta confirmar su compatibilidad en el catalogo. Tu preferencia guardada no se ha cambiado.`;
}

export function normalizeOcrOptions(ocrMode: ImageOcrMode, advancedLayout: boolean, ocrModel: string, prompt = "") {
  const usesModel = usesOcrModel(ocrMode, advancedLayout);
  const promptOverride = prompt.trim();
  return {
    ocrMode,
    advancedLayout: advancedLayout && ocrMode !== "LOCAL",
    ...(usesModel ? { ocrModel } : {}),
    ...(usesModel && promptOverride ? { promptOverride } : {})
  };
}

export function resolveOcrModels(config?: AiConfigResponse, settings?: AiSettingsResponse, live?: OpencodeTopModelsResponse, override?: string | null) {
  const metadata = new Map<string, SelectableAiModel>();
  for (const model of live?.source === "live" ? live.models : []) {
    const id = model.id.toLowerCase();
    if (id === "test" || id === "big-pickle" || id.endsWith("-free")) continue;
    const known = config?.models.find((entry) => entry.id === model.id);
    metadata.set(model.id, { ...known, ...model });
  }
  const selectedModelId = override ?? settings?.effectiveModels.ocrModel ?? config?.ocrModel ?? "";
  const visible = settings?.settings.opencodeOcrVisibleModels ?? [];
  const models: OcrSelectableModel[] = [...metadata.values()]
    .filter((model) => model.supportsVision === true && (!visible.length || visible.includes(model.id) || model.id === selectedModelId))
    .map((model) => ({ ...model, visionStatus: "supported" }));
  const selectedMetadata = metadata.get(selectedModelId);
  const selectedModel: OcrSelectableModel = models.find((model) => model.id === selectedModelId) ?? {
    ...(selectedMetadata ?? { id: selectedModelId, name: selectedModelId, description: "Modelo no disponible en el catalogo OpenCode en vivo.", pricing: "" }),
    supportsVision: false,
    visionStatus: selectedMetadata?.supportsVision === false ? "unsupported" : "unconfirmed"
  };
  const supportsVision = selectedModel.visionStatus === "supported";
  const compatibilityMessage = ocrCompatibilityMessage(selectedModel);
  return { models, selectedModelId, selectedModel, supportsVision, status: selectedModel.visionStatus, compatibilityMessage,
    canRunOcr: (mode: ImageOcrMode, advanced: boolean) => !usesOcrModel(mode, advanced) || supportsVision };
}

export function useOcrModelSelection() {
  const config = useAiConfig();
  const accessToken = useAuthStore((state) => state.accessToken);
  const [override, setSelectedModelId] = useState<string | null>(null);
  // Misma clave que AiSettingsPage y useAiModelSelection: un solo cache para
  // ajustes IA, de modo que galería y edición de página lean siempre los mismos datos.
  const settings = useQuery({ queryKey: ["ai-settings"], queryFn: () => fetchAiSettings(accessToken!), enabled: !!accessToken, staleTime: 60_000, retry: false });
  const live = useQuery({ queryKey: ["opencode-top-models", "ocr", accessToken], queryFn: () => fetchOpencodeTopModels(accessToken!, "ocr"), enabled: !!accessToken, staleTime: 300_000, retry: false });
  const selection = resolveOcrModels(config.data, settings.data, live.isError ? undefined : live.data, override);
  // Do not execute a server fallback while the user's effective preference is unavailable.
  if (!override && (settings.isPending || settings.isError)) {
    return { ...selection, supportsVision: false, status: "unconfirmed" as const,
      compatibilityMessage: "No se pudo confirmar tu modelo OCR efectivo. Espera a que cargue la configuracion o elige un modelo compatible explicitamente.",
      canRunOcr: (mode: ImageOcrMode, advanced: boolean) => !usesOcrModel(mode, advanced), setSelectedModelId };
  }
  return { ...selection, setSelectedModelId };
}

export function AdvancedLayoutCheckbox({ value, onChange, mode, disabled, modelLabel }: {
  value: boolean; onChange: (value: boolean) => void; mode: ImageOcrMode; disabled: boolean; modelLabel: string;
}) {
  return <div className="ocr-model-select-panel ocr-advanced-layout-panel">
    <label className="ocr-advanced-layout-check">
      <input type="checkbox" checked={value && mode !== "LOCAL"} disabled={disabled || mode === "LOCAL"} onChange={(event) => onChange(event.target.checked)} />
      <span>Reconstrucción avanzada de página</span>
    </label>
    <p className="helper-text">Al activarla, combina OCR y análisis visual para intentar conservar zonas, tablas y pies de página, sin garantía. Tarda más y puede tener un mayor coste. {mode === "LOCAL" ? "No disponible con OCR LOCAL. OCR estándar, sin segunda fase de análisis visual." : !value ? "OCR estándar, sin segunda fase de análisis visual." : mode === "VISION" ? `Vision realiza dos pasadas con el mismo modelo seleccionado: ${modelLabel}.` : `Utiliza AWS Textract y el modelo seleccionado: ${modelLabel}.`}</p>
  </div>;
}

export function OcrModelSelect({ disabled = false, models, onChange, value, compatibilityMessage }: {
  disabled?: boolean; models: OcrSelectableModel[]; onChange: (model: string) => void; value: string; compatibilityMessage?: string | null;
}) {
  const selected = models.find((model) => model.id === value);
  const warning = compatibilityMessage ?? (selected ? ocrCompatibilityMessage(selected) : value ? "Tu modelo OCR guardado no esta disponible en el catalogo OpenCode en vivo. Elige un modelo compatible; tu preferencia guardada no se ha cambiado." : null);
  return <div className="ocr-model-select-panel">
    <label className="ocr-model-select-field"><span>Modelo de OCR con IA (OpenCode Zen)</span>
      <select disabled={disabled} onChange={(event) => onChange(event.target.value)} value={selected?.visionStatus === "supported" ? value : ""}>
        <option value="" disabled>Selecciona un modelo compatible</option>
        {models.filter((model) => model.visionStatus === "supported").map((model) => <option key={model.id} value={model.id}>{model.name} · {model.pricing}</option>)}
      </select>
    </label>
    {selected && <p className="helper-text">{selected.description} {selected.pricing}.</p>}
    {warning && <p className="error-text" role="alert">{warning}</p>}
    {selected?.privacyNotice && <p className="helper-text">{selected.privacyNotice}</p>}
  </div>;
}

export function OcrPromptEditor({ disabled = false, helperText, onChange, onReset, value }: {
  disabled?: boolean; helperText: string; onChange: (value: string) => void; onReset: () => void; value: string;
}) {
  return <div className="ocr-prompt-editor-panel">
    <div className="ocr-prompt-editor-header"><p className="ocr-prompt-editor-title">Mensaje user del OCR con IA</p>
      <button className="secondary-button ocr-prompt-editor-reset" disabled={disabled || !value.trim()} onClick={onReset} type="button">Restablecer</button>
    </div>
    <label className="ocr-prompt-editor-field"><span>Contenido del mensaje user</span>
      <textarea disabled={disabled} maxLength={4000} onChange={(event) => onChange(event.target.value)} rows={7} value={value} />
    </label><p className="helper-text">{helperText}</p>
  </div>;
}
