import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import {
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

function ModelCheckList({ models, visible, onToggle, idPrefix }: { models: OpencodeTopModel[]; visible: string[]; onToggle: (id: string) => void; idPrefix: string }) {
  if (models.length === 0) return <p className="subdued">Sin modelos. Pulsa Refrescar.</p>;
  return (
    <ul className="ai-model-check-list">
      {models.map((model) => {
        const checked = visible.length === 0 || visible.includes(model.id);
        return (
          <li key={`${idPrefix}-${model.id}`}>
            <label className="inline-check">
              <input type="checkbox" checked={checked} onChange={() => onToggle(model.id)} />
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

export function AiSettingsPage() {
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
  const [summarySource, setSummarySource] = useState<string | null>(null);
  const [isRefreshingOcr, setIsRefreshingOcr] = useState(false);
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false);

  const settingsQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["ai-settings"],
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
      opencodeOcrModel: settings.opencodeOcrModel ?? settingsQuery.data?.effectiveModels.ocrModel ?? "",
      opencodeSummaryModel: settings.opencodeSummaryModel ?? settingsQuery.data?.effectiveModels.summaryModel ?? "",
      opencodeOcrVisible: settings.opencodeOcrVisibleModels ?? [],
      opencodeSummaryVisible: settings.opencodeSummaryVisibleModels ?? []
    }));
  }, [settings, settingsQuery.data?.effectiveModels.ocrModel, settingsQuery.data?.effectiveModels.summaryModel]);

  useEffect(() => {
    const curatedOcr = (aiConfigQuery.data?.models ?? []).filter((model) => model.supportsVision).slice(0, 5).map((model) => ({
      contextWindowTokens: model.contextWindowTokens,
      description: model.description,
      id: model.id,
      name: model.name,
      pricing: model.pricing,
      supportsVision: model.supportsVision
    }));
    if (curatedOcr.length > 0 && ocrModels.length === 0) setOcrModels(curatedOcr);
    const curatedSummary = (aiConfigQuery.data?.models ?? []).slice(0, 5).map((model) => ({
      contextWindowTokens: model.contextWindowTokens,
      description: model.description,
      id: model.id,
      name: model.name,
      pricing: model.pricing,
      supportsVision: model.supportsVision
    }));
    if (curatedSummary.length > 0 && summaryModels.length === 0) setSummaryModels(curatedSummary);
  }, [aiConfigQuery.data, ocrModels.length, summaryModels.length]);

  if (!accessToken) return <Navigate to="/login" replace />;

  async function refreshModels(purpose: "ocr" | "summary") {
    if (!accessToken) return;
    if (purpose === "ocr") setIsRefreshingOcr(true);
    else setIsRefreshingSummary(true);
    setErrorMessage(null);
    try {
      const response = await fetchOpencodeTopModels(accessToken, purpose);
      if (purpose === "ocr") {
        setOcrModels(response.models);
        setOcrSource(response.source);
        if (response.models.length > 0 && !form.opencodeOcrModel) {
          setForm((current) => ({ ...current, opencodeOcrModel: response.models[0]!.id }));
        }
      } else {
        setSummaryModels(response.models);
        setSummarySource(response.source);
        if (response.models.length > 0 && !form.opencodeSummaryModel) {
          setForm((current) => ({ ...current, opencodeSummaryModel: response.models[0]!.id }));
        }
      }
      if (response.warning) setErrorMessage(response.warning);
      else setSuccessMessage(`Modelos de ${purpose === "ocr" ? "OCR" : "resúmenes"} actualizados (${response.source === "live" ? "OpenCode en vivo" : "lista curada"}).`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudieron refrescar los modelos.");
    } finally {
      if (purpose === "ocr") setIsRefreshingOcr(false);
      else setIsRefreshingSummary(false);
    }
  }

  function toggleVisible(kind: "ocr" | "summary", id: string) {
    setForm((current) => {
      const key = kind === "ocr" ? "opencodeOcrVisible" : "opencodeSummaryVisible";
      const list = kind === "ocr" ? ocrModels : summaryModels;
      const currentVisible = current[key].length > 0 ? current[key] : list.map((model) => model.id);
      const next = currentVisible.includes(id) ? currentVisible.filter((item) => item !== id) : [...currentVisible, id];
      return { ...current, [key]: next };
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);
    try {
      const response = await updateAiSettings(accessToken, {
        ...(form.awsAccessKeyId.trim() ? { awsAccessKeyId: form.awsAccessKeyId.trim() } : {}),
        ...(form.awsRegion.trim() ? { awsRegion: form.awsRegion.trim() } : {}),
        ...(form.awsSecretAccessKey.trim() ? { awsSecretAccessKey: form.awsSecretAccessKey.trim() } : {}),
        ...(form.deepgramApiKey.trim() ? { deepgramApiKey: form.deepgramApiKey.trim() } : {}),
        ...(form.geminiApiKey.trim() ? { geminiApiKey: form.geminiApiKey.trim() } : {}),
        ...(form.opencodeApiKey.trim() ? { opencodeApiKey: form.opencodeApiKey.trim() } : {}),
        ...(form.opencodeOcrModel.trim() ? { opencodeOcrModel: form.opencodeOcrModel.trim() } : {}),
        ...(form.opencodeSummaryModel.trim() ? { opencodeSummaryModel: form.opencodeSummaryModel.trim() } : {}),
        clearAwsCredentials: form.clearAwsCredentials,
        clearDeepgramApiKey: form.clearDeepgramApiKey,
        clearGeminiApiKey: form.clearGeminiApiKey,
        clearOpencodeApiKey: form.clearOpencodeApiKey,
        deepgramTtsModel: form.deepgramTtsModelEs,
        deepgramTtsModelIt: form.deepgramTtsModelIt,
        opencodeOcrVisibleModels: form.opencodeOcrVisible,
        opencodeSummaryVisibleModels: form.opencodeSummaryVisible
      });
      useAuthStore.setState((previous) => previous.user
        ? { ...previous, user: { ...previous.user, aiCredentials: { ...previous.user.aiCredentials!, ...response.settings } } }
        : previous);
      writeStoredVoiceModel("es", form.deepgramTtsModelEs);
      writeStoredVoiceModel("it", form.deepgramTtsModelIt);
      await settingsQuery.refetch();
      await queryClient.invalidateQueries({ queryKey: ["current-user-profile"] });
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

  const ocrVisibleOptions = ocrModels.filter((model) => form.opencodeOcrVisible.length === 0 || form.opencodeOcrVisible.includes(model.id));
  const summaryVisibleOptions = summaryModels.filter((model) => form.opencodeSummaryVisible.length === 0 || form.opencodeSummaryVisible.includes(model.id));

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
              <p className="helper-text">Una sola clave OpenCode sirve para OCR con visión (modo VISION) y para resúmenes y peticiones IA. Elige el modelo por defecto de cada uso entre los 5 mejores calidad-precio. El administrador puede compartirte el OCR y los resúmenes por separado.</p>
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
              {isRefreshingOcr ? "Refrescando..." : "Refrescar top-5 OCR"}
            </button>
          </div>
          {ocrSource ? <p className="helper-text">Fuente: {ocrSource === "live" ? "OpenCode en vivo" : "lista curada"}.</p> : null}
          <ModelCheckList models={ocrModels} visible={form.opencodeOcrVisible} onToggle={(id) => toggleVisible("ocr", id)} idPrefix="ocr" />
          <label>
            Modelo OCR por defecto
            <select onChange={(event) => setForm((current) => ({ ...current, opencodeOcrModel: event.target.value }))} value={form.opencodeOcrModel}>
              <option value="">Usar el del servidor</option>
              {(ocrVisibleOptions.length > 0 ? ocrVisibleOptions : ocrModels).map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
            </select>
            <span className="helper-text">Marca o desmarca arriba qué modelos quieres ver en esta lista.</span>
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
          <ModelCheckList models={summaryModels} visible={form.opencodeSummaryVisible} onToggle={(id) => toggleVisible("summary", id)} idPrefix="summary" />
          <label>
            Modelo de resúmenes por defecto
            <select onChange={(event) => setForm((current) => ({ ...current, opencodeSummaryModel: event.target.value }))} value={form.opencodeSummaryModel}>
              <option value="">Usar el del servidor</option>
              {(summaryVisibleOptions.length > 0 ? summaryVisibleOptions : summaryModels).map((model) => <option key={model.id} value={model.id}>{model.name} ({model.id})</option>)}
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
