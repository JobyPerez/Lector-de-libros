import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";

import {
  aiSettingsQueryKey,
  aiCatalogQueryKey,
  fetchAiConfig,
  fetchAiSettings,
  fetchAiShares,
  fetchDeepgramBalance,
  fetchOpencodeTopModels,
  fetchUsers,
  updateAiSettings,
  updateAiShare,
  type DeepgramTtsModel,
  type OpencodeTopModel,
  type SharedIaType
} from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { getDeepgramVoiceOptions, readStoredVoiceModel, writeStoredVoiceModel } from "../../app/book-language";
import { AwsCostBadge } from "../../components/AwsCostBadge";
import type { SelectableAiModel } from "../../components/AiModelBadge";

type AiFormState = {
  awsAccessKeyId: string;
  awsRegion: string;
  awsSecretAccessKey: string;
  clearAwsCredentials: boolean;
  clearDeepgramApiKey: boolean;
  clearGeminiApiKey: boolean;
  clearOpencodeApiKey: boolean;
  deepgramApiKey: string;
  deepgramTtsModelEs: DeepgramTtsModel;
  deepgramTtsModelIt: DeepgramTtsModel;
  geminiApiKey: string;
  opencodeApiKey: string;
  opencodeOcrModel: string;
  opencodeSummaryModel: string;
  opencodeOcrVisible: string[];
  opencodeSummaryVisible: string[];
};

const defaultDeepgramModelEs: DeepgramTtsModel = "aura-2-nestor-es";
const defaultDeepgramModelIt: DeepgramTtsModel = "aura-2-livia-it";

function StatusChip({ active, sharedBy, activeLabel, pendingLabel }: { active: boolean; sharedBy?: string | null | undefined; activeLabel: string; pendingLabel: string }) {
  if (active) return <span className="tag-chip tag-chip-success">{activeLabel}</span>;
  if (sharedBy) return <span className="tag-chip">Compartida por {sharedBy}</span>;
  return <span className="tag-chip">{pendingLabel}</span>;
}

