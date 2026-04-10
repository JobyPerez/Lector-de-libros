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
  summary: z.string().trim().min(1).max(12000)
});

const SUMMARY_CHUNK_TARGET_CHARACTERS = 9000;

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

function createSummaryProviderError(details: { code: string | null; message: string }) {
  return Object.assign(new Error(`Error de GitHub Models al generar el resumen: ${details.message}`), {
    providerCode: details.code,
    statusCode: 502
  });
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

async function requestSummaryChunk(prompt: { sectionTitle: string; text: string; condensed?: boolean }) {
  ensureSummaryConfiguration();

  const endpointBase = appEnv.githubModelsEndpoint!.replace(/\/$/u, "");
  const response = await fetch(`${endpointBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appEnv.githubModelsToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      max_tokens: prompt.condensed ? 900 : 1200,
      messages: [
        {
          role: "system",
          content: prompt.condensed
            ? "Eres editor literario. Recibirás varios resúmenes parciales de una misma sección. Devuelve un único resumen fiel, claro y breve. No inventes detalles y no repitas ideas. Responde solo JSON con la clave summary."
            : "Eres editor literario. Resume una sección de un libro en español de manera clara, fiel y compacta. No inventes información, no añadas opiniones y conserva los hechos o ideas principales. Responde solo JSON con la clave summary."
        },
        {
          role: "user",
          content: prompt.condensed
            ? `Sección: ${prompt.sectionTitle}\n\nCombina estos resúmenes parciales en un único resumen final:\n\n${prompt.text}`
            : `Sección: ${prompt.sectionTitle}\n\nTexto de la sección:\n\n${prompt.text}`
        }
      ],
      model: appEnv.githubModelsVisionModel,
      response_format: { type: "json_object" },
      temperature: 0.15
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const details = extractProviderErrorDetails(errorBody);
    const normalizedProviderError = `${details.code ?? ""} ${details.message}`.trim();
    if (isContentFilterError(normalizedProviderError)) {
      throw Object.assign(new Error("GitHub Models bloqueó el resumen por sus políticas de contenido."), {
        statusCode: 422
      });
    }

    throw createSummaryProviderError(details);
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

    throw createSummaryProviderError(details);
  }

  const assistantText = extractAssistantText(payload.choices);

  try {
    const parsedPayload = summaryResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
    return parsedPayload.summary;
  } catch {
    throw Object.assign(new Error(`GitHub Models devolvió una respuesta inválida al generar el resumen. Respuesta: ${assistantText.slice(0, 400)}`), {
      statusCode: 502
    });
  }
}

export async function generateSectionSummary(sectionTitle: string, paragraphs: string[]): Promise<string> {
  const normalizedParagraphs = paragraphs.map((paragraph) => paragraph.trim()).filter(Boolean);
  if (normalizedParagraphs.length === 0) {
    throw Object.assign(new Error("La sección no contiene texto suficiente para generar un resumen."), {
      statusCode: 422
    });
  }

  const chunks = chunkParagraphs(normalizedParagraphs);
  if (chunks.length === 1) {
    return requestSummaryChunk({ sectionTitle, text: chunks[0] ?? normalizedParagraphs.join("\n\n") });
  }

  const partialSummaries: string[] = [];
  for (const [index, chunk] of chunks.entries()) {
    partialSummaries.push(await requestSummaryChunk({
      sectionTitle: `${sectionTitle} · fragmento ${index + 1}`,
      text: chunk
    }));
  }

  return requestSummaryChunk({
    condensed: true,
    sectionTitle,
    text: partialSummaries.map((summary, index) => `Fragmento ${index + 1}: ${summary}`).join("\n\n")
  });
}