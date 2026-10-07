import { z } from "zod";

import { SUMMARY_AI_MODEL_IDS, getAiModel, isFreeZenModelId, type SummaryAiModelId } from "../../config/ai-models.js";
import { appEnv } from "../../config/env.js";
import {
  getGoogleAiNativeModelId,
  getGoogleAiRequestHeaders,
  GOOGLE_AI_OPENAI_ENDPOINT,
  isGoogleAiModel
} from "../../config/google-ai.js";
import {
  extractResponsesApiText,
  getOpenCodeChatCompletionsEndpoint,
  getOpenCodeGeminiEndpoint,
  getOpenCodeGeminiRequestHeaders,
  getOpenCodeRequestHeaders,
  isGeminiModel,
  isResponsesApiModel,
  OPENCODE_RESPONSES_ENDPOINT,
  resolveOpenCodeChatEndpoints,
  type ResponsesApiResponse
} from "../../config/opencode.js";
import type { BookLanguageCode } from "./book-import.js";

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string; type?: string }> | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
    } | null;
  }>;
  error?: {
    code?: string | null;
    message?: string | null;
    type?: string | null;
  } | null;
};

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        thought?: boolean;
      }>;
      role?: string;
    };
    finishReason?: string;
  }>;
  error?: {
    code?: number | string;
    message?: string;
    status?: string;
    type?: string;
  };
  promptFeedback?: {
    blockReason?: string;
  };
};

const summaryResponseSchema = z.object({
  summary: z.unknown()
});

export const AI_VISUAL_TYPES = ["MIND_MAP", "CONCEPT_MAP", "TIMELINE", "INFOGRAPHIC", "FLOWCHART", "RELATIONSHIPS"] as const;
export type AiVisualType = "AUTO" | (typeof AI_VISUAL_TYPES)[number];

const diagramResponseSchema = z.object({
  type: z.enum(AI_VISUAL_TYPES),
  title: z.string().trim().min(1).max(160),
  summary: z.string().trim().min(1).max(2000),
  nodes: z.array(z.object({
    id: z.string().trim().regex(/^[a-z0-9_-]+$/iu).max(40),
    label: z.string().trim().min(1).max(140),
    detail: z.string().trim().max(500).optional(),
    category: z.string().trim().max(60).optional(),
    date: z.string().trim().max(80).optional(),
    metric: z.string().trim().max(80).optional()
  })).min(2).max(24),
  edges: z.array(z.object({
    from: z.string().trim().min(1).max(40),
    to: z.string().trim().min(1).max(40),
    label: z.string().trim().max(100).optional()
  })).max(40)
});

export type AiRequestKind = "TEXT" | "DIAGRAM";
export type ProviderRetryProgress = {
  attempt: number;
  maxAttempts: number;
};

const PROVIDER_REQUEST_ATTEMPTS = 3;

export function getDefaultSectionSummaryPrompt(languageCode: BookLanguageCode): string {
  return languageCode === "it"
    ? "Sei un editor letterario. Riassumi una sezione di un libro in italiano in modo chiaro, fedele e conciso. Non inventare informazioni, non aggiungere opinioni e conserva i fatti o le idee principali."
    : "Eres editor literario. Resume una sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.";
}

export function getDefaultSectionAiRequestPrompt(languageCode: BookLanguageCode): string {
  return languageCode === "it"
    ? "Sei un editor letterario. Riassumi questa sezione di un libro in italiano in modo chiaro, fedele e conciso. Non inventare informazioni, non aggiungere opinioni e conserva i fatti o le idee principali."
    : "Eres editor literario. Resume esta sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.";
}

export function getDefaultBookAiRequestPrompt(languageCode: BookLanguageCode): string {
  return languageCode === "it"
    ? "Sei un editor letterario. Riassumi il libro in italiano in modo chiaro, fedele e conciso. Non inventare informazioni, non aggiungere opinioni e conserva i fatti, le idee e i personaggi principali."
    : "Eres editor literario. Resume el libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales y los personajes principales.";
}

const DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPTS: Record<BookLanguageCode, string> = {
  es: "Eres editor literario. Recibirás varios resúmenes parciales de una misma sección. Devuelve un único resumen fiel, claro y breve. No inventes detalles y no repitas ideas.",
  it: "Sei un editor letterario. Riceverai vari riassunti parziali della stessa sezione. Restituisci un unico riassunto fedele, chiaro e breve. Non inventare dettagli e non ripetere idee."
};

const SUMMARY_RESPONSE_FORMAT_INSTRUCTIONS = "Regla técnica obligatoria: responde únicamente con JSON válido con la forma exacta {\"summary\":\"texto del resumen\"}. El valor de summary debe ser una cadena de texto preparada para mostrarse en el cuadro de resumen, no un objeto, no una lista y no una estructura anidada.";
const VISUAL_TYPE_LABELS: Record<AiVisualType, string> = {
  AUTO: "el formato visual que mejor explique el texto",
  MIND_MAP: "un mapa mental radial con una idea central y sus ramas",
  CONCEPT_MAP: "un mapa conceptual jerárquico que rotule las relaciones",
  TIMELINE: "una línea de tiempo ordenada; usa date en cada nodo",
  INFOGRAPHIC: "una infografía editorial por bloques; usa category y metric cuando aporten información",
  FLOWCHART: "un diagrama de flujo ordenado por pasos o decisiones",
  RELATIONSHIPS: "una red de relaciones entre personajes, hechos o ideas"
};

function createDiagramResponseFormatInstructions(visualType: AiVisualType) {
  const typeRule = visualType === "AUTO"
    ? `Elige type entre ${AI_VISUAL_TYPES.join(", ")} según el contenido.`
    : `Usa exactamente \"type\":\"${visualType}\".`;
  return `Regla técnica obligatoria: responde únicamente con JSON válido con la forma {\"type\":\"CONCEPT_MAP\",\"title\":\"título\",\"summary\":\"síntesis accesible\",\"nodes\":[{\"id\":\"id_unico\",\"label\":\"concepto\",\"detail\":\"explicación opcional\",\"category\":\"grupo opcional\",\"date\":\"fecha opcional\",\"metric\":\"dato destacado opcional\"}],\"edges\":[{\"from\":\"id_origen\",\"to\":\"id_destino\",\"label\":\"relación opcional\"}]}. Crea ${VISUAL_TYPE_LABELS[visualType]}. ${typeRule} Usa entre 2 y 24 nodos, identificadores breves con letras, números, guion o guion bajo, y solo referencias a nodos existentes. Mantén el orden narrativo en nodes para cronologías e infografías. No incluyas Markdown, HTML ni Mermaid.`;
}

export type AiProviderKeys = {
  geminiApiKey?: string | null | undefined;
  opencodeApiKey?: string | null | undefined;
};

export function ensureSummaryConfiguration(model: string, keys?: AiProviderKeys) {
  if (isGoogleAiModel(model)) {
    if (!(keys?.geminiApiKey ?? appEnv.geminiApiKey)) {
      throw Object.assign(new Error("Te falta la clave de Google para los resúmenes. Rellénala en Configuración IA (/ai-settings) o usa la compartida del administrador."), {
        code: "MISSING_GOOGLE",
        statusCode: 503
      });
    }
    return;
  }
  // Los modelos gratuitos de Zen solo funcionan dentro del cliente OpenCode.
  // Con clave de servidor devuelven 403 "FreeTierError": rechazar con mensaje claro.
  if (isFreeZenModelId(model)) {
    throw Object.assign(new Error(`El modelo "${model}" es gratuito de OpenCode Zen y solo funciona dentro de OpenCode. Elige un modelo Zen de pago (p. ej. DeepSeek V4 Flash o GLM 5.3 Flash) en Configuración IA.`), {
      code: "FREE_MODEL_UNSUPPORTED",
      statusCode: 422
    });
  }
  if (!(keys?.opencodeApiKey ?? appEnv.opencodeGoApiKey)) {
    throw Object.assign(new Error("Te falta la clave de OpenCode para los resúmenes. Rellénala en Configuración IA (/ai-settings) o usa la compartida del administrador."), {
      code: "MISSING_OPENCODE",
      statusCode: 503
    });
  }
}