function ModelCheckList({ models, visible, onToggle, idPrefix }: { models: SelectableAiModel[]; visible: string[]; onToggle: (id: string) => void; idPrefix: string }) {
  if (idPrefix === "ocr") models = models.filter((model) => model.supportsVision === true);
  if (models.length === 0) return <p className="subdued">Sin modelos. Pulsa Refrescar.</p>;
  return (
    <ul className="ai-model-check-list" tabIndex={0} aria-label={idPrefix === "ocr" ? "Modelos para OCR" : "Modelos para resumenes"}>
      {models.map((model) => {
        const checked = visible.length === 0 || visible.includes(model.id);
        return (
          <li key={`${idPrefix}-${model.id}`}>
            <label className="inline-check">
              <input type="checkbox" checked={checked} disabled={idPrefix === "ocr" && model.supportsVision !== true} onChange={() => onToggle(model.id)} />
              <span>
                <strong>{model.name}</strong> <span className="subdued">({model.id})</span>
                <br />
                <span className="helper-text">{model.description} {model.pricing}.</span>
              </span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

function placeholderTopModel(id: string, purpose: "ocr" | "summary"): OpencodeTopModel {
  const cleanId = id.trim();
  return {
    contextWindowTokens: 0,
    description: purpose === "ocr" ? "Modelo guardado en tu configuración." : "Modelo apto para resúmenes (guardado en tu configuración).",
    id: cleanId,
    name: cleanId,
    pricing: "Guardado",
    supportsVision: false
  };
}

// Los modelos gratuitos de Zen ("*-free", "big-pickle", "test") devuelven 403
// "FreeTierError" fuera del cliente OpenCode: nunca se ofrecen ni se restauran.
// El gratuito de Google (gemini-2.5-flash-lite-google) va por Google AI Studio y sí vale.
function isFreeZenModelId(id: string | null | undefined): boolean {
  const cleanId = (id ?? "").trim().toLowerCase();
  if (!cleanId) return false;
  if (cleanId === "test" || cleanId === "big-pickle") return true;
  return cleanId.endsWith("-free");
}

function mergeWithSavedModels(
  current: OpencodeTopModel[],
  visible: string[],
  defaultModel: string,
  purpose: "ocr" | "summary"
): OpencodeTopModel[] {
  const known = new Map(current.map((model) => [model.id, model]));
  for (const id of [...visible, defaultModel]) {
    const cleanId = id?.trim();
    // No restaurar gratuitos de Zen: fallan con 403 fuera de OpenCode.
    if (cleanId && !known.has(cleanId) && !isFreeZenModelId(cleanId)) {
      known.set(cleanId, placeholderTopModel(cleanId, purpose));
    }
  }
  // Keep catalogue entries first, followed by saved selections outside the current ranking.
  const ordered: OpencodeTopModel[] = [...current];
  for (const [id, model] of known) {
    if (!current.some((entry) => entry.id === id)) {
      ordered.push(model);
    }
  }
  return ordered;
}

export function AiSettingsPage() {
  const userId = useAuthStore((state) => state.user?.userId);
  return <AiSettingsForm key={userId ?? "anonymous"} />;
}

function AiSettingsForm() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const storeUser = useAuthStore((state) => state.user);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<AiFormState>({
    awsAccessKeyId: "",
    awsRegion: "",
    awsSecretAccessKey: "",
    clearAwsCredentials: false,
    clearDeepgramApiKey: false,
    clearGeminiApiKey: false,
    clearOpencodeApiKey: false,
    deepgramApiKey: "",
    deepgramTtsModelEs: defaultDeepgramModelEs,
    deepgramTtsModelIt: defaultDeepgramModelIt,
    geminiApiKey: "",
    opencodeApiKey: "",
    opencodeOcrModel: "",
    opencodeSummaryModel: "",
    opencodeOcrVisible: [],
    opencodeSummaryVisible: []
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [ocrModels, setOcrModels] = useState<OpencodeTopModel[]>([]);
  const [summaryModels, setSummaryModels] = useState<OpencodeTopModel[]>([]);
  const [ocrSource, setOcrSource] = useState<string | null>(null);
  const [ocrCatalogueWarning, setOcrCatalogueWarning] = useState<string | null>(null);
  const [summarySource, setSummarySource] = useState<string | null>(null);
  const [isRefreshingOcr, setIsRefreshingOcr] = useState(false);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);

  const settingsQuery = useQuery({
    enabled: Boolean(accessToken && storeUser?.userId),
    queryKey: aiSettingsQueryKey(storeUser?.userId),
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchAiSettings(accessToken);
    }
  });

  const aiConfigQuery = useQuery({
    queryKey: ["ai-config"],
    queryFn: fetchAiConfig,
    staleTime: 5 * 60 * 1000
  });

  const settings = settingsQuery.data?.settings;
  const isAdmin = settingsQuery.data?.isAdmin ?? storeUser?.role === "ADMIN";

  useEffect(() => {
    if (!settings) return;
    setForm((current) => ({
      ...current,
      awsRegion: settings.awsRegion ?? "",
      deepgramTtsModelEs: getDeepgramVoiceOptions("es").some((voice) => voice.value === settings.deepgramTtsModel)
        ? settings.deepgramTtsModel as DeepgramTtsModel
        : (readStoredVoiceModel("es", defaultDeepgramModelEs) as DeepgramTtsModel),
      deepgramTtsModelIt: getDeepgramVoiceOptions("it").some((voice) => voice.value === (settings.deepgramTtsModelIt ?? defaultDeepgramModelIt))
        ? (settings.deepgramTtsModelIt as DeepgramTtsModel) ?? defaultDeepgramModelIt
        : (readStoredVoiceModel("it", defaultDeepgramModelIt) as DeepgramTtsModel),
      opencodeOcrModel: settings.opencodeOcrModel ?? "",
      opencodeSummaryModel: settings.opencodeSummaryModel ?? "",
      opencodeOcrVisible: settings.opencodeOcrVisibleModels ?? [],
      opencodeSummaryVisible: settings.opencodeSummaryVisibleModels ?? []
    }));
  }, [settings]);

  useEffect(() => {
    const curatedSummary = (aiConfigQuery.data?.models ?? []).filter((model) => !isFreeZenModelId(model.id)).slice(0, 5).map((model) => ({
      contextWindowTokens: model.contextWindowTokens,
      description: model.description,
      id: model.id,
      name: model.name,
      pricing: model.pricing,
      supportsVision: model.supportsVision
    }));
    if (curatedSummary.length > 0 && summaryModels.length === 0) setSummaryModels(curatedSummary);
  }, [aiConfigQuery.data, summaryModels.length]);

  const hasAutoRefreshedOcr = useRef(false);
  const hasAutoRefreshedSummary = useRef(false);

  // Saved selections remain in the form, but only confirmed vision models appear in OCR lists.
  const effectiveOcrModels = ocrModels.filter((model) => model.supportsVision === true && !isFreeZenModelId(model.id));
  const ocrWarning = form.opencodeOcrModel && form.opencodeOcrVisible.length > 0 && !form.opencodeOcrVisible.includes(form.opencodeOcrModel)
    ? "Tu modelo OCR por defecto no esta marcado como visible. Marca el modelo o elige otro predeterminado antes de guardar."
    : form.opencodeOcrModel && !effectiveOcrModels.some((model) => model.id === form.opencodeOcrModel)
    ? "Tu modelo OCR guardado no esta disponible en el catalogo OpenCode en vivo. No se puede ejecutar OCR con el. Elige un modelo compatible; tu preferencia guardada no se ha cambiado."
    : null;
  const effectiveSummaryModels = mergeWithSavedModels(summaryModels.filter((model) => !isFreeZenModelId(model.id)), form.opencodeSummaryVisible, form.opencodeSummaryModel, "summary");

  // Aviso si la configuración guardada contenía gratuitos de Zen (se ocultan por inservibles).
  const savedFreeSummaryIds = [...(settings?.opencodeSummaryVisibleModels ?? []), settings?.opencodeSummaryModel ?? ""].map((id) => id.trim()).filter((id) => id && isFreeZenModelId(id));
  const savedFreeOcrIds = [...(settings?.opencodeOcrVisibleModels ?? []), settings?.opencodeOcrModel ?? ""].map((id) => id.trim()).filter((id) => id && isFreeZenModelId(id));

  useEffect(() => {
    if (!accessToken || !storeUser?.userId || hasAutoRefreshedOcr.current) return;
    hasAutoRefreshedOcr.current = true;
    void refreshModels("ocr", false);
  }, [accessToken]);

  // Al cargar la configuración, si hay modelos guardados que no están en la lista curada,
  // Refresh once to recover metadata for saved models outside the initial catalogue.
  useEffect(() => {
    if (!accessToken || !settings) return;
    const savedSummary = [...(settings.opencodeSummaryVisibleModels ?? []), settings.opencodeSummaryModel ?? ""].map((id) => id.trim()).filter(Boolean);
    const missingSummary = savedSummary.filter((id) => !summaryModels.some((model) => model.id === id));
    if (savedSummary.length > 0 && missingSummary.length > 0 && !hasAutoRefreshedSummary.current && summaryModels.length > 0) {
      hasAutoRefreshedSummary.current = true;
      void (async () => {
        setIsRefreshingSummary(true);
        try {
          await queryClient.cancelQueries({ queryKey: aiCatalogQueryKey(storeUser?.userId, "summary") });
          const response = await fetchOpencodeTopModels(accessToken, "summary");
          queryClient.setQueryData(aiCatalogQueryKey(storeUser?.userId, "summary"), response);
          setSummaryModels(response.models);
          setSummarySource(response.source);
        } catch {
          // Los placeholders ya muestran los guardados; ignorar el fallo silencioso.
        } finally {
          setIsRefreshingSummary(false);
        }
      })();
    }
  }, [accessToken, settings, summaryModels]);

  if (!accessToken) return <Navigate to="/login" replace />;

  async function refreshModels(purpose: "ocr" | "summary", refresh = true) {
    if (!accessToken) return;
    if (purpose === "ocr") setIsRefreshingOcr(true);
    else setIsRefreshingSummary(true);
    setErrorMessage(null);
    setSuccessMessage(null);
    try {
      await queryClient.cancelQueries({ queryKey: aiCatalogQueryKey(storeUser?.userId, purpose) });
      const response = await fetchOpencodeTopModels(accessToken, purpose, refresh);
      queryClient.setQueryData(aiCatalogQueryKey(storeUser?.userId, purpose), response);
      const paidModels = response.models.filter((model) => !isFreeZenModelId(model.id));
      if (purpose === "ocr") {
        setOcrModels(response.source === "live" ? paidModels : []);
        setOcrSource(response.source);
        setOcrCatalogueWarning(response.warning ?? (response.source !== "live" ? "No se pudo obtener el catalogo OCR OpenCode en vivo." : null));
      } else {
        setSummaryModels(paidModels);
        setSummarySource(response.source);
      }
      if (response.warning) setErrorMessage(response.warning);
      else if (purpose === "summary" || response.source === "live") setSuccessMessage(`Modelos de ${purpose === "ocr" ? "OCR" : "resúmenes"} actualizados (${response.source === "live" ? "OpenCode en vivo" : "lista curada"}).`);
    } catch (error) {
      if (purpose === "ocr") {
        queryClient.setQueryData(aiCatalogQueryKey(storeUser?.userId, "ocr"), { source: "live", models: [], warning: error instanceof Error ? error.message : "No se pudo obtener el catalogo OCR OpenCode en vivo." });
        setOcrModels([]);
        setOcrSource(null);
        setOcrCatalogueWarning(error instanceof Error ? error.message : "No se pudo obtener el catalogo OCR OpenCode en vivo.");
      }
      setErrorMessage(error instanceof Error ? error.message : "No se pudieron refrescar los modelos.");
    } finally {
      if (purpose === "ocr") setIsRefreshingOcr(false);
      else setIsRefreshingSummary(false);
    }
  }

  function toggleVisible(kind: "ocr" | "summary", id: string) {
    const key = kind === "ocr" ? "opencodeOcrVisible" : "opencodeSummaryVisible";
    const list = kind === "ocr" ? effectiveOcrModels : effectiveSummaryModels;
    const visible = form[key].length > 0 ? form[key] : list.map((model) => model.id);
    if (visible.includes(id) && !visible.some((item) => item !== id && list.some((model) => model.id === item))) {
      setErrorMessage("Debes mantener al menos un modelo visible.");
      return;
    }
    setErrorMessage(null);
    const next = visible.includes(id) ? visible.filter((item) => item !== id) : [...visible, id];
    setForm((current) => ({ ...current, [key]: next }));
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    for (const [model, visible] of [[form.opencodeOcrModel, form.opencodeOcrVisible], [form.opencodeSummaryModel, form.opencodeSummaryVisible]] as const) {
      if (model && visible.length > 0 && !visible.includes(model)) {
        setErrorMessage("El modelo por defecto debe estar marcado como visible. Elige otro predeterminado o marca el modelo antes de guardar.");
        return;
      }
    }
    setIsSubmitting(true);
    try {
      const response = await updateAiSettings(accessToken, {
        ...(form.awsAccessKeyId.trim() ? { awsAccessKeyId: form.awsAccessKeyId.trim() } : {}),
        ...(form.awsRegion.trim() ? { awsRegion: form.awsRegion.trim() } : {}),
        ...(form.awsSecretAccessKey.trim() ? { awsSecretAccessKey: form.awsSecretAccessKey.trim() } : {}),
        ...(form.deepgramApiKey.trim() ? { deepgramApiKey: form.deepgramApiKey.trim() } : {}),
        ...(form.geminiApiKey.trim() ? { geminiApiKey: form.geminiApiKey.trim() } : {}),
        ...(form.opencodeApiKey.trim() ? { opencodeApiKey: form.opencodeApiKey.trim() } : {}),
        opencodeOcrModel: form.opencodeOcrModel.trim() || null,
        opencodeSummaryModel: form.opencodeSummaryModel.trim() || null,
        clearAwsCredentials: form.clearAwsCredentials,
        clearDeepgramApiKey: form.clearDeepgramApiKey,
        clearGeminiApiKey: form.clearGeminiApiKey,
        clearOpencodeApiKey: form.clearOpencodeApiKey,
        deepgramTtsModel: form.deepgramTtsModelEs,
        deepgramTtsModelIt: form.deepgramTtsModelIt,
        opencodeOcrVisibleModels: form.opencodeOcrVisible,
        opencodeSummaryVisibleModels: form.opencodeSummaryVisible
      });
      useAuthStore.setState((previous) => previous.user && previous.user.userId === storeUser?.userId
        ? { ...previous, user: { ...previous.user, aiCredentials: { ...previous.user.aiCredentials!, ...response.settings } } }
        : previous);
      writeStoredVoiceModel("es", form.deepgramTtsModelEs);
      writeStoredVoiceModel("it", form.deepgramTtsModelIt);
      const freshSettings = await settingsQuery.refetch();
      if (freshSettings.isError) throw freshSettings.error;
      await queryClient.invalidateQueries({ queryKey: aiSettingsQueryKey(storeUser?.userId) });
      await queryClient.invalidateQueries({ queryKey: ["current-user-profile"] });
      // Refrescar las listas de modelos en galería y edición de página,
      // que comparten estas cachés (mismos modelos en ambas pantallas).
      await queryClient.invalidateQueries({ queryKey: aiCatalogQueryKey(storeUser?.userId, "ocr") });
      await queryClient.invalidateQueries({ queryKey: aiCatalogQueryKey(storeUser?.userId, "summary") });
      setForm((current) => ({
        ...current,
        awsAccessKeyId: "",
        awsSecretAccessKey: "",
        clearAwsCredentials: false,
        clearDeepgramApiKey: false,
        clearGeminiApiKey: false,
        clearOpencodeApiKey: false,
        deepgramApiKey: "",
        geminiApiKey: "",
        opencodeApiKey: ""
      }));
      setSuccessMessage("Configuración IA guardada.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo guardar la configuración IA.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const ocrVisibleOptions = effectiveOcrModels.filter((model) => form.opencodeOcrVisible.length === 0 || form.opencodeOcrVisible.includes(model.id));
  const summaryVisibleOptions = effectiveSummaryModels.filter((model) => form.opencodeSummaryVisible.length === 0 || form.opencodeSummaryVisible.includes(model.id));
  const unavailableOcrDefault = Boolean(form.opencodeOcrModel && !ocrVisibleOptions.some((model) => model.id === form.opencodeOcrModel));
  const unavailableSummaryDefault = Boolean(form.opencodeSummaryModel && !summaryVisibleOptions.some((model) => model.id === form.opencodeSummaryModel));

  return (
    <div className="page-grid profile-layout">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Configuración IA</p>
            <h2>Claves y modelos por usuario</h2>
            <p className="subdued">Cada usuario rellena sus credenciales si quiere usar cada función. Si falta alguna al usarla, se le indicará que venga aquí.</p>
          </div>
        </div>

        {settingsQuery.isLoading ? <p className="subdued">Cargando configuración IA...</p> : null}

        <form className="stack-form profile-form" onSubmit={handleSubmit}>
          <div className="settings-section">
            <div>
              <p className="eyebrow">AWS Textract</p>
              <h3>OCR con Amazon</h3>
              <p className="helper-text">Se utiliza para el OCR con tablas, formularios y maquetación (modo TEXTRACT) al crear libros desde imágenes o reintentando OCR.</p>
            </div>
            <StatusChip active={Boolean(settings?.hasAwsCredentials)} sharedBy={settings?.sharedAwsBy} activeLabel="AWS configurado" pendingLabel="AWS pendiente" />
          </div>

          {settings?.hasAwsCredentials ? (
            <div className="aws-cost-row">
              <AwsCostBadge accessToken={accessToken} hasAwsCredentials />
            </div>
          ) : null}
          {settings?.usingSharedAws ? <p className="helper-text">Estás usando las credenciales AWS compartidas por {settings.sharedAwsBy}. Puedes poner las tuyas debajo.</p> : null}

          <label>
            Región AWS
            <input onChange={(event) => setForm((current) => ({ ...current, awsRegion: event.target.value }))} placeholder="us-east-1" value={form.awsRegion} />
          </label>
          <label>
            AWS Access Key ID
            <input autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, awsAccessKeyId: event.target.value }))} placeholder={settings?.hasAwsCredentials ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce access key id"} type="password" value={form.awsAccessKeyId} />
          </label>
          <label>
            AWS Secret Access Key
            <input autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, awsSecretAccessKey: event.target.value }))} placeholder="Introduce secret access key" type="password" value={form.awsSecretAccessKey} />
          </label>
          <label className="inline-check">
            <input checked={form.clearAwsCredentials} onChange={(event) => setForm((current) => ({ ...current, clearAwsCredentials: event.target.checked }))} type="checkbox" />
            Borrar credenciales AWS guardadas
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">OpenCode</p>
              <h3>OCR con visión y resúmenes</h3>
              <p className="helper-text">Una sola clave OpenCode sirve para OCR con visión (modo VISION) y para resúmenes y peticiones IA. Elige OCR entre todos los modelos compatibles del catálogo en vivo y resúmenes entre los 5 mejores calidad-precio. El administrador puede compartirte el OCR y los resúmenes por separado.</p>
            </div>
            <StatusChip active={Boolean(settings?.hasOpencodeApiKey)} sharedBy={settings?.sharedOpencodeBy} activeLabel="OpenCode configurado" pendingLabel="OpenCode pendiente" />
          </div>

          <div className="ai-share-split-row">
            <StatusChip active={Boolean(settings?.hasOpencodeApiKey)} sharedBy={settings?.sharedOpencodeOcrBy} activeLabel="OCR propio" pendingLabel={settings?.sharedOpencodeOcrBy ? `OCR compartido por ${settings.sharedOpencodeOcrBy}` : "OCR pendiente"} />
            <StatusChip active={Boolean(settings?.hasOpencodeApiKey)} sharedBy={settings?.sharedOpencodeSummaryBy} activeLabel="Resúmenes propios" pendingLabel={settings?.sharedOpencodeSummaryBy ? `Resúmenes compartidos por ${settings.sharedOpencodeSummaryBy}` : "Resúmenes pendientes"} />
          </div>

          {(settings?.usingSharedOpencodeOcr || settings?.usingSharedOpencodeSummary) && !settings?.hasOpencodeApiKey ? (
            <p className="helper-text">
              Estás usando OpenCode compartido
              {settings?.sharedOpencodeOcrBy ? ` para OCR por ${settings.sharedOpencodeOcrBy}` : ""}
              {settings?.sharedOpencodeOcrBy && settings?.sharedOpencodeSummaryBy ? " y" : ""}
              {settings?.sharedOpencodeSummaryBy ? ` para resúmenes por ${settings.sharedOpencodeSummaryBy}` : ""}.
              Puedes poner tu propia clave debajo.
            </p>
          ) : null}
          <label>
            Clave API OpenCode
            <input autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, opencodeApiKey: event.target.value }))} placeholder={settings?.hasOpencodeApiKey ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce tu clave OpenCode"} type="password" value={form.opencodeApiKey} />
          </label>
          <label className="inline-check">
            <input checked={form.clearOpencodeApiKey} onChange={(event) => setForm((current) => ({ ...current, clearOpencodeApiKey: event.target.checked }))} type="checkbox" />
            Borrar clave OpenCode guardada
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">OpenCode · OCR</p>
              <h3>Modelo para OCR</h3>
            </div>
            <button className="secondary-button" disabled={isRefreshingOcr} onClick={() => void refreshModels("ocr")} type="button">
              {isRefreshingOcr ? "Refrescando..." : "Refrescar modelos OCR"}
            </button>
          </div>
          <p className="helper-text">Catálogo completo: {effectiveOcrModels.length} modelos OCR compatibles, sin límite. Fuente: {ocrSource === "live" ? "OpenCode en vivo" : "OpenCode en vivo pendiente"}. Capacidades de imagen y texto confirmadas mediante la metadata OpenCode de models.dev. Sin modelos guardados ni lista curada.</p>
          {ocrCatalogueWarning && <p className="error-text" role="alert">{ocrCatalogueWarning}</p>}
          {savedFreeOcrIds.length > 0 ? <p className="helper-text">Tus modelos gratuitos de Zen ({savedFreeOcrIds.join(", ")}) solo funcionan dentro de OpenCode y se han ocultado: elige modelos Zen de pago.</p> : null}
          <ModelCheckList models={effectiveOcrModels} visible={form.opencodeOcrVisible} onToggle={(id) => toggleVisible("ocr", id)} idPrefix="ocr" />
          <label>
            Modelo OCR por defecto
            <select onChange={(event) => setForm((current) => ({ ...current, opencodeOcrModel: event.target.value }))} value={unavailableOcrDefault ? "unavailable" : form.opencodeOcrModel}>
              <option value="">Usar servidor</option>
              {unavailableOcrDefault && <option value="unavailable" disabled>Selecciona un modelo compatible</option>}
              {ocrVisibleOptions.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
            </select>
            <span className="helper-text">Marca o desmarca arriba qué modelos quieres ver en esta lista.</span>
            {!form.opencodeOcrModel && <span className="helper-text">Modelo efectivo del servidor: {settingsQuery.data?.effectiveModels.ocrModel ?? "pendiente"}.</span>}
            {ocrWarning && <span className="error-text" role="alert">{ocrWarning}</span>}
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">OpenCode · Resúmenes</p>
              <h3>Modelo para resúmenes</h3>
            </div>
            <button className="secondary-button" disabled={isRefreshingSummary} onClick={() => void refreshModels("summary")} type="button">
              {isRefreshingSummary ? "Refrescando..." : "Refrescar top-5 resúmenes"}
            </button>
          </div>
          {summarySource ? <p className="helper-text">Fuente: {summarySource === "live" ? "OpenCode en vivo" : "lista curada"}.</p> : null}
          {savedFreeSummaryIds.length > 0 ? <p className="helper-text">Tus modelos gratuitos de Zen ({savedFreeSummaryIds.join(", ")}) solo funcionan dentro de OpenCode y se han ocultado: elige modelos Zen de pago o el gratis de Google.</p> : null}
          <ModelCheckList models={effectiveSummaryModels} visible={form.opencodeSummaryVisible} onToggle={(id) => toggleVisible("summary", id)} idPrefix="summary" />
          <label>
            Modelo de resúmenes por defecto
            <select onChange={(event) => setForm((current) => ({ ...current, opencodeSummaryModel: event.target.value }))} value={unavailableSummaryDefault ? "unavailable" : form.opencodeSummaryModel}>
              <option value="">Usar servidor</option>
              {unavailableSummaryDefault && <option value="unavailable" disabled>Selecciona un modelo visible</option>}
              {summaryVisibleOptions.map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
            </select>
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">Google AI Studio</p>
              <h3>Resúmenes gratis</h3>
              <p className="helper-text">Se utiliza para resúmenes y peticiones IA con el modelo gratuito gemini-2.5-flash-lite-google (15 req/min, 1.500 req/día). El plan gratuito puede usar los prompts para mejorar modelos.</p>
            </div>
            <StatusChip active={Boolean(settings?.hasGeminiApiKey)} sharedBy={settings?.sharedGoogleBy} activeLabel="Google configurado" pendingLabel="Google pendiente" />
          </div>
          {settings?.usingSharedGoogle ? <p className="helper-text">Estás usando la clave Google compartida por {settings.sharedGoogleBy}. Puedes poner la tuya debajo.</p> : null}
          <label>
            Clave API Google AI Studio
            <input autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, geminiApiKey: event.target.value }))} placeholder={settings?.hasGeminiApiKey ? "Ya configurada; escribe una nueva para reemplazarla" : "Pégala desde https://aistudio.google.com/app/apikey"} type="password" value={form.geminiApiKey} />
          </label>
          <label className="inline-check">
            <input checked={form.clearGeminiApiKey} onChange={(event) => setForm((current) => ({ ...current, clearGeminiApiKey: event.target.checked }))} type="checkbox" />
            Borrar clave Google guardada
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">Deepgram</p>
              <h3>Audio de lectura (TTS)</h3>
              <p className="helper-text">Se utiliza para leer en voz alta párrafos, resúmenes y respuestas IA. Elige la voz por defecto en español e italiano.</p>
            </div>
            <StatusChip active={Boolean(settings?.hasDeepgramApiKey)} sharedBy={settings?.sharedDeepgramBy} activeLabel="Clave configurada" pendingLabel="Clave pendiente" />
          </div>
          {settings?.usingSharedDeepgram ? <p className="helper-text">Estás usando la clave Deepgram compartida por {settings.sharedDeepgramBy}. Puedes poner la tuya debajo.</p> : null}
          <label>
            Clave API Deepgram
            <input autoComplete="off" onChange={(event) => setForm((current) => ({ ...current, deepgramApiKey: event.target.value }))} placeholder={settings?.hasDeepgramApiKey ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce tu clave Deepgram"} type="password" value={form.deepgramApiKey} />
          </label>
          <label>
            Voz por defecto en español
            <select onChange={(event) => setForm((current) => ({ ...current, deepgramTtsModelEs: event.target.value as DeepgramTtsModel }))} value={form.deepgramTtsModelEs}>
              {getDeepgramVoiceOptions("es").map((voice) => <option key={voice.value} value={voice.value}>{voice.label} ({voice.value})</option>)}
            </select>
          </label>
          <label>
            Voz por defecto en italiano
            <select onChange={(event) => setForm((current) => ({ ...current, deepgramTtsModelIt: event.target.value as DeepgramTtsModel }))} value={form.deepgramTtsModelIt}>
              {getDeepgramVoiceOptions("it").map((voice) => <option key={voice.value} value={voice.value}>{voice.label} ({voice.value})</option>)}
            </select>
          </label>
          <label className="inline-check">
            <input checked={form.clearDeepgramApiKey} onChange={(event) => setForm((current) => ({ ...current, clearDeepgramApiKey: event.target.checked }))} type="checkbox" />
            Borrar clave Deepgram guardada
          </label>

          <p className="helper-text">Los secretos se guardan cifrados. Por seguridad, nunca se muestran completos después de guardarlos.</p>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          {successMessage ? <p className="success-text">{successMessage}</p> : null}
          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Guardando..." : "Guardar configuración IA"}
          </button>
        </form>

        {isAdmin ? (
          <AdminShareMatrix
            accessToken={accessToken}
            hasAws={Boolean(settings?.hasAwsCredentials)}
            hasDeepgram={Boolean(settings?.hasDeepgramApiKey)}
            hasGemini={Boolean(settings?.hasGeminiApiKey)}
            hasOpencode={Boolean(settings?.hasOpencodeApiKey)}
            onNotice={(kind, text) => {
              if (kind === "error") { setErrorMessage(text); setSuccessMessage(null); }
              else { setSuccessMessage(text); setErrorMessage(null); }
            }}
          />
        ) : null}
        <DeepgramBalanceBlock accessToken={accessToken} hasKey={Boolean(settings?.hasDeepgramApiKey || settings?.usingSharedDeepgram)} />
      </section>
    </div>
  );
}

