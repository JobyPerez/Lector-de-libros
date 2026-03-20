import { extname } from "node:path";

import sharp from "sharp";
import Tesseract from "tesseract.js";
import { z } from "zod";

import { appEnv } from "../../config/env.js";
import { sanitizeParagraphs } from "./book-import.js";

export type OcrPageResult = {
  paragraphs: string[];
  rawText: string;
};

type ChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

const ocrResponseSchema = z.object({
  paragraphs: z.array(z.string()).default([]),
  rawText: z.string().default("")
});

const supportedImageMimeTypes = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp"
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cleanOcrText(rawText: string): string {
  return rawText
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([a-záéíóúñ])\n(?=[a-záéíóúñ])/giu, "$1 ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractAssistantText(content: ChatCompletionResponse["choices"]): string {
  const firstChoiceContent = content?.[0]?.message?.content;

  if (typeof firstChoiceContent === "string") {
    return firstChoiceContent;
  }

  if (Array.isArray(firstChoiceContent)) {
    return firstChoiceContent
      .map((item) => item.text ?? "")
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

function inferImageMimeType(fileName: string, mimeType: string): string {
  if (supportedImageMimeTypes.has(mimeType)) {
    return mimeType;
  }

  const extension = extname(fileName).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }

  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }

  if (extension === ".webp") {
    return "image/webp";
  }

  return mimeType;
}

function buildParagraphsFromRawText(rawText: string): string[] {
  const normalizedText = cleanOcrText(rawText.replace(/\r/g, "")).trim();
  if (!normalizedText) {
    return [];
  }

  const paragraphCandidates = normalizedText
    .split(/\n{2,}/u)
    .flatMap((paragraph) => paragraph.split(/\n(?=[A-ZÁÉÍÓÚÑ0-9])/u))
    .map(normalizeWhitespace)
    .filter(Boolean);

  return sanitizeParagraphs(paragraphCandidates.length > 0 ? paragraphCandidates : [normalizedText]);
}

async function preprocessImageBuffer(fileBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(fileBuffer).metadata();
  const width = metadata.width ?? 0;
  const targetWidth = width > 0 && width < 1800 ? 1800 : undefined;

  return sharp(fileBuffer)
    .flatten({ background: "#ffffff" })
    .grayscale()
    .normalize()
    .sharpen()
    .resize(targetWidth ? { width: targetWidth } : undefined)
    .threshold(170)
    .png()
    .toBuffer();
}

async function runLocalOcrWithTesseract(fileBuffer: Buffer): Promise<OcrPageResult> {
  const processedBuffer = await preprocessImageBuffer(fileBuffer);
  const result = await Tesseract.recognize(processedBuffer, "spa+eng", {
    logger: () => undefined
  });
  const cleanedText = cleanOcrText(result.data.text ?? "");
  const rawText = normalizeWhitespace(cleanedText);
  const paragraphs = buildParagraphsFromRawText(cleanedText);

  if (rawText.length === 0 || paragraphs.length === 0) {
    throw new Error("Tesseract no ha podido extraer texto legible de la imagen.");
  }

  return {
    paragraphs,
    rawText
  };
}

async function runVisionOcrWithGitHubModels(fileBuffer: Buffer, normalizedMimeType: string): Promise<OcrPageResult> {
  const endpointBase = appEnv.githubModelsEndpoint!.replace(/\/$/u, "");
  const response = await fetch(`${endpointBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appEnv.githubModelsToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      max_tokens: 1400,
      messages: [
        {
          role: "system",
          content: "Eres un OCR fiable para páginas de libros en español. Extrae solo el texto visible de la página en el orden natural de lectura. Devuelve JSON estricto con dos claves: rawText y paragraphs. rawText debe contener todo el texto seguido y paragraphs debe contener bloques listos para lectura en voz alta. No inventes contenido ni añadas comentarios."
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Analiza esta imagen de una página de libro. Ignora numeración irrelevante o ruido visual si no aporta lectura. Devuelve solo el JSON pedido."
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${normalizedMimeType};base64,${fileBuffer.toString("base64")}`
              }
            }
          ]
        }
      ],
      model: appEnv.githubModelsVisionModel,
      response_format: { type: "json_object" },
      temperature: 0
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw Object.assign(new Error(`Error OCR de GitHub Models: ${errorBody}`), {
      statusCode: 502
    });
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  if (payload.error?.message) {
    throw Object.assign(new Error(`Error OCR de GitHub Models: ${payload.error.message}`), {
      statusCode: 502
    });
  }

  const assistantText = extractAssistantText(payload.choices);
  const parsedPayload = ocrResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
  const paragraphs = sanitizeParagraphs(parsedPayload.paragraphs);
  const rawText = normalizeWhitespace(parsedPayload.rawText || paragraphs.join(" "));

  if (paragraphs.length === 0 || rawText.length === 0) {
    throw Object.assign(new Error("GitHub Models no ha podido extraer texto legible de la imagen."), {
      statusCode: 422
    });
  }

  return {
    paragraphs,
    rawText
  };
}

export function isSupportedImageUpload(fileName: string, mimeType: string): boolean {
  return supportedImageMimeTypes.has(inferImageMimeType(fileName, mimeType));
}

export async function runOcrOnImage(fileBuffer: Buffer, fileName: string, mimeType: string): Promise<OcrPageResult> {
  const normalizedMimeType = inferImageMimeType(fileName, mimeType);
  if (!supportedImageMimeTypes.has(normalizedMimeType)) {
    throw Object.assign(new Error(`Formato de imagen no soportado para OCR: ${mimeType || fileName}. Usa PNG, JPG o WEBP.`), {
      statusCode: 415
    });
  }

  try {
    return await runLocalOcrWithTesseract(fileBuffer);
  } catch (localOcrError) {
    if (appEnv.githubModelsToken && appEnv.githubModelsEndpoint && appEnv.githubModelsVisionModel) {
      return runVisionOcrWithGitHubModels(fileBuffer, normalizedMimeType);
    }

    throw Object.assign(new Error(`No se pudo extraer texto legible de la imagen ${fileName}. ${localOcrError instanceof Error ? localOcrError.message : ""}`.trim()), {
      statusCode: 422
    });
  }
}