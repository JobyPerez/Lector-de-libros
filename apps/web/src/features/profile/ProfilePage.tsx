import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { fetchCurrentUser, updateCurrentUserProfile, type DeepgramTtsModel } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { getDeepgramVoiceOptions, readStoredVoiceModel, writeStoredVoiceModel } from "../../app/book-language";
import { AVAILABLE_MODES, AVAILABLE_PALETTES, useTheme } from "../../app/theme-provider";
import { AwsCostBadge } from "../../components/AwsCostBadge";

type ProfileFormState = {
  awsAccessKeyId: string;
  awsRegion: string;
  awsSecretAccessKey: string;
  clearAwsCredentials: boolean;
  clearDeepgramApiKey: boolean;
  deepgramApiKey: string;
  deepgramTtsModelEs: DeepgramTtsModel;
  deepgramTtsModelIt: DeepgramTtsModel;
  displayName: string;
  email: string;
};

const defaultDeepgramModelEs: DeepgramTtsModel = "aura-2-nestor-es";
const defaultDeepgramModelIt: DeepgramTtsModel = "aura-2-livia-it";

export function ProfilePage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const storeUser = useAuthStore((state) => state.user);
  const { mode, palette, effectiveMode, saveStatus, setMode, setPalette } = useTheme();
  const [form, setForm] = useState<ProfileFormState>({
    awsAccessKeyId: "",
    awsRegion: "",
    awsSecretAccessKey: "",
    clearAwsCredentials: false,
    clearDeepgramApiKey: false,
    deepgramApiKey: "",
    deepgramTtsModelEs: defaultDeepgramModelEs,
    deepgramTtsModelIt: readStoredVoiceModel("it") as DeepgramTtsModel,
    displayName: "",
    email: ""
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const profileQuery = useQuery({
    enabled: Boolean(accessToken),
    queryKey: ["current-user-profile"],
    queryFn: async () => {
      if (!accessToken) {
        throw new Error("Sesión no disponible.");
      }

      return fetchCurrentUser(accessToken);
    }
  });

  const user = profileQuery.data?.user ?? storeUser;
  const aiCredentials = user?.aiCredentials;

  useEffect(() => {
    if (!user) {
      return;
    }

    setForm((current) => ({
      ...current,
      awsRegion: user.aiCredentials?.awsRegion ?? "",
      deepgramTtsModelEs: getDeepgramVoiceOptions("es").some((voice) => voice.value === user.aiCredentials?.deepgramTtsModel)
        ? user.aiCredentials!.deepgramTtsModel as DeepgramTtsModel
        : readStoredVoiceModel("es", defaultDeepgramModelEs) as DeepgramTtsModel,
      deepgramTtsModelIt: getDeepgramVoiceOptions("it").some((voice) => voice.value === user.aiCredentials?.deepgramTtsModelIt)
        ? user.aiCredentials!.deepgramTtsModelIt as DeepgramTtsModel
        : readStoredVoiceModel("it", defaultDeepgramModelIt) as DeepgramTtsModel,
      displayName: user.displayName ?? "",
      email: user.email
    }));
  }, [user]);

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) {
      return;
    }

    setErrorMessage(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const response = await updateCurrentUserProfile(accessToken, {
        clearAwsCredentials: form.clearAwsCredentials,
        clearDeepgramApiKey: form.clearDeepgramApiKey,
        deepgramTtsModel: form.deepgramTtsModelEs,
        deepgramTtsModelIt: form.deepgramTtsModelIt,
        displayName: form.displayName,
        email: form.email,
        themeMode: mode,
        themePalette: palette,
        ...(form.awsAccessKeyId.trim() ? { awsAccessKeyId: form.awsAccessKeyId.trim() } : {}),
        ...(form.awsRegion.trim() ? { awsRegion: form.awsRegion.trim() } : {}),
        ...(form.awsSecretAccessKey.trim() ? { awsSecretAccessKey: form.awsSecretAccessKey.trim() } : {}),
        ...(form.deepgramApiKey.trim() ? { deepgramApiKey: form.deepgramApiKey.trim() } : {})
      });

      useAuthStore.setState((previous) => ({ ...previous, user: response.user }));
      writeStoredVoiceModel("es", form.deepgramTtsModelEs);
      writeStoredVoiceModel("it", form.deepgramTtsModelIt);
      await profileQuery.refetch();
      setForm((current) => ({
        ...current,
        awsAccessKeyId: "",
        awsSecretAccessKey: "",
        clearAwsCredentials: false,
        clearDeepgramApiKey: false,
        deepgramApiKey: ""
      }));
      setSuccessMessage("Perfil actualizado.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo guardar el perfil.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="page-grid profile-layout">
      <section className="panel wide-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Perfil</p>
            <h2>Cuenta y preferencias</h2>
          </div>
        </div>

        {profileQuery.isLoading ? <p className="subdued">Cargando perfil...</p> : null}

        <div className="settings-section">
          <div>
            <p className="eyebrow">Personalización</p>
            <h3>Apariencia y tema</h3>
          </div>
          {saveStatus === "saving" ? (
            <span className="tag-chip tag-chip-saving">Guardando tema...</span>
          ) : saveStatus === "saved" ? (
            <span className="tag-chip tag-chip-success">✓ Guardado</span>
          ) : (
            <span className="tag-chip">{effectiveMode === "dark" ? "Modo Oscuro" : "Modo Claro"}</span>
          )}
        </div>

        <div className="theme-settings-block">
          <div className="theme-field-group">
            <div className="theme-field-header">
              <span className="theme-field-title">Modo de pantalla</span>
              <span className="theme-field-sub">Elige la iluminación general de la interfaz</span>
            </div>
            <div className="theme-mode-grid" role="radiogroup" aria-label="Modo de pantalla">
              {AVAILABLE_MODES.map((option) => {
                const isSelected = mode === option.id;
                return (
                  <button
                    type="button"
                    key={option.id}
                    role="radio"
                    aria-checked={isSelected}
                    className={`theme-mode-card ${isSelected ? "active" : ""}`}
                    onClick={() => void setMode(option.id)}
                  >
                    <div className="theme-mode-icon-wrap">
                      <span className="theme-mode-icon">{option.icon}</span>
                      {isSelected ? <span className="theme-check-badge">✓</span> : null}
                    </div>
                    <div className="theme-mode-info">
                      <span className="theme-mode-title">{option.label}</span>
                      <span className="theme-mode-desc">{option.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="theme-field-group">
            <div className="theme-field-header">
              <span className="theme-field-title">Paleta de colores</span>
              <span className="theme-field-sub">Selecciona el ambiente cromático que prefieras</span>
            </div>
            <div className="theme-palette-grid" role="radiogroup" aria-label="Paleta de colores">
              {AVAILABLE_PALETTES.map((paletteOption) => {
                const isSelected = palette === paletteOption.id;
                return (
                  <button
                    type="button"
                    key={paletteOption.id}
                    role="radio"
                    aria-checked={isSelected}
                    className={`theme-palette-card ${isSelected ? "active" : ""}`}
                    onClick={() => void setPalette(paletteOption.id)}
                  >
                    <div className="theme-palette-header">
                      <div className="theme-palette-swatches">
                        {paletteOption.previewColors.map((color, idx) => (
                          <span
                            key={idx}
                            className="theme-palette-dot"
                            style={{ backgroundColor: color }}
                            title={`Color ${idx + 1}`}
                          />
                        ))}
                      </div>
                      {isSelected ? <span className="theme-check-badge">✓</span> : null}
                    </div>
                    <div className="theme-palette-info">
                      <div className="theme-palette-name-row">
                        <span className="theme-palette-title">{paletteOption.name}</span>
                        <span className="theme-palette-subtitle">{paletteOption.subtitle}</span>
                      </div>
                      <span className="theme-palette-desc">{paletteOption.description}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <form className="stack-form profile-form" onSubmit={handleSubmit}>
          <div className="settings-section">
            <div>
              <p className="eyebrow">Datos personales</p>
              <h3>Información de la cuenta</h3>
            </div>
          </div>

          <label>
            Nombre visible
            <input onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} placeholder="Tu nombre" value={form.displayName} />
          </label>

          <label>
            Correo electrónico
            <input onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} required type="email" value={form.email} />
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">Deepgram</p>
              <h3>Audio de lectura</h3>
            </div>
            <span className="tag-chip">{aiCredentials?.hasDeepgramApiKey ? "Clave configurada" : "Clave pendiente"}</span>
          </div>

          <label>
            Clave API Deepgram
            <input
              autoComplete="off"
              onChange={(event) => setForm((current) => ({ ...current, deepgramApiKey: event.target.value }))}
              placeholder={aiCredentials?.hasDeepgramApiKey ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce tu clave Deepgram"}
              type="password"
              value={form.deepgramApiKey}
            />
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
            <span className="helper-text">Se conserva también en este dispositivo para mantener la preferencia con versiones anteriores del API.</span>
          </label>

          <label className="inline-check">
            <input checked={form.clearDeepgramApiKey} onChange={(event) => setForm((current) => ({ ...current, clearDeepgramApiKey: event.target.checked }))} type="checkbox" />
            Borrar clave Deepgram guardada
          </label>

          <div className="settings-section">
            <div>
              <p className="eyebrow">AWS Textract</p>
              <h3>OCR con Amazon</h3>
            </div>
            <span className="tag-chip">{aiCredentials?.hasAwsCredentials ? "AWS configurado" : "AWS pendiente"}</span>
          </div>

          {aiCredentials?.hasAwsCredentials ? (
            <div className="aws-cost-row">
              <AwsCostBadge accessToken={accessToken} hasAwsCredentials />
            </div>
          ) : null}

          <label>
            Región AWS
            <input onChange={(event) => setForm((current) => ({ ...current, awsRegion: event.target.value }))} placeholder="us-east-1" value={form.awsRegion} />
          </label>

          <label>
            AWS Access Key ID
            <input
              autoComplete="off"
              onChange={(event) => setForm((current) => ({ ...current, awsAccessKeyId: event.target.value }))}
              placeholder={aiCredentials?.hasAwsAccessKeyId ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce access key id"}
              type="password"
              value={form.awsAccessKeyId}
            />
          </label>

          <label>
            AWS Secret Access Key
            <input
              autoComplete="off"
              onChange={(event) => setForm((current) => ({ ...current, awsSecretAccessKey: event.target.value }))}
              placeholder={aiCredentials?.hasAwsSecretAccessKey ? "Ya configurada; escribe una nueva para reemplazarla" : "Introduce secret access key"}
              type="password"
              value={form.awsSecretAccessKey}
            />
          </label>

          <label className="inline-check">
            <input checked={form.clearAwsCredentials} onChange={(event) => setForm((current) => ({ ...current, clearAwsCredentials: event.target.checked }))} type="checkbox" />
            Borrar credenciales AWS guardadas
          </label>

          <p className="helper-text">Los secretos se guardan cifrados. Por seguridad, nunca se muestran completos después de guardarlos.</p>
          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          {successMessage ? <p className="success-text">{successMessage}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Guardando..." : "Guardar perfil"}
          </button>
        </form>
      </section>
    </div>
  );
}
