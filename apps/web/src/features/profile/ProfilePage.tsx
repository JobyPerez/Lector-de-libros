import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";

import { deepgramTtsModels, fetchCurrentUser, updateCurrentUserProfile, type DeepgramTtsModel } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { AwsCostBadge } from "../../components/AwsCostBadge";

type ProfileFormState = {
  awsAccessKeyId: string;
  awsRegion: string;
  awsSecretAccessKey: string;
  clearAwsCredentials: boolean;
  clearDeepgramApiKey: boolean;
  deepgramApiKey: string;
  deepgramTtsModel: DeepgramTtsModel;
  displayName: string;
  email: string;
};

const defaultDeepgramModel: DeepgramTtsModel = "aura-2-nestor-es";

function isDeepgramTtsModel(value: string): value is DeepgramTtsModel {
  return (deepgramTtsModels as readonly string[]).includes(value);
}

export function ProfilePage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const storeUser = useAuthStore((state) => state.user);
  const [form, setForm] = useState<ProfileFormState>({
    awsAccessKeyId: "",
    awsRegion: "",
    awsSecretAccessKey: "",
    clearAwsCredentials: false,
    clearDeepgramApiKey: false,
    deepgramApiKey: "",
    deepgramTtsModel: defaultDeepgramModel,
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
      deepgramTtsModel: isDeepgramTtsModel(user.aiCredentials?.deepgramTtsModel ?? "")
        ? user.aiCredentials!.deepgramTtsModel as DeepgramTtsModel
        : defaultDeepgramModel,
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
        deepgramTtsModel: form.deepgramTtsModel,
        displayName: form.displayName,
        email: form.email,
        ...(form.awsAccessKeyId.trim() ? { awsAccessKeyId: form.awsAccessKeyId.trim() } : {}),
        ...(form.awsRegion.trim() ? { awsRegion: form.awsRegion.trim() } : {}),
        ...(form.awsSecretAccessKey.trim() ? { awsSecretAccessKey: form.awsSecretAccessKey.trim() } : {}),
        ...(form.deepgramApiKey.trim() ? { deepgramApiKey: form.deepgramApiKey.trim() } : {})
      });

      useAuthStore.setState((previous) => ({ ...previous, user: response.user }));
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
            <h2>Cuenta y credenciales IA</h2>
          </div>
        </div>

        {profileQuery.isLoading ? <p className="subdued">Cargando perfil...</p> : null}

        <form className="stack-form profile-form" onSubmit={handleSubmit}>
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
            Voz por defecto
            <select onChange={(event) => setForm((current) => ({ ...current, deepgramTtsModel: event.target.value as DeepgramTtsModel }))} value={form.deepgramTtsModel}>
              {deepgramTtsModels.map((model) => <option key={model} value={model}>{model}</option>)}
            </select>
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
