import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";

import { changeCurrentUserPassword, fetchCurrentUser, updateCurrentUserProfile } from "../../app/api";
import { useAuthStore, type UserAiCredentialSummary } from "../../app/auth-store";
import { AVAILABLE_MODES, AVAILABLE_PALETTES, useTheme } from "../../app/theme-provider";
import { PasswordInput } from "../../components/PasswordInput";

export type ProfileTabId = "appearance" | "account" | "password" | "ai";

type ProfileFormState = {
  displayName: string;
  email: string;
};

type PasswordFormState = {
  confirmPassword: string;
  currentPassword: string;
  newPassword: string;
};

const emptyPasswordForm: PasswordFormState = {
  confirmPassword: "",
  currentPassword: "",
  newPassword: ""
};

const PROFILE_TABS: Array<{
  description: string;
  id: ProfileTabId;
  label: string;
}> = [
  {
    id: "appearance",
    label: "Apariencia",
    description: "Modo de pantalla y paleta de colores"
  },
  {
    id: "account",
    label: "Datos personales",
    description: "Nombre visible y correo de la cuenta"
  },
  {
    id: "password",
    label: "Seguridad",
    description: "Cambio de contraseña"
  },
  {
    id: "ai",
    label: "Inteligencia artificial",
    description: "Estado de claves y modelos IA"
  }
];

export function resolveProfileTabFromHash(hash: string): ProfileTabId {
  const cleanHash = hash.replace(/^#/u, "").trim().toLowerCase();
  if (cleanHash === "account" || cleanHash === "datos") {
    return "account";
  }
  if (cleanHash === "password" || cleanHash === "seguridad" || cleanHash === "contrasena") {
    return "password";
  }
  if (cleanHash === "ai" || cleanHash === "ia") {
    return "ai";
  }
  return "appearance";
}

function getAiServiceStatus(
  ownConfigured: boolean | undefined,
  usingShared: boolean | undefined,
  sharedBy: string | null | undefined
): { label: string; tone: "active" | "shared" | "pending" } {
  if (ownConfigured) {
    return { label: "Configurada", tone: "active" };
  }
  if (usingShared) {
    return {
      label: sharedBy ? `Compartida por @${sharedBy}` : "Compartida",
      tone: "shared"
    };
  }
  return { label: "Sin configurar", tone: "pending" };
}

function buildAiSummaryItems(ai: UserAiCredentialSummary | undefined) {
  const opencodeOwn = Boolean(ai?.hasOpencodeApiKey);
  const opencodeShared = Boolean(ai?.usingSharedOpencode || ai?.usingSharedOpencodeOcr || ai?.usingSharedOpencodeSummary);
  const opencodeSharedBy = ai?.sharedOpencodeBy ?? ai?.sharedOpencodeOcrBy ?? ai?.sharedOpencodeSummaryBy;

  return [
    {
      id: "aws",
      title: "AWS Textract",
      purpose: "OCR avanzado con estructura y tablas",
      ...getAiServiceStatus(ai?.hasAwsCredentials, ai?.usingSharedAws, ai?.sharedAwsBy)
    },
    {
      id: "opencode",
      title: "OpenCode Zen",
      purpose: "Modelos visuales de OCR y generación de resúmenes",
      ...getAiServiceStatus(opencodeOwn, opencodeShared, opencodeSharedBy)
    },
    {
      id: "google",
      title: "Google AI Studio",
      purpose: "Resúmenes gratuitos con Gemini",
      ...getAiServiceStatus(ai?.hasGeminiApiKey, ai?.usingSharedGoogle, ai?.sharedGoogleBy)
    },
    {
      id: "deepgram",
      title: "Deepgram TTS",
      purpose: "Lectura en voz alta en español e italiano",
      ...getAiServiceStatus(ai?.hasDeepgramApiKey, ai?.usingSharedDeepgram, ai?.sharedDeepgramBy)
    }
  ];
}

export function ProfilePage() {
  const location = useLocation();
  const tabButtonRefs = useRef<Record<ProfileTabId, HTMLButtonElement | null>>({
    account: null,
    ai: null,
    appearance: null,
    password: null
  });
  const accessToken = useAuthStore((state) => state.accessToken);
  const refreshToken = useAuthStore((state) => state.refreshToken);
  const storeUser = useAuthStore((state) => state.user);
  const { mode, palette, effectiveMode, saveStatus, setMode, setPalette } = useTheme();
  const [activeTab, setActiveTab] = useState<ProfileTabId>(() => resolveProfileTabFromHash(location.hash));
  const [form, setForm] = useState<ProfileFormState>({
    displayName: "",
    email: ""
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [passwordForm, setPasswordForm] = useState<PasswordFormState>(emptyPasswordForm);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

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

  useEffect(() => {
    if (!user) {
      return;
    }

    setForm(() => ({
      displayName: user.displayName ?? "",
      email: user.email
    }));
  }, [user]);

  useEffect(() => {
    setActiveTab(resolveProfileTabFromHash(location.hash));
  }, [location.hash]);

  if (!accessToken) {
    return <Navigate to="/login" replace />;
  }

  function selectTab(nextTab: ProfileTabId) {
    setActiveTab(nextTab);
    setErrorMessage(null);
    setSuccessMessage(null);
    setPasswordError(null);
    setPasswordSuccess(null);

    if (typeof window !== "undefined") {
      const nextHash = nextTab === "appearance" ? "" : `#${nextTab}`;
      const nextUrl = `${window.location.pathname}${window.location.search}${nextHash}`;
      window.history.replaceState(window.history.state, "", nextUrl);
    }
  }

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number) {
    const total = PROFILE_TABS.length;
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (index + 1) % total;
    } else if (event.key === "ArrowLeft") {
      nextIndex = (index - 1 + total) % total;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = total - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const targetTab = PROFILE_TABS[nextIndex];
    if (!targetTab) {
      return;
    }

    selectTab(targetTab.id);
    tabButtonRefs.current[targetTab.id]?.focus();
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
        displayName: form.displayName,
        email: form.email,
        themeMode: mode,
        themePalette: palette
      });

      useAuthStore.setState((previous) => ({ ...previous, user: response.user }));
      await profileQuery.refetch();
      setSuccessMessage("Perfil actualizado.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo guardar el perfil.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handlePasswordSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) {
      return;
    }

    setPasswordError(null);
    setPasswordSuccess(null);

    if (passwordForm.newPassword.length < 8) {
      setPasswordError("La nueva contraseña debe tener al menos 8 caracteres.");
      return;
    }

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordError("Las contraseñas no coinciden.");
      return;
    }

    setIsChangingPassword(true);

    try {
      const response = await changeCurrentUserPassword(accessToken, {
        confirmPassword: passwordForm.confirmPassword,
        currentPassword: passwordForm.currentPassword,
        newPassword: passwordForm.newPassword,
        refreshToken
      });

      setPasswordForm(emptyPasswordForm);
      setPasswordSuccess(response.message);
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "No se pudo cambiar la contraseña.");
    } finally {
      setIsChangingPassword(false);
    }
  }

  const displayName = user?.displayName?.trim() || user?.username || "Usuario";
  const avatarInitial = displayName.charAt(0).toUpperCase();
  const roleLabel = user?.role === "ADMIN" ? "Administrador" : "Editor";
  const aiSummaryItems = buildAiSummaryItems(user?.aiCredentials);

  return (
    <div className="page-grid profile-layout">
      <section className="panel wide-panel profile-panel-card">
        <div className="profile-header-block">
          <div className="profile-header-top">
            <div>
              <p className="eyebrow">Perfil</p>
              <h2>Cuenta y preferencias</h2>
            </div>
            {user ? (
              <div className="profile-user-summary" aria-label="Resumen de tu cuenta">
                <span aria-hidden="true" className="profile-user-avatar">
                  {avatarInitial}
                </span>
                <div className="profile-user-meta">
                  <strong>{displayName}</strong>
                  <span className="subdued">@{user.username} · {user.email}</span>
                </div>
                <span className="role-pill">{roleLabel}</span>
              </div>
            ) : null}
          </div>

          <div aria-label="Secciones del perfil" className="profile-tabs" role="tablist">
            {PROFILE_TABS.map((tab, index) => {
              const isSelected = activeTab === tab.id;
              return (
                <button
                  aria-controls={`profile-tabpanel-${tab.id}`}
                  aria-selected={isSelected}
                  className={`profile-tab-button ${isSelected ? "active" : ""}`}
                  id={`profile-tab-${tab.id}`}
                  key={tab.id}
                  onClick={() => selectTab(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                  ref={(node) => {
                    tabButtonRefs.current[tab.id] = node;
                  }}
                  role="tab"
                  tabIndex={isSelected ? 0 : -1}
                  type="button"
                >
                  <span className="profile-tab-label">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {profileQuery.isLoading ? <p className="subdued">Cargando perfil...</p> : null}

        {activeTab === "appearance" ? (
          <div
            aria-labelledby="profile-tab-appearance"
            className="profile-tab-panel"
            id="profile-tabpanel-appearance"
            role="tabpanel"
          >
            <div className="settings-section profile-section-banner">
              <div>
                <p className="eyebrow">Personalización</p>
                <h3>Apariencia y tema</h3>
                <p className="helper-text">Tus cambios de iluminación y paleta se guardan automáticamente.</p>
              </div>
              {saveStatus === "saving" ? (
                <span className="tag-chip tag-chip-saving">Guardando tema...</span>
              ) : saveStatus === "saved" ? (
                <span className="tag-chip tag-chip-success">✓ Guardado</span>
              ) : (
                <span className="tag-chip">{effectiveMode === "dark" ? "Modo Oscuro" : "Modo Claro"}</span>
              )}
            </div>

            <div className="theme-settings-block profile-theme-settings-block">
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
          </div>
        ) : null}

        {activeTab === "account" ? (
          <div
            aria-labelledby="profile-tab-account"
            className="profile-tab-panel"
            id="profile-tabpanel-account"
            role="tabpanel"
          >
            <form className="stack-form profile-form" onSubmit={handleSubmit}>
              <div className="settings-section profile-section-banner">
                <div>
                  <p className="eyebrow">Datos personales</p>
                  <h3>Información de la cuenta</h3>
                  <p className="helper-text">Actualiza cómo se muestra tu nombre y el correo electrónico asociado.</p>
                </div>
              </div>

              {user ? (
                <div className="profile-readonly-grid">
                  <div className="profile-readonly-item">
                    <span>Usuario</span>
                    <strong>@{user.username}</strong>
                  </div>
                  <div className="profile-readonly-item">
                    <span>Rol</span>
                    <strong>{roleLabel}</strong>
                  </div>
                </div>
              ) : null}

              <label>
                Nombre visible
                <input
                  onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                  placeholder="Tu nombre"
                  value={form.displayName}
                />
              </label>

              <label>
                Correo electrónico
                <input
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  required
                  type="email"
                  value={form.email}
                />
              </label>

              {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
              {successMessage ? <p className="success-text">{successMessage}</p> : null}

              <button className="primary-button" disabled={isSubmitting} type="submit">
                {isSubmitting ? "Guardando..." : "Guardar perfil"}
              </button>
            </form>
          </div>
        ) : null}

        {activeTab === "password" ? (
          <div
            aria-labelledby="profile-tab-password"
            className="profile-tab-panel"
            id="profile-tabpanel-password"
            role="tabpanel"
          >
            <form className="stack-form profile-form" id="password" onSubmit={handlePasswordSubmit}>
              <div className="settings-section profile-section-banner">
                <div>
                  <p className="eyebrow">Seguridad</p>
                  <h3>Cambiar contraseña</h3>
                  <p className="helper-text">
                    Introduce tu contraseña actual y define una nueva de al menos 8 caracteres. Recibirás una confirmación por correo.
                  </p>
                </div>
              </div>

              <label>
                Contraseña actual
                <PasswordInput
                  autoComplete="current-password"
                  onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))}
                  placeholder="Tu contraseña actual"
                  required
                  value={passwordForm.currentPassword}
                />
              </label>

              <label>
                Nueva contraseña
                <PasswordInput
                  autoComplete="new-password"
                  maxLength={72}
                  minLength={8}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))}
                  placeholder="Mínimo 8 caracteres"
                  required
                  value={passwordForm.newPassword}
                />
              </label>

              <label>
                Confirmar nueva contraseña
                <PasswordInput
                  autoComplete="new-password"
                  maxLength={72}
                  minLength={8}
                  onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))}
                  placeholder="Repite la nueva contraseña"
                  required
                  value={passwordForm.confirmPassword}
                />
              </label>

              {passwordError ? <p className="error-text">{passwordError}</p> : null}
              {passwordSuccess ? <p className="success-text">{passwordSuccess}</p> : null}

              <button className="primary-button" disabled={isChangingPassword} type="submit">
                {isChangingPassword ? "Cambiando..." : "Cambiar contraseña"}
              </button>
            </form>
          </div>
        ) : null}

        {activeTab === "ai" ? (
          <div
            aria-labelledby="profile-tab-ai"
            className="profile-tab-panel"
            id="profile-tabpanel-ai"
            role="tabpanel"
          >
            <div className="settings-section profile-section-banner">
              <div>
                <p className="eyebrow">Inteligencia artificial</p>
                <h3>Claves y modelos</h3>
                <p className="helper-text">
                  Consulta el estado actual de tus integraciones y gestiona tus claves de AWS, OpenCode, Google y Deepgram en Configuración IA.
                </p>
              </div>
              <Link className="primary-button" to="/ai-settings">
                Ir a Configuración IA
              </Link>
            </div>

            <div className="profile-ai-grid">
              {aiSummaryItems.map((item) => (
                <article className="profile-ai-card" key={item.id}>
                  <div className="profile-ai-card-header">
                    <strong>{item.title}</strong>
                    <span
                      className={`tag-chip ${
                        item.tone === "active"
                          ? "tag-chip-success"
                          : item.tone === "shared"
                            ? "profile-ai-chip-shared"
                            : ""
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>
                  <p className="helper-text">{item.purpose}</p>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}
