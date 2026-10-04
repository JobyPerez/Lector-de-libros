import { Link } from "react-router-dom";

import type { ApiRequestError } from "../app/api";

const MISSING_CODES = new Set(["MISSING_AWS", "MISSING_OPENCODE", "MISSING_GOOGLE", "MISSING_DEEPGRAM"]);

export function isAiMissingError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as Partial<ApiRequestError>).code;
  if (typeof code === "string" && MISSING_CODES.has(code)) return true;
  const message = error instanceof Error ? error.message : "";
  return /Configuración IA \(\/ai-settings\)/u.test(message) || /\/ai-settings/u.test(message);
}

export function AiMissingBanner({ error, fallbackMessage }: { error: unknown; fallbackMessage?: string }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : (fallbackMessage ?? "Falta configuración de IA.");
  const showLink = isAiMissingError(error) || /Configuración IA/u.test(message);

  return (
    <p className="error-text" role="alert">
      {message}{" "}
      {showLink ? (
        <Link to="/ai-settings">Ir a Configuración IA</Link>
      ) : null}
    </p>
  );
}
