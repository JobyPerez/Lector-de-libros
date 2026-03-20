import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { forgotPassword, loginUser } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { RabbitMark } from "../../components/RabbitMark";

export function LoginPage() {
  const navigate = useNavigate();
  const accessToken = useAuthStore((state) => state.accessToken);
  const setSession = useAuthStore((state) => state.setSession);
  const [loginForm, setLoginForm] = useState({
    password: "",
    usernameOrEmail: ""
  });
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const [isRecoveryOpen, setIsRecoveryOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSendingRecovery, setIsSendingRecovery] = useState(false);

  useEffect(() => {
    if (accessToken) {
      navigate("/", { replace: true });
    }
  }, [accessToken, navigate]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await loginUser({
        password: loginForm.password,
        usernameOrEmail: loginForm.usernameOrEmail
      });

      setSession(response);
      navigate("/", { replace: true });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo abrir la sesión.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleRecovery(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setRecoveryError(null);
    setRecoveryMessage(null);
    setIsSendingRecovery(true);

    try {
      const response = await forgotPassword({ email: recoveryEmail });
      setRecoveryMessage(response.message);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "No se pudo iniciar la recuperación.");
    } finally {
      setIsSendingRecovery(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="hero-card brand-hero">
        <div className="auth-brand-block">
          <RabbitMark className="hero-rabbit" title="El conejo lector" />
          <div>
            <p className="eyebrow">Biblioteca con voz</p>
            <h1>Lee, escucha y corrige página a página.</h1>
          </div>
        </div>
        <p className="hero-copy">
          El conejo lector reúne PDF, EPUB y libros creados desde imágenes con OCR editable, audio de Deepgram y progreso guardado por usuario.
        </p>
        <div className="feature-grid">
          <article>
            <strong>Entrada única</strong>
            <p>Accede con usuario y contraseña, y recupera la clave por correo si la olvidas.</p>
          </article>
          <article>
            <strong>OCR revisable</strong>
            <p>Edita el texto reconocido de cada página viendo la imagen original al lado.</p>
          </article>
          <article>
            <strong>Gobierno por roles</strong>
            <p>Los administradores mantienen usuarios; los editores sólo gestionan su biblioteca.</p>
          </article>
        </div>
      </section>

      <section className="auth-card login-card">
        <div className="card-heading">
          <p className="eyebrow">Bienvenida</p>
          <h2>El conejo lector</h2>
          <p className="subdued">Introduce tus credenciales para abrir tu estantería.</p>
        </div>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label>
            Usuario
            <input
              onChange={(event) => setLoginForm((current) => ({ ...current, usernameOrEmail: event.target.value }))}
              placeholder="Usuario o correo"
              required
              value={loginForm.usernameOrEmail}
            />
          </label>

          <label>
            Contraseña
            <input
              onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="********"
              required
              type="password"
              value={loginForm.password}
            />
          </label>

          <div className="auth-actions">
            <button
              className="text-button"
              onClick={() => {
                setIsRecoveryOpen((current) => !current);
                setRecoveryError(null);
                setRecoveryMessage(null);
              }}
              type="button"
            >
              ¿Olvidaste tu contraseña?
            </button>
          </div>

          {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

          <button className="primary-button" disabled={isSubmitting} type="submit">
            {isSubmitting ? "Abriendo..." : "Entrar"}
          </button>
        </form>

        {isRecoveryOpen ? (
          <form className="recovery-card" onSubmit={handleRecovery}>
            <div className="card-heading compact-heading">
              <h3>Recuperar acceso</h3>
              <p className="subdued">Enviaremos un enlace al correo del usuario.</p>
            </div>

            <label>
              Correo electrónico
              <input
                onChange={(event) => setRecoveryEmail(event.target.value)}
                placeholder="usuario@dominio.com"
                required
                type="email"
                value={recoveryEmail}
              />
            </label>

            {recoveryError ? <p className="error-text">{recoveryError}</p> : null}
            {recoveryMessage ? <p className="success-text">{recoveryMessage}</p> : null}

            <button className="secondary-button" disabled={isSendingRecovery} type="submit">
              {isSendingRecovery ? "Enviando..." : "Enviar enlace de recuperación"}
            </button>
          </form>
        ) : null}

        <p className="helper-text">
          Las altas de nuevos usuarios se realizan desde el menú de mantenimiento por un administrador.
        </p>
      </section>
    </div>
  );
}