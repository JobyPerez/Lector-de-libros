import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { resetPassword } from "../../app/api";
import { RabbitMark } from "../../components/RabbitMark";

export function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);

    if (!token) {
      setErrorMessage("Falta el token de recuperación en el enlace.");
      return;
    }

    if (password !== confirmPassword) {
      setErrorMessage("Las contraseñas no coinciden.");
      return;
    }

    setIsSubmitting(true);

    try {
      await resetPassword({ password, token });
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
          El enlace enviado por correo te lleva aquí. Cuando completes el cambio, el sistema invalidará las sesiones anteriores de tu usuario.
        </p>
      </section>

      <section className="auth-card login-card">
        <div className="card-heading">
          <p className="eyebrow">Acceso</p>
          <h2>Restablecer contraseña</h2>
        </div>

        {isSuccess ? (
          <div className="status-card success">
            <p>La contraseña se actualizó correctamente.</p>
            <Link className="primary-button link-button" to="/login">
              Volver al inicio de sesión
            </Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={handleSubmit}>
            <label>
              Nueva contraseña
              <input
                minLength={8}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mínimo 8 caracteres"
                required
                type="password"
                value={password}
              />
            </label>

            <label>
              Confirmar contraseña
              <input
                minLength={8}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="Repite la contraseña"
                required
                type="password"
                value={confirmPassword}
              />
            </label>

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