const SHARE_COLUMNS: Array<{ iaType: SharedIaType; label: string; short: string }> = [
  { iaType: "AWS", label: "AWS (OCR Textract)", short: "AWS" },
  { iaType: "OPENCODE_OCR", label: "OpenCode OCR (visión)", short: "OC OCR" },
  { iaType: "OPENCODE_SUMMARY", label: "OpenCode resúmenes", short: "OC Res." },
  { iaType: "GOOGLE", label: "Google (resúmenes)", short: "Google" },
  { iaType: "DEEPGRAM", label: "Deepgram (TTS)", short: "TTS" }
];

function AdminShareMatrix({ accessToken, hasAws, hasDeepgram, hasGemini, hasOpencode, onNotice }: {
  accessToken: string | null;
  hasAws: boolean;
  hasDeepgram: boolean;
  hasGemini: boolean;
  hasOpencode: boolean;
  onNotice: (kind: "error" | "success", text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const usersQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["ai-share-users"],
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchUsers(accessToken);
    }
  });

  const sharesQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["ai-shares-mine"],
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchAiShares(accessToken);
    }
  });

  const myUserId = useAuthStore((state) => state.user?.userId);
  const sharedSet = new Set((sharesQuery.data?.myShares ?? []).map((entry) => `${entry.recipientUserId}:${entry.iaType}`));
  const users = (usersQuery.data?.users ?? []).filter((user) => user.userId !== myUserId);

  function isAvailable(iaType: SharedIaType): boolean {
    if (iaType === "AWS") return hasAws;
    if (iaType === "GOOGLE") return hasGemini;
    if (iaType === "DEEPGRAM") return hasDeepgram;
    return hasOpencode;
  }

  async function toggleShare(recipientUserId: string, iaType: SharedIaType, next: boolean) {
    if (!accessToken) return;
    const key = `${recipientUserId}:${iaType}`;
    setPendingKey(key);
    try {
      await updateAiShare(accessToken, { recipientUserId, iaType, shared: next });
      await sharesQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ["ai-settings"] });
      onNotice("success", next ? "IA compartida con el usuario." : "Compartido retirado al usuario.");
    } catch (error) {
      onNotice("error", error instanceof Error ? error.message : "No se pudo actualizar el compartido.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <section className="ai-share-matrix">
      <div className="settings-section">
        <div>
          <p className="eyebrow">Administrador</p>
          <h3>Compartir mis IAs por usuario</h3>
          <p className="helper-text">
            Elige con qué usuarios compartes cada IA por separado. OpenCode OCR y resúmenes van por separado:
            puedes compartir el OCR y no los resúmenes, o viceversa. Quien no tenga clave propia usará la tuya automáticamente.
          </p>
          {!hasOpencode ? <p className="helper-text">Configura primero tu clave OpenCode arriba para poder compartir OCR y resúmenes.</p> : null}
          {!hasAws ? <p className="helper-text">Configura tu AWS arriba para poder compartirlo.</p> : null}
          {!hasGemini ? <p className="helper-text">Configura tu Google arriba para poder compartirlo.</p> : null}
          {!hasDeepgram ? <p className="helper-text">Configura tu Deepgram arriba para poder compartirlo.</p> : null}
        </div>
      </div>

      {usersQuery.isLoading || sharesQuery.isLoading ? <p className="subdued">Cargando usuarios...</p> : null}
      {usersQuery.isError ? <p className="error-text">No se pudo cargar la lista de usuarios.</p> : null}
      {sharesQuery.isError ? <p className="error-text">No se pudo cargar el compartido actual.</p> : null}

      {!usersQuery.isLoading && !sharesQuery.isLoading && users.length === 0 ? (
        <p className="subdued">No hay otros usuarios con los que compartir.</p>
      ) : null}

      {users.length > 0 ? (
        <div className="ai-share-table-wrap">
          <table className="ai-share-table">
            <thead>
              <tr>
                <th>Usuario</th>
                {SHARE_COLUMNS.map((column) => <th key={column.iaType} title={column.label}>{column.short}</th>)}
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId}>
                  <td>
                    <strong>{user.displayName ?? user.username}</strong>
                    <br />
                    <span className="subdued">{user.username} · {user.email}</span>
                  </td>
                  {SHARE_COLUMNS.map((column) => {
                    const key = `${user.userId}:${column.iaType}`;
                    const checked = sharedSet.has(key);
                    const available = isAvailable(column.iaType);
                    const pending = pendingKey === key;
                    return (
                      <td key={column.iaType}>
                        <input
                          aria-label={`Compartir ${column.label} con ${user.username}`}
                          checked={checked}
                          disabled={!available || pending}
                          onChange={(event) => void toggleShare(user.userId, column.iaType, event.target.checked)}
                          title={!available ? `Configura tu ${column.label} arriba para compartirlo` : `Compartir ${column.label} con ${user.username}`}
                          type="checkbox"
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}

function DeepgramBalanceBlock({ accessToken, hasKey }: { accessToken: string | null; hasKey: boolean }) {
  const balanceQuery = useQuery({
    enabled: Boolean(accessToken) && hasKey,
    queryKey: ["deepgram-balance-ai-settings"],
    queryFn: async () => {
      if (!accessToken) throw new Error("Sesión no disponible.");
      return fetchDeepgramBalance(accessToken);
    },
    retry: false
  });

  if (!hasKey) return null;
  if (balanceQuery.isLoading) return <p className="subdued">Consultando saldo Deepgram...</p>;
  if (balanceQuery.isError) return null;
  if (!balanceQuery.data) return null;
  return <p className="helper-text">Saldo Deepgram: ${balanceQuery.data.balance_usd} ({balanceQuery.data.project_name}).</p>;
}
