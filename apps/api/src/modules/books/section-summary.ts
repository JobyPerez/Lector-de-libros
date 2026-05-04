import { z } from "zod";

import { appEnv } from "../../config/env.js";

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string; type?: string }> | null;
    } | null;
  }>;
  error?: {
    code?: string | null;
    message?: string | null;
  } | null;
};

const summaryResponseSchema = z.object({
  summary: z.unknown()
});

const SUMMARY_CHUNK_TARGET_CHARACTERS = 9000;

export const DEFAULT_SECTION_SUMMARY_PROMPT = "Eres editor literario. Resume una sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.";
export const DEFAULT_SECTION_AI_REQUEST_PROMPT = DEFAULT_SECTION_SUMMARY_PROMPT;
export const DEFAULT_BOOK_AI_REQUEST_PROMPT = "Eres editor literario. Resume el libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales y los personajes principales.";

const DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPT = "Eres editor literario. Recibirás varios resúmenes parciales de una misma sección. Devuelve un único resumen fiel, claro y breve. No inventes detalles y no repitas ideas.";

const SUMMARY_RESPONSE_FORMAT_INSTRUCTIONS = "Regla técnica obligatoria: responde únicamente con JSON válido con la forma exacta {\"summary\":\"texto del resumen\"}. El valor de summary debe ser una cadena de texto preparada para mostrarse en el cuadro de resumen, no un objeto, no una lista y no una estructura anidada.";

function ensureSummaryConfiguration() {
  if (!appEnv.githubModelsToken || !appEnv.githubModelsEndpoint || !appEnv.githubModelsVisionModel) {
    throw Object.assign(new Error("El resumen con IA no está disponible en este entorno. Configura GitHub Models para reutilizar el modelo del OCR."), {
      statusCode: 503
    });
  }
}

function extractAssistantText(content: ChatCompletionResponse["choices"]): string {
  const firstChoice = content?.[0]?.message?.content;
  if (typeof firstChoice === "string") {
    return firstChoice.trim();
  }

  if (Array.isArray(firstChoice)) {
    return firstChoice
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text?.trim() ?? "")
      .join("\n")
      .trim();
  }

  return "";
}

function extractJsonPayload(responseText: string): string {
  const fencedMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBraceIndex = responseText.indexOf("{");
  const lastBraceIndex = responseText.lastIndexOf("}");
  if (firstBraceIndex !== -1 && lastBraceIndex !== -1 && lastBraceIndex > firstBraceIndex) {
    return responseText.slice(firstBraceIndex, lastBraceIndex + 1);
  }

  return responseText.trim();
}

function extractProviderErrorDetails(source: string | ChatCompletionResponse["error"]): { code: string | null; message: string } {
  if (typeof source !== "string") {
    return {
      code: source?.code?.trim() || null,
      message: source?.message?.trim() || "GitHub Models devolvió un error al generar el resumen."
    };
  }

  try {
    const payload = JSON.parse(source) as ChatCompletionResponse;
    if (payload.error?.message) {
      return {
        code: payload.error.code?.trim() || null,
        message: payload.error.message.trim()
      };
    }
  } catch {
    // Se mantiene el texto crudo del proveedor.
  }

  return {
    code: null,
    message: source.trim() || "GitHub Models devolvió un error al generar el resumen."
  };
}

function isContentFilterError(errorMessage: string) {
  return /content_filter|ResponsibleAIPolicyViolation|content management policy|jailbreak/iu.test(errorMessage);
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) {
    return null;
  }

  const numericValue = Number(value);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return Math.ceil(numericValue);
  }

  const retryDate = new Date(value);
  if (!Number.isNaN(retryDate.getTime())) {
    return Math.max(1, Math.ceil((retryDate.getTime() - Date.now()) / 1000));
  }

  return null;
}

function parseRetryWaitFromMessage(message: string): number | null {
  const match = message.match(/(?:wait|retry after)\s+(\d+)\s+seconds?/iu);
  if (!match?.[1]) {
    return null;
  }

  const retryAfterSeconds = Number(match[1]);
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? Math.ceil(retryAfterSeconds) : null;
}

function isRateLimitError(statusCode: number | null, errorMessage: string) {
  return statusCode === 429 || /rate limit|too many requests|UserByModelByMinute/iu.test(errorMessage);
}

function createSummaryRateLimitError(details: { code: string | null; message: string }, retryAfterSeconds: number | null) {
  const waitMessage = retryAfterSeconds
    ? ` Espera ${retryAfterSeconds} segundos antes de intentarlo de nuevo.`
    : " Espera un momento antes de intentarlo de nuevo.";

  return Object.assign(new Error(`GitHub Models ha alcanzado el límite temporal de peticiones.${waitMessage}`), {
    code: "AI_RATE_LIMIT",
    providerCode: details.code,
    retryAfterSeconds: retryAfterSeconds ?? undefined,
    retryable: true,
    statusCode: 429
  });
}

function createSummaryProviderError(details: { code: string | null; message: string }) {
  return Object.assign(new Error(`Error de GitHub Models al generar el resumen: ${details.message}`), {
    providerCode: details.code,
    statusCode: 502
  });
}

function humanizeSummaryKey(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^./u, (character) => character.toLocaleUpperCase("es"));
}

function formatStructuredSummaryValue(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => formatStructuredSummaryValue(item))
      .filter(Boolean)
      .join("\n\n");
  }

  if (value && typeof value === "object") {
    return Object.entries(value)
      .map(([key, nestedValue]) => {
        const formattedValue = formatStructuredSummaryValue(nestedValue);
        return formattedValue ? `${humanizeSummaryKey(key)}: ${formattedValue}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }

  return "";
}

function chunkParagraphs(paragraphs: string[]): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    const candidate = currentChunk ? `${currentChunk}\n\n${trimmedParagraph}` : trimmedParagraph;
    if (candidate.length <= SUMMARY_CHUNK_TARGET_CHARACTERS) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = trimmedParagraph;
      continue;
    }

    let remainingText = trimmedParagraph;
    while (remainingText.length > SUMMARY_CHUNK_TARGET_CHARACTERS) {
      chunks.push(remainingText.slice(0, SUMMARY_CHUNK_TARGET_CHARACTERS));
      remainingText = remainingText.slice(SUMMARY_CHUNK_TARGET_CHARACTERS);
    }
    currentChunk = remainingText;
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks.length > 0 ? chunks : [""];
}

function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestSummaryChunk(prompt: { promptOverride?: string | undefined; scopeLabel?: string; sectionTitle: string; text: string; condensed?: boolean }) {
  ensureSummaryConfiguration();

  const promptOverride = prompt.promptOverride?.trim();
  const editablePrompt = promptOverride || (prompt.condensed
    ? DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPT
    : DEFAULT_SECTION_SUMMARY_PROMPT);
  const systemPrompt = `${editablePrompt}\n\n${SUMMARY_RESPONSE_FORMAT_INSTRUCTIONS}`;

  const endpointBase = appEnv.githubModelsEndpoint!.replace(/\/$/u, "");
  const requestBody = JSON.stringify({
    max_tokens: prompt.condensed ? 900 : 1200,
    messages: [
      {
        role: "system",
        content: systemPrompt
      },
      {
        role: "user",
        content: prompt.condensed
          ? `${prompt.scopeLabel ?? "Sección"}: ${prompt.sectionTitle}\n\nCombina estas respuestas parciales en una única respuesta final:\n\n${prompt.text}`
          : `${prompt.scopeLabel ?? "Sección"}: ${prompt.sectionTitle}\n\nTexto de referencia:\n\n${prompt.text}`
      }
    ],
    model: appEnv.githubModelsVisionModel,
    response_format: { type: "json_object" },
    temperature: 0.15
  });

  let response: Response | null = null;
  let retryAfterSeconds: number | null = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(`${endpointBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appEnv.githubModelsToken}`,
        "Content-Type": "application/json"
      },
      body: requestBody
    });

    if (response.ok) {
      break;
    }

    const errorBody = await response.text();
    const details = extractProviderErrorDetails(errorBody);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after")) ?? parseRetryWaitFromMessage(normalizedProviderError);

    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error("GitHub Models bloqueó el resumen por sus políticas de contenido."), {
        statusCode: 422
      });
    }

    if (isRateLimitError(response.status, normalizedProviderError)) {
      if (attempt === 0 && retryAfterSeconds !== null && retryAfterSeconds <= 30) {
        await wait((retryAfterSeconds + 1) * 1000);
        continue;
      }

      throw createSummaryRateLimitError(details, retryAfterSeconds);
    }

    throw createSummaryProviderError(details);
  }

  if (!response?.ok) {
    throw createSummaryRateLimitError({
      code: null,
      message: "GitHub Models no aceptó la petición por límite temporal."
    }, retryAfterSeconds);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  if (payload.error?.message) {
    const details = extractProviderErrorDetails(payload.error);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error("GitHub Models bloqueó el resumen por sus políticas de contenido."), {
        statusCode: 422
      });
    }

    if (isRateLimitError(null, normalizedProviderError)) {
      throw createSummaryRateLimitError(details, parseRetryWaitFromMessage(normalizedProviderError));
    }

    throw createSummaryProviderError(details);
  }

  const assistantText = extractAssistantText(payload.choices);

  try {
    const parsedPayload = summaryResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
    const summaryText = formatStructuredSummaryValue(parsedPayload.summary);
    if (!summaryText || summaryText.length > 12000) {
      throw new Error("Invalid summary content.");
    }

    return summaryText;
  } catch {
    throw Object.assign(new Error(`GitHub Models devolvió una respuesta inválida al generar el resumen. Respuesta: ${assistantText.slice(0, 400)}`), {
      statusCode: 502
    });
  }
}

export async function generateSectionSummary(sectionTitle: string, paragraphs: string[], options: { promptOverride?: string | undefined } = {}): Promise<string> {
  return generateAiRequestResponse({
    paragraphs,
    promptOverride: options.promptOverride,
    scopeLabel: "Sección",
    title: sectionTitle
  });
}

export async function generateAiRequestResponse(options: {
  paragraphs: string[];
  promptOverride?: string | undefined;
  scopeLabel: "Libro" | "Sección";
  title: string;
}): Promise<string> {
  const { paragraphs, promptOverride, scopeLabel, title } = options;
  const normalizedParagraphs = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (normalizedParagraphs.length === 0) {
    throw Object.assign(new Error("No hay texto suficiente para generar una respuesta."), {
      statusCode: 422
    });
  }

  const chunks = chunkParagraphs(normalizedParagraphs);
  if (chunks.length === 1) {
    return requestSummaryChunk({ promptOverride, scopeLabel, sectionTitle: title, text: chunks[0] ?? normalizedParagraphs.join("\n\n") });
  }

  const partialSummaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    partialSummaries.push(await requestSummaryChunk({
      promptOverride,
      scopeLabel,
      sectionTitle: `${title} · fragmento ${index + 1}`,
      text: chunk
    }));
  }

  return requestSummaryChunk({
    condensed: true,
    promptOverride,
    scopeLabel,
    sectionTitle: title,
    text: partialSummaries.map((summary, index) => `Fragmento ${index + 1}: ${summary}`).join("\n\n")
  });
}
