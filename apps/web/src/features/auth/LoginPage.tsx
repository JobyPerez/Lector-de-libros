import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { loginUser, registerUser } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";

export function LoginPage() {
  const navigate = useNavigate();
  const setSession = useAuthStore((state) => state.setSession);
  const [isRegisterMode, setIsRegisterMode] = useState(false);
  const [form, setForm] = useState({
    displayName: "",
    email: "",
    password: "",
    username: "",
    usernameOrEmail: ""
  });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = isRegisterMode
        ? await registerUser({
            email: form.email,
            password: form.password,
            username: form.username,
            ...(form.displayName ? { displayName: form.displayName } : {})
          })
        : await loginUser({
            password: form.password,
            usernameOrEmail: form.usernameOrEmail
          });

      setSession(response);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo abrir la sesión.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="hero-card">
        <p className="eyebrow">Escucha, lee y conserva el punto exacto</p>
        <h1>Tu biblioteca habla en castellano.</h1>
        <p className="hero-copy">
          Importa PDF y EPUB, o crea libros desde imágenes para convertirlos en una experiencia de lectura narrada.
        </p>
        <div className="feature-grid">
          <article>
            <strong>Estantería viva</strong>
            <p>Libros organizados por usuario y seguimiento de progreso por obra.</p>
          </article>
          <article>
            <strong>Lectura continua</strong>
            <p>Reanuda párrafo, página y audio desde el último punto exacto.</p>
          </article>
          <article>
            <strong>OCR incremental</strong>
            <p>Añade páginas nuevas a un libro ya empezado sin romper la lectura.</p>
          </article>
        </div>
      </section>

      <section className="auth-card">
        <div className="mode-switch">
          <button
            className={!isRegisterMode ? "mode-button active" : "mode-button"}
            onClick={() => setIsRegisterMode(false)}
            type="button"
          >
            Entrar
          </button>
          <button
            className={isRegisterMode ? "mode-button active" : "mode-button"}
            onClick={() => setIsRegisterMode(true)}
            type="button"
          >
            Crear cuenta
          </button>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          {isRegisterMode ? (
            <>
              <label>
                Nombre visible
                <input
                  onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))}
                  placeholder="Marina Pérez"
                  value={form.displayName}
                />
              </label>
              <label>
                Usuario
                <input
                  onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                  placeholder="mperez"
                  value={form.username}
                />
              </label>
              <label>
                Correo
                <input
                  onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                  placeholder="usuario@dominio.com"
                  type="email"
                  value={form.email}
                />
              </label>
            </>
          ) : (
            <label>
              Usuario o correo
              <input
                onChange={(event) => setForm((current) => ({ ...current, usernameOrEmail: event.target.value }))}
                placeholder="usuario o correo"
                value={form.usernameOrEmail}
              />
            </label>
          )}

          <label>
            Contraseña
            <input
              onChange={(event) => setForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="********"
              type="password"
              value={form.password}
            />
          </label>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Procesando..." : isRegisterMode ? "Crear cuenta" : "Entrar"}
          </button>
        </form>
      </section>
    </div>
  );
}