function getOpenCodeMaxTokens(model: string, requestedMaxTokens: number): number {
  return model.endsWith("-free") ? Math.max(requestedMaxTokens, 4096) : requestedMaxTokens;
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

  return content?.[0]?.message?.reasoning?.trim() ?? content?.[0]?.message?.reasoning_content?.trim() ?? "";
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

function extractProviderErrorDetails(source: string | ChatCompletionResponse["error"], providerLabel = "OpenCode"): { code: string | null; message: string } {
  if (typeof source !== "string") {
    return {
      code: source?.type?.trim() || source?.code?.trim() || null,
      message: source?.message?.trim() || `${providerLabel} devolvió un error al generar el resumen.`
    };
  }

  try {
    const payload = JSON.parse(source) as ChatCompletionResponse & { error?: { type?: string }; type?: string };
    if (payload.error?.message) {
      return {
        code: payload.error.type?.trim() || payload.error.code?.trim() || null,
        message: payload.error.message.trim()
      };
    }
    if (typeof payload.type === "string" && payload.type.trim()) {
      return {
        code: payload.type.trim(),
        message: source.trim()
      };
    }
  } catch {
    // Se mantiene el texto crudo del proveedor.
  }

  return {
    code: null,
    message: source.trim() || `${providerLabel} devolvió un error al generar el resumen.`
  };
}

function isContentFilterError(errorMessage: string) {
  return /content_filter|ResponsibleAIPolicyViolation|content management policy|jailbreak/iu.test(errorMessage);
}

function isModelUnavailableError(errorMessage: string) {
  return /model is unavailable/iu.test(errorMessage);
}

function getFallbackSummaryModel(model: string): string | null {
  return SUMMARY_AI_MODEL_IDS.find((candidate) => candidate !== model) ?? null;
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

function createSummaryRateLimitError(details: { code: string | null; message: string }, retryAfterSeconds: number | null, providerLabel = "OpenCode") {
  const waitMessage = retryAfterSeconds
    ? ` Espera ${retryAfterSeconds} segundos antes de intentarlo de nuevo.`
    : " Espera un momento antes de intentarlo de nuevo.";

  return Object.assign(new Error(`${providerLabel} ha alcanzado el límite temporal de peticiones.${waitMessage}`), {
    code: "AI_RATE_LIMIT",
    providerCode: details.code,
    retryAfterSeconds: retryAfterSeconds ?? undefined,
    retryable: true,
    statusCode: 429
  });
}

function createSummaryProviderError(details: { code: string | null; message: string }, transient = false, providerLabel = "OpenCode") {
  const retrySuggestion = transient ? " Prueba de nuevo o selecciona DeepSeek V4 Flash si el proveedor de NVIDIA continúa inestable." : "";
  return Object.assign(new Error(`Error de ${providerLabel} al generar la respuesta: ${details.message}.${retrySuggestion}`), {
    providerCode: details.code,
    retryable: transient,
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

function chunkParagraphs(paragraphs: string[], targetCharacters: number): string[] {
  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    const trimmedParagraph = paragraph.trim();
    if (!trimmedParagraph) {
      continue;
    }

    const candidate = currentChunk ? `${currentChunk}\n\n${trimmedParagraph}` : trimmedParagraph;
    if (candidate.length <= targetCharacters) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = "";
    }

    let remainingText = trimmedParagraph;
    while (remainingText.length > targetCharacters) {
      chunks.push(remainingText.slice(0, targetCharacters));
      remainingText = remainingText.slice(targetCharacters);
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

async function requestSummaryChunk(prompt: { condensed?: boolean; kind?: AiRequestKind; languageCode: BookLanguageCode; model: string; onProviderRetry?: ((progress: ProviderRetryProgress) => void) | undefined; promptOverride?: string | undefined; providerKeys?: AiProviderKeys | undefined; scopeLabel?: string; sectionTitle: string; text: string; visualType?: AiVisualType }) {
  ensureSummaryConfiguration(prompt.model, prompt.providerKeys);

  const promptOverride = prompt.promptOverride?.trim();
  const editablePrompt = promptOverride || (prompt.condensed
    ? DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPTS[prompt.languageCode]
    : getDefaultSectionSummaryPrompt(prompt.languageCode));
  const kind = prompt.kind ?? "TEXT";
  const languageInstruction = prompt.languageCode === "it"
    ? "Rispondi esclusivamente in italiano."
    : "Responde exclusivamente en español.";
  const systemPrompt = `${editablePrompt}\n\n${languageInstruction}\n\n${kind === "DIAGRAM" ? createDiagramResponseFormatInstructions(prompt.visualType ?? "AUTO") : SUMMARY_RESPONSE_FORMAT_INSTRUCTIONS}`;
  const scopeLabel = prompt.languageCode === "it"
    ? (prompt.scopeLabel === "Libro" ? "Libro" : "Sezione")
    : (prompt.scopeLabel ?? "Sección");

  let currentModel: string = prompt.model;
  let modelFallbackUsed = false;

  let response: Response | null = null;
  let retryAfterSeconds: number | null = null;
  let assistantText: string | null = null;

  // Los modelos con razonamiento (GLM, DeepSeek) consumen tokens de salida
  // pensando: con libros enteros 1200 se queda corto y la respuesta sale
  // cortada. Se empieza en 2000 y se duplica hasta 8000 entre reintentos.
  const SUMMARY_MAX_OUTPUT_TOKENS_CEILING = 8000;
  let maxTokens = getOpenCodeMaxTokens(currentModel, kind === "DIAGRAM" ? 2400 : prompt.condensed ? 900 : 2000);
  let lastTruncatedByLength = false;

  const effectiveOpencodeKey = prompt.providerKeys?.opencodeApiKey ?? appEnv.opencodeGoApiKey;
  const effectiveGeminiKey = prompt.providerKeys?.geminiApiKey ?? appEnv.geminiApiKey;
  // Algunos modelos solo están enrutados en uno de los dos chats (p. ej.
  // deepseek-v4-flash devuelve 404 en /zen/v1 con clave Go): ante ese 404 se
  // reintenta una vez en el otro endpoint.
  const chatEndpoints = resolveOpenCodeChatEndpoints(effectiveOpencodeKey);
  let chatEndpointIndex = 0;
  let chatEndpointFallbackUsed = false;

  const probeJsonParses = (text: string): boolean => {
    try {
      JSON.parse(extractJsonPayload(text));
      return true;
    } catch {
      return false;
    }
  };

  for (let attempt = 0; attempt < PROVIDER_REQUEST_ATTEMPTS; attempt += 1) {
    // Google AI Studio directo tiene prioridad: su id también empieza por "gemini-"
    // pero no usa el endpoint GenerateContent de OpenCode Zen.
    const usesGoogleAi = isGoogleAiModel(currentModel);
    const providerLabel = usesGoogleAi ? "Google AI Studio" : "OpenCode";
    const usesGeminiApi = !usesGoogleAi && isGeminiModel(currentModel);
    // gpt-*/muse-spark-* solo hablan Responses API: por chat devuelven 400
    // "ModelProtocolUnsupported".
    const usesResponsesApi = !usesGoogleAi && !usesGeminiApi && isResponsesApiModel(currentModel);
    const usesChatApi = !usesGoogleAi && !usesGeminiApi && !usesResponsesApi;
    const endpoint = usesGoogleAi
      ? GOOGLE_AI_OPENAI_ENDPOINT
      : usesGeminiApi
        ? getOpenCodeGeminiEndpoint(currentModel)
        : usesResponsesApi
          ? OPENCODE_RESPONSES_ENDPOINT
          : chatEndpoints[chatEndpointIndex] ?? getOpenCodeChatCompletionsEndpoint(currentModel);

    const userPromptContent = prompt.condensed
      ? `${scopeLabel}: ${prompt.sectionTitle}\n\n${prompt.languageCode === "it" ? "Combina queste risposte parziali in un'unica risposta finale" : "Combina estas respuestas parciales en una única respuesta final"}:\n\n${prompt.text}`
      : `${scopeLabel}: ${prompt.sectionTitle}\n\n${prompt.languageCode === "it" ? "Testo di riferimento" : "Texto de referencia"}:\n\n${prompt.text}`;

    const requestBody = JSON.stringify(usesGeminiApi
      ? {
          contents: [
            {
              parts: [
                {
                  text: `${systemPrompt}\n\n${userPromptContent}`
                }
              ],
              role: "user"
            }
          ],
          generationConfig: {
            maxOutputTokens: maxTokens,
            ...(kind === "DIAGRAM" ? { responseMimeType: "application/json" } : {}),
            temperature: 0.15
          }
        }
      : usesResponsesApi
        ? {
            input: userPromptContent,
            instructions: systemPrompt,
            max_output_tokens: maxTokens,
            model: currentModel
          }
        : {
          max_tokens: maxTokens,
          messages: [
            {
              role: "system",
              content: systemPrompt
            },
            {
              role: "user",
              content: userPromptContent
            }
          ],
          // En Google AI Studio se envía el id nativo del modelo.
          model: usesGoogleAi ? getGoogleAiNativeModelId(currentModel) : currentModel,
          temperature: 0.15
        });

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: usesGoogleAi
          ? getGoogleAiRequestHeaders(effectiveGeminiKey)
          : usesGeminiApi
            ? getOpenCodeGeminiRequestHeaders(effectiveOpencodeKey)
            : getOpenCodeRequestHeaders(effectiveOpencodeKey),
        body: requestBody
      });
    } catch {
      if (attempt < PROVIDER_REQUEST_ATTEMPTS - 1) {
        prompt.onProviderRetry?.({ attempt: attempt + 2, maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
        await wait(750 * (attempt + 1));
        continue;
      }
      throw Object.assign(new Error(`Se interrumpió la conexión entre la API y ${providerLabel} al generar la respuesta.`), {
        code: "AI_PROVIDER_NETWORK",
        retryable: true,
        statusCode: 502
      });
    }

    if (response.ok) {
      let payload: ChatCompletionResponse & GeminiGenerateContentResponse & ResponsesApiResponse;
      try {
        payload = (await response.json()) as ChatCompletionResponse & GeminiGenerateContentResponse & ResponsesApiResponse;
      } catch {
        throw createSummaryProviderError({ code: null, message: `${providerLabel} devolvió una respuesta no JSON.` }, false, providerLabel);
      }
      if (payload.error?.message) {
        const errorDetails = extractProviderErrorDetails(payload.error as any, providerLabel);
        const normalizedProviderError = `${errorDetails.code ?? ""} ${errorDetails.message}`.trim();
        if (isContentFilterError(normalizedProviderError)) {
          throw Object.assign(new Error(`${providerLabel} bloqueó el resumen por sus políticas de contenido.`), {
            statusCode: 422
          });
        }
        if (isRateLimitError(null, normalizedProviderError)) {
          throw createSummaryRateLimitError(errorDetails, parseRetryWaitFromMessage(normalizedProviderError), providerLabel);
        }
        throw createSummaryProviderError(errorDetails, false, providerLabel);
      }

      let candidateText: string;
      let truncatedByLength = false;
      if (usesGeminiApi) {
        const candidate = (payload as GeminiGenerateContentResponse).candidates?.[0];
        if (payload.promptFeedback?.blockReason || (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason))) {
          throw Object.assign(new Error("OpenCode bloqueó el resumen por sus políticas de contenido."), {
            statusCode: 422
          });
        }
        truncatedByLength = candidate?.finishReason === "MAX_TOKENS";
        candidateText = (candidate?.content?.parts || [])
          .filter((part) => !part.thought && typeof part.text === "string")
          .map((part) => part.text ?? "")
          .join("")
          .trim();
      } else if (usesResponsesApi) {
        const responsesPayload = payload as ResponsesApiResponse;
        truncatedByLength = responsesPayload.status === "incomplete" && responsesPayload.incomplete_details?.reason === "max_output_tokens";
        candidateText = extractResponsesApiText(responsesPayload);
      } else {
        const finishReason = payload.choices?.[0]?.finish_reason ?? null;
        truncatedByLength = finishReason === "length";
        candidateText = extractAssistantText(payload.choices);
      }

      // Modelos con razonamiento (GLM, DeepSeek) a veces devuelven contenido
      // vacío o JSON cortado al agotar max_tokens: reintentar con más techo.
      const jsonBroken = candidateText ? !probeJsonParses(candidateText) : true;
      lastTruncatedByLength = truncatedByLength;
      if ((candidateText.length === 0 || (truncatedByLength && jsonBroken))
        && attempt < PROVIDER_REQUEST_ATTEMPTS - 1
        && maxTokens < SUMMARY_MAX_OUTPUT_TOKENS_CEILING) {
        maxTokens = Math.min(maxTokens * 2, SUMMARY_MAX_OUTPUT_TOKENS_CEILING);
        prompt.onProviderRetry?.({ attempt: attempt + 2, maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
        continue;
      }

      assistantText = candidateText;
      break;
    }

    const errorBody = await response.text();
    const details = extractProviderErrorDetails(errorBody, providerLabel);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after")) ?? parseRetryWaitFromMessage(normalizedProviderError);

    // El modelo no está enrutado en este endpoint chat (/zen/v1 vs /zen/go/v1):
    // probar una vez el otro antes de rendirse.
    if (usesChatApi && !chatEndpointFallbackUsed && response.status === 404 && /cannot find any route/i.test(normalizedProviderError)) {
      chatEndpointFallbackUsed = true;
      chatEndpointIndex = chatEndpointIndex === 0 ? 1 : 0;
      prompt.onProviderRetry?.({ attempt: attempt + 2, maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
      continue;
    }

    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error(`${providerLabel} bloqueó el resumen por sus políticas de contenido.`), {
        statusCode: 422
      });
    }

    if (isRateLimitError(response.status, normalizedProviderError)) {
      if (attempt < PROVIDER_REQUEST_ATTEMPTS - 1 && retryAfterSeconds !== null && retryAfterSeconds <= 30) {
        prompt.onProviderRetry?.({ attempt: attempt + 2, maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
        await wait((retryAfterSeconds + 1) * 1000);
        continue;
      }

      throw createSummaryRateLimitError(details, retryAfterSeconds, providerLabel);
    }

    if (!modelFallbackUsed && attempt < PROVIDER_REQUEST_ATTEMPTS - 1 && isModelUnavailableError(normalizedProviderError)) {
      const fallbackModel = getFallbackSummaryModel(currentModel);
      if (fallbackModel) {
        modelFallbackUsed = true;
        currentModel = fallbackModel;
        prompt.onProviderRetry?.({ attempt: Math.min(attempt + 2, PROVIDER_REQUEST_ATTEMPTS), maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
        continue;
      }
    }

    const isTransientProviderError = response.status >= 500 && response.status <= 599;
    if (isTransientProviderError && attempt < PROVIDER_REQUEST_ATTEMPTS - 1) {
      prompt.onProviderRetry?.({ attempt: attempt + 2, maxAttempts: PROVIDER_REQUEST_ATTEMPTS });
      await wait(750 * (attempt + 1));
      continue;
    }

    throw createSummaryProviderError(details, isTransientProviderError, providerLabel);
  }

  const finalProviderLabel = isGoogleAiModel(currentModel) ? "Google AI Studio" : "OpenCode";
  if (assistantText === null) {
    if (!response?.ok) {
      throw createSummaryRateLimitError({
        code: null,
        message: `${finalProviderLabel} no aceptó la petición por límite temporal.`
      }, retryAfterSeconds, finalProviderLabel);
    }
    throw createSummaryProviderError({ code: null, message: `${finalProviderLabel} no devolvió contenido.` }, false, finalProviderLabel);
  }

  try {
    if (kind === "DIAGRAM") {
      const diagram = diagramResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
      const nodeIds = new Set(diagram.nodes.map((node) => node.id));
      if (nodeIds.size !== diagram.nodes.length || diagram.edges.some((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to) || edge.from === edge.to)) {
        throw new Error("Invalid diagram references.");
      }

      const serializedDiagram = JSON.stringify(diagram);
      if (serializedDiagram.length > 12000) {
        throw new Error("Diagram is too large.");
      }
      return serializedDiagram;
    }

    const parsedPayload = summaryResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
    const summaryText = formatStructuredSummaryValue(parsedPayload.summary);
    if (!summaryText || summaryText.length > 12000) {
      throw new Error("Invalid summary content.");
    }

    return summaryText;
  } catch {
    const invalidProviderLabel = isGoogleAiModel(currentModel) ? "Google AI Studio" : "OpenCode";
    const previewHead = assistantText.slice(0, 300);
    const previewTail = assistantText.length > 420 ? `…${assistantText.slice(-120)}` : "";
    const truncationHint = lastTruncatedByLength ? `, cortada por límite de tokens (techo ${maxTokens})` : "";
    throw Object.assign(new Error(`${invalidProviderLabel} devolvió una respuesta inválida al generar el resumen. Respuesta (${assistantText.length} caracteres${truncationHint}): ${previewHead}${previewTail}`), {
      statusCode: 502
    });
  }
}

export async function generateSectionSummary(sectionTitle: string, paragraphs: string[], options: { languageCode?: BookLanguageCode | undefined; model?: string | undefined; promptOverride?: string | undefined; providerKeys?: AiProviderKeys | undefined } = {}): Promise<string> {
  return generateAiRequestResponse({
    languageCode: options.languageCode,
    model: options.model,
    paragraphs,
    promptOverride: options.promptOverride,
    providerKeys: options.providerKeys,
    scopeLabel: "Sección",
    title: sectionTitle
  });
}

export async function generateAiRequestResponse(options: {
  kind?: AiRequestKind | undefined;
  languageCode?: BookLanguageCode | undefined;
  model?: string | undefined;
  onProviderRetry?: (progress: ProviderRetryProgress) => void;
  paragraphs: string[];
  promptOverride?: string | undefined;
  providerKeys?: AiProviderKeys | undefined;
  scopeLabel: "Libro" | "Sección";
  title: string;
  visualType?: AiVisualType | undefined;
}): Promise<string> {
  const { paragraphs, promptOverride, scopeLabel, title } = options;
  const kind = options.kind ?? "TEXT";
  const languageCode = options.languageCode ?? "es";
  const visualType = options.visualType ?? "AUTO";
  const model = options.model ?? appEnv.opencodeModel;
  const modelConfiguration = getAiModel(model);
  const normalizedParagraphs = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (normalizedParagraphs.length === 0) {
    throw Object.assign(new Error("No hay texto suficiente para generar una respuesta."), {
      statusCode: 422
    });
  }

  const chunks = chunkParagraphs(normalizedParagraphs, modelConfiguration.summaryChunkTargetCharacters);
  const providerKeys = options.providerKeys;
  if (chunks.length === 1) {
    return requestSummaryChunk({ kind, languageCode, model, onProviderRetry: options.onProviderRetry, promptOverride, providerKeys, scopeLabel, sectionTitle: title, text: chunks[0] ?? normalizedParagraphs.join("\n\n"), visualType });
  }

  const partialSummaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    partialSummaries.push(await requestSummaryChunk({
      model,
      kind,
      languageCode,
      promptOverride,
      providerKeys,
      onProviderRetry: options.onProviderRetry,
      scopeLabel,
      sectionTitle: `${title} · ${languageCode === "it" ? "frammento" : "fragmento"} ${index + 1}`,
      text: chunk,
      visualType
    }));
  }

  return requestSummaryChunk({
    condensed: true,
    kind,
    languageCode,
    model,
    onProviderRetry: options.onProviderRetry,
    promptOverride,
    providerKeys,
    scopeLabel,
    sectionTitle: title,
    text: partialSummaries.map((summary, index) => `${languageCode === "it" ? "Frammento" : "Fragmento"} ${index + 1}: ${summary}`).join("\n\n"),
    visualType
  });
}
