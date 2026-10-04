import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, Navigate } from "react-router-dom";

import { fetchCurrentUser, updateCurrentUserProfile } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { AVAILABLE_MODES, AVAILABLE_PALETTES, useTheme } from "../../app/theme-provider";

type ProfileFormState = {
  displayName: string;
  email: string;
};

export function ProfilePage() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const storeUser = useAuthStore((state) => state.user);
  const { mode, palette, effectiveMode, saveStatus, setMode, setPalette } = useTheme();
  const [form, setForm] = useState<ProfileFormState>({
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

  useEffect(() => {
    if (!user) {
      return;
    }

    setForm(() => ({
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

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}
          {successMessage ? <p className="success-text">{successMessage}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Guardando..." : "Guardar perfil"}
          </button>
        </form>

        <div className="settings-section">
          <div>
            <p className="eyebrow">Inteligencia artificial</p>
            <h3>Claves y modelos</h3>
            <p className="helper-text">Tus claves de AWS, OpenCode, Google y Deepgram ahora se gestionan en Configuración IA.</p>
          </div>
          <Link className="secondary-button" to="/ai-settings">Ir a Configuración IA</Link>
        </div>
      </section>
    </div>
  );
}
