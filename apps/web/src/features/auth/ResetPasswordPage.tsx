import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { resetPassword, validateResetPasswordToken } from "../../app/api";
import { useAuthStore } from "../../app/auth-store";
import { PasswordInput } from "../../components/PasswordInput";
import { RabbitMark } from "../../components/RabbitMark";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const tokenValidationQuery = useQuery({
    enabled: Boolean(token) && !isSuccess,
    queryKey: ["validate-reset-token", token],
    queryFn: () => validateResetPasswordToken(token),
    retry: false
  });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    if (!token) {
      setErrorMessage("Falta el token de recuperación en el enlace.");
      return;
    }

    if (password.length < 8) {
      setErrorMessage("La contraseña debe tener al menos 8 caracteres.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Las contraseñas no coinciden.");
      return;
    }

    setIsSubmitting(true);

    try {
      await resetPassword({ password, token });
      useAuthStore.getState().clearSession();
      setIsSuccess(true);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "No se pudo restablecer la contraseña.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="auth-layout">
      <section className="hero-card brand-hero">
        <div className="auth-brand-block">
          <RabbitMark className="hero-rabbit" title="El conejo lector" />
          <div>
            <p className="eyebrow">Recuperación segura</p>
            <h1>Define una contraseña nueva.</h1>
          </div>
        </div>
        <p className="hero-copy">
          El enlace enviado por correo te lleva aquí y caduca a los 60 minutos. Cuando completes el cambio, el sistema invalidará las sesiones anteriores de tu usuario y te enviará un correo de confirmación.
        </p>
      </section>

      <section className="auth-card login-card">
        <div className="card-heading">
          <p className="eyebrow">Acceso</p>
          <h2>Restablecer contraseña</h2>
        </div>

        {isSuccess ? (
          <div className="status-card success" role="status">
            <p>Contraseña actualizada correctamente. Ahora puedes iniciar sesión con tu nueva contraseña.</p>
            <Link className="primary-button link-button" to="/login">
              Volver al inicio de sesión
            </Link>
          </div>
        ) : !token ? (
          <div className="status-card" role="alert">
            <p className="error-text">El enlace de recuperación no incluye un token válido.</p>
            <Link className="secondary-button link-button" to="/login">
              Volver al inicio de sesión
            </Link>
          </div>
        ) : tokenValidationQuery.isLoading ? (
          <div className="status-card">
            <p className="subdued">Verificando enlace de recuperación...</p>
          </div>
        ) : tokenValidationQuery.isError ? (
          <div className="status-card" role="alert">
            <p className="error-text">
              {tokenValidationQuery.error instanceof Error
                ? tokenValidationQuery.error.message
                : "El enlace de recuperación es inválido o ha expirado."}
            </p>
            <Link className="secondary-button link-button" to="/login">
              Solicitar un nuevo enlace
            </Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              Nueva contraseña
              <PasswordInput
                autoComplete="new-password"
                autoFocus
                maxLength={72}
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mínimo 8 caracteres"
                required
                value={password}
              />
            </label>

            <label>
              Confirmar contraseña
              <PasswordInput
                autoComplete="new-password"
                maxLength={72}
                minLength={8}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Repite la contraseña"
                required
                value={confirmPassword}
              />
            </label>

            <p className="helper-text">
              Recibirás un correo de confirmación una vez actualizada tu contraseña.
            </p>

            {errorMessage ? <p className="error-text">{errorMessage}</p> : null}

            <button className="primary-button" disabled={isSubmitting} type="submit">
              {isSubmitting ? "Actualizando..." : "Guardar nueva contraseña"}
            </button>
          </form>
        )}

        <Link className="text-button link-inline" to="/login">
          Volver al inicio de sesión
        </Link>
      </section>
    </div>
  );
}
