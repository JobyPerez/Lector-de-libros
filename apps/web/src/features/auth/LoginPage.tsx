import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { forgotPassword, loginUser } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { PasswordInput } from "../../components/PasswordInput";
import { RabbitMark } from "../../components/RabbitMark";

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const loginFormRef = useRef<HTMLFormElement | null>(null);
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
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";

  useEffect(() => {
    if (accessToken) {
      navigate(returnTo, { replace: true });
    }
  }, [accessToken, navigate, returnTo]);

  function toggleRecovery() {
    setIsRecoveryOpen((current) => {
      const next = !current;
      if (next && !recoveryEmail && loginForm.usernameOrEmail.includes("@")) {
        setRecoveryEmail(loginForm.usernameOrEmail.trim());
      }
      return next;
    });
    setRecoveryError(null);
    setRecoveryMessage(null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const response = await loginUser({
        password: loginForm.password,
        usernameOrEmail: loginForm.usernameOrEmail.trim()
      });

      setSession(response);
      navigate(returnTo, { replace: true });
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
      const response = await forgotPassword({ email: recoveryEmail.trim() });
      setRecoveryMessage(response.message);
    } catch (error) {
      setRecoveryError(error instanceof Error ? error.message : "No se pudo iniciar la recuperación.");
    } finally {
      setIsSendingRecovery(false);
    }
  }

  return (
    <div className="auth-layout auth-layout-compact">
      <section className="auth-card login-card simple-login-card">
        <div className="login-brand">
          <RabbitMark className="login-rabbit" title="El conejo lector" />
          <h1>El conejo lector</h1>
        </div>

        <form
          className="auth-form auth-form-compact"
          onKeyDown={(event) => {
            if (event.key !== "Enter" || isSubmitting) {
              return;
            }

            event.preventDefault();
            loginFormRef.current?.requestSubmit();
          }}
          onSubmit={handleSubmit}
          ref={loginFormRef}
        >
          <label>
            Usuario
            <input
              autoComplete="username"
              onChange={(event) => setLoginForm((current) => ({ ...current, usernameOrEmail: event.target.value }))}
              placeholder="Usuario"
              required
              value={loginForm.usernameOrEmail}
            />
          </label>

          <label>
            Contraseña
            <PasswordInput
              autoComplete="current-password"
              onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
              placeholder="********"
              required
              value={loginForm.password}
            />
          </label>

          <div className="auth-actions auth-actions-compact">
            <button
              aria-expanded={isRecoveryOpen}
              className="text-button"
              onClick={toggleRecovery}
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
              <h3>Recuperar contraseña</h3>
              <p className="subdued">
                Introduce tu correo electrónico y te enviaremos un enlace para restablecerla (válido durante 60 minutos).
              </p>
            </div>

            <label>
              Correo electrónico
              <input
                autoComplete="email"
                autoFocus
                onChange={(event) => setRecoveryEmail(event.target.value)}
                placeholder="usuario@dominio.com"
                required
                type="email"
                value={recoveryEmail}
              />
            </label>

            {recoveryError ? <p className="error-text">{recoveryError}</p> : null}
            {recoveryMessage ? (
              <div className="status-card success" role="status">
                <p>{recoveryMessage}</p>
              </div>
            ) : null}

            <div className="recovery-card-actions">
              <button className="secondary-button" disabled={isSendingRecovery} type="submit">
                {isSendingRecovery ? "Enviando..." : "Enviar enlace de recuperación"}
              </button>
              <button
                className="text-button"
                onClick={toggleRecovery}
                type="button"
              >
                Cancelar
              </button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
