import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { forgotPassword, loginUser } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
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
  const [showPassword, setShowPassword] = useState(false);
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/";

  useEffect(() => {
    if (accessToken) {
      navigate(returnTo, { replace: true });
    }
  }, [accessToken, navigate, returnTo]);

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
      const response = await forgotPassword({ email: recoveryEmail });
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
              onChange={(event) => setLoginForm((current) => ({ ...current, usernameOrEmail: event.target.value }))}
              placeholder="Usuario"
              required
              value={loginForm.usernameOrEmail}
            />
          </label>

          <label>
            Contraseña
            <span className="password-input-wrapper">
              <input
                onChange={(event) => setLoginForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="********"
                required
                type={showPassword ? "text" : "password"}
                value={loginForm.password}
              />
              <button
                aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                className="password-toggle-button"
                onClick={() => setShowPassword((current) => !current)}
                type="button"
              >
                {showPassword ? <EyeClosedIcon /> : <EyeOpenIcon />}
              </button>
            </span>
          </label>

          <div className="auth-actions auth-actions-compact">
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
      </section>
    </div>
  );
}

function EyeOpenIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" />
    </svg>
  );
}

function EyeClosedIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="20" viewBox="0 0 24 24" width="20" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94l9.88 9.88z"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
      <path
        d="M9.9 4.24A9.77 9.77 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19l-6.72-6.72M1 1l22 22"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
      />
    </svg>
  );
}
