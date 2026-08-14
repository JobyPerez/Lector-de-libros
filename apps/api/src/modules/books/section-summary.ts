import { z } from "zod";

import { getAiModel, type SummaryAiModelId } from "../../config/ai-models.js";
import { appEnv } from "../../config/env.js";

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string; type?: string }> | null;
      reasoning?: string | null;
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

const OPENCODE_ZEN_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions";
const OPENCODE_GO_ENDPOINT = "https://opencode.ai/zen/go/v1/chat/completions";
const PROVIDER_REQUEST_ATTEMPTS = 3;

export const DEFAULT_SECTION_SUMMARY_PROMPT = "Eres editor literario. Resume una sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.";
export const DEFAULT_SECTION_AI_REQUEST_PROMPT = "Eres editor literario. Resume esta sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales.";
export const DEFAULT_BOOK_AI_REQUEST_PROMPT = "Eres editor literario. Resume el libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales y los personajes principales.";

const DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPT = "Eres editor literario. Recibirás varios resúmenes parciales de una misma sección. Devuelve un único resumen fiel, claro y breve. No inventes detalles y no repitas ideas.";

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

function ensureSummaryConfiguration() {
  if (!appEnv.opencodeGoApiKey) {
    throw Object.assign(new Error("El resumen con IA no está disponible en este entorno. Configura OpenCode para usar este modo."), {
      statusCode: 503
    });
  }
}

function getOpenCodeChatCompletionsEndpoint(model: string): string {
  return model.endsWith("-free") ? OPENCODE_ZEN_ENDPOINT : OPENCODE_GO_ENDPOINT;
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

  return content?.[0]?.message?.reasoning?.trim() ?? "";
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
      message: source?.message?.trim() || "OpenCode devolvió un error al generar el resumen."
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
    message: source.trim() || "OpenCode devolvió un error al generar el resumen."
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

  return Object.assign(new Error(`OpenCode ha alcanzado el límite temporal de peticiones.${waitMessage}`), {
    code: "AI_RATE_LIMIT",
    providerCode: details.code,
    retryAfterSeconds: retryAfterSeconds ?? undefined,
    retryable: true,
    statusCode: 429
  });
}

function createSummaryProviderError(details: { code: string | null; message: string }, transient = false) {
  const retrySuggestion = transient ? " Prueba de nuevo o selecciona DeepSeek V4 Flash si el proveedor de NVIDIA continúa inestable." : "";
  return Object.assign(new Error(`Error de OpenCode al generar la respuesta: ${details.message}.${retrySuggestion}`), {
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

async function requestSummaryChunk(prompt: { condensed?: boolean; kind?: AiRequestKind; model: SummaryAiModelId; promptOverride?: string | undefined; scopeLabel?: string; sectionTitle: string; text: string; visualType?: AiVisualType }) {
  ensureSummaryConfiguration();

  const promptOverride = prompt.promptOverride?.trim();
  const editablePrompt = promptOverride || (prompt.condensed
    ? DEFAULT_SECTION_SUMMARY_CONDENSED_PROMPT
    : DEFAULT_SECTION_SUMMARY_PROMPT);
  const kind = prompt.kind ?? "TEXT";
  const systemPrompt = `${editablePrompt}\n\n${kind === "DIAGRAM" ? createDiagramResponseFormatInstructions(prompt.visualType ?? "AUTO") : SUMMARY_RESPONSE_FORMAT_INSTRUCTIONS}`;

  const model = prompt.model;
  const endpoint = getOpenCodeChatCompletionsEndpoint(model);
  const requestBody = JSON.stringify({
    max_tokens: getOpenCodeMaxTokens(model, kind === "DIAGRAM" ? 2400 : prompt.condensed ? 900 : 1200),
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
    model,
    temperature: 0.15
  });

  let response: Response | null = null;
  let retryAfterSeconds: number | null = null;

  for (let attempt = 0; attempt < PROVIDER_REQUEST_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${appEnv.opencodeGoApiKey}`,
          "Content-Type": "application/json"
        },
        body: requestBody
      });
    } catch {
      if (attempt < PROVIDER_REQUEST_ATTEMPTS - 1) {
        await wait(750 * (attempt + 1));
        continue;
      }
      throw Object.assign(new Error("Se interrumpió la conexión entre la API y OpenCode al generar la respuesta."), {
        code: "AI_PROVIDER_NETWORK",
        retryable: true,
        statusCode: 502
      });
    }

    if (response.ok) {
      break;
    }

    const errorBody = await response.text();
    const details = extractProviderErrorDetails(errorBody);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after")) ?? parseRetryWaitFromMessage(normalizedProviderError);

    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error("OpenCode bloqueó el resumen por sus políticas de contenido."), {
        statusCode: 422
      });
    }

    if (isRateLimitError(response.status, normalizedProviderError)) {
      if (attempt < PROVIDER_REQUEST_ATTEMPTS - 1 && retryAfterSeconds !== null && retryAfterSeconds <= 30) {
        await wait((retryAfterSeconds + 1) * 1000);
        continue;
      }

      throw createSummaryRateLimitError(details, retryAfterSeconds);
    }

    const isTransientProviderError = response.status >= 500 && response.status <= 599;
    if (isTransientProviderError && attempt < PROVIDER_REQUEST_ATTEMPTS - 1) {
      await wait(750 * (attempt + 1));
      continue;
    }

    throw createSummaryProviderError(details, isTransientProviderError);
  }

  if (!response?.ok) {
    throw createSummaryRateLimitError({
      code: null,
      message: "OpenCode no aceptó la petición por límite temporal."
    }, retryAfterSeconds);
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  if (payload.error?.message) {
    const details = extractProviderErrorDetails(payload.error);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error("OpenCode bloqueó el resumen por sus políticas de contenido."), {
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
    throw Object.assign(new Error(`OpenCode devolvió una respuesta inválida al generar el resumen. Respuesta: ${assistantText.slice(0, 400)}`), {
      statusCode: 502
    });
  }
}

export async function generateSectionSummary(sectionTitle: string, paragraphs: string[], options: { model?: SummaryAiModelId | undefined; promptOverride?: string | undefined } = {}): Promise<string> {
  return generateAiRequestResponse({
    model: options.model,
    paragraphs,
    promptOverride: options.promptOverride,
    scopeLabel: "Sección",
    title: sectionTitle
  });
}

export async function generateAiRequestResponse(options: {
  kind?: AiRequestKind | undefined;
  model?: SummaryAiModelId | undefined;
  paragraphs: string[];
  promptOverride?: string | undefined;
  scopeLabel: "Libro" | "Sección";
  title: string;
  visualType?: AiVisualType | undefined;
}): Promise<string> {
  const { paragraphs, promptOverride, scopeLabel, title } = options;
  const kind = options.kind ?? "TEXT";
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
  if (chunks.length === 1) {
    return requestSummaryChunk({ kind, model, promptOverride, scopeLabel, sectionTitle: title, text: chunks[0] ?? normalizedParagraphs.join("\n\n"), visualType });
  }

  const partialSummaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    partialSummaries.push(await requestSummaryChunk({
      model,
      kind,
      promptOverride,
      scopeLabel,
      sectionTitle: `${title} · fragmento ${index + 1}`,
      text: chunk,
      visualType
    }));
  }

  return requestSummaryChunk({
    condensed: true,
    kind,
    model,
    promptOverride,
    scopeLabel,
    sectionTitle: title,
    text: partialSummaries.map((summary, index) => `Fragmento ${index + 1}: ${summary}`).join("\n\n"),
    visualType
  });
}
