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

export const supportedImageOcrModes = ["AUTO", "LOCAL", "VISION"] as const;

export type ImageOcrMode = (typeof supportedImageOcrModes)[number];

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type VisionOcrPromptAttempt = {
  maxTokens: number;
  system: string;
  user: string;
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

const contentTopCropRatio = 0.08;
const contentBottomCropRatio = 0.06;
const minimumHeightForMarginCrop = 900;

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

function createVisionOcrParseError(responseText: string, reason?: string): Error {
  const message = reason === "length"
    ? "GitHub Models devolvió un JSON incompleto durante el OCR de la imagen."
    : "GitHub Models devolvió una respuesta no válida durante el OCR de la imagen.";

  return Object.assign(new Error(`${message} Respuesta recibida: ${responseText.slice(0, 400)}`), {
    statusCode: 502
  });
}

function isContentFilterError(errorMessage: string): boolean {
  return /content_filter|ResponsibleAIPolicyViolation|content management policy|jailbreak/iu.test(errorMessage);
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

function hasVisionOcrConfiguration(): boolean {
  return Boolean(appEnv.githubModelsToken && appEnv.githubModelsEndpoint && appEnv.githubModelsVisionModel);
}

function ensureVisionOcrConfiguration(): void {
  if (!hasVisionOcrConfiguration()) {
    throw Object.assign(new Error("El OCR preciso con IA no está disponible en este entorno. Configura GitHub Models para usar este modo."), {
      statusCode: 503
    });
  }
}

async function cropImageBufferToContent(fileBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(fileBuffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  let pipeline = sharp(fileBuffer).flatten({ background: "#ffffff" });

  if (width > 0 && height >= minimumHeightForMarginCrop) {
    const topCrop = Math.max(0, Math.round(height * contentTopCropRatio));
    const bottomCrop = Math.max(0, Math.round(height * contentBottomCropRatio));
    const croppedHeight = height - topCrop - bottomCrop;

    if (croppedHeight > 0) {
      pipeline = pipeline.extract({
        height: croppedHeight,
        left: 0,
        top: topCrop,
        width
      });
    }
  }

  return pipeline.png().toBuffer();
}

async function preprocessImageBuffer(fileBuffer: Buffer): Promise<Buffer> {
  const croppedBuffer = await cropImageBufferToContent(fileBuffer);
  const metadata = await sharp(croppedBuffer).metadata();
  const width = metadata.width ?? 0;
  const targetWidth = width > 0 && width < 1800 ? 1800 : undefined;

  return sharp(croppedBuffer)
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
  const croppedBuffer = await cropImageBufferToContent(fileBuffer);
  const endpointBase = appEnv.githubModelsEndpoint!.replace(/\/$/u, "");
  const promptAttempts: VisionOcrPromptAttempt[] = [
    {
      maxTokens: 2200,
      system: "Transcribe el texto principal de una página de libro en español. Responde con JSON estricto usando solo las claves rawText y paragraphs. rawText debe contener el texto continuo de lectura y paragraphs debe contener bloques listos para lectura en voz alta.",
      user: "Procesa esta imagen de una página de libro y devuelve el texto principal de lectura en el orden natural. Omite cabeceras repetidas y numeración de página. Devuelve solo el JSON solicitado."
    },
    {
      maxTokens: 3200,
      system: "Realiza una transcripción OCR de una página de libro en español. Devuelve únicamente JSON válido en una sola línea. Usa la clave paragraphs como prioritaria y puedes dejar rawText vacío si la página es larga. No uses markdown ni bloques de código.",
      user: "Transcribe esta página de libro en orden de lectura y devuelve solo JSON válido con paragraphs y rawText. Omite cabeceras repetidas y numeración de página."
    }
  ];

  let lastError: Error | null = null;

  for (const promptAttempt of promptAttempts) {
    const response = await fetch(`${endpointBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${appEnv.githubModelsToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        max_tokens: promptAttempt.maxTokens,
        messages: [
          {
            role: "system",
            content: promptAttempt.system
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: promptAttempt.user
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:${normalizedMimeType};base64,${croppedBuffer.toString("base64")}`
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
      const nextError = Object.assign(new Error(`Error OCR de GitHub Models: ${errorBody}`), {
        statusCode: 502
      });

      if (isContentFilterError(errorBody)) {
        lastError = nextError;
        continue;
      }

      throw nextError;
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    if (payload.error?.message) {
      const nextError = Object.assign(new Error(`Error OCR de GitHub Models: ${payload.error.message}`), {
        statusCode: 502
      });

      if (isContentFilterError(payload.error.message)) {
        lastError = nextError;
        continue;
      }

      throw nextError;
    }

    const assistantText = extractAssistantText(payload.choices);
    const finishReason = payload.choices?.[0]?.finish_reason;

    let parsedPayload: z.infer<typeof ocrResponseSchema>;
    try {
      parsedPayload = ocrResponseSchema.parse(JSON.parse(extractJsonPayload(assistantText)));
    } catch {
      lastError = createVisionOcrParseError(assistantText, finishReason);
      continue;
    }

    const paragraphs = sanitizeParagraphs(parsedPayload.paragraphs);
    const rawText = normalizeWhitespace(parsedPayload.rawText || paragraphs.join(" "));

    if (paragraphs.length === 0 || rawText.length === 0) {
      lastError = Object.assign(new Error("GitHub Models no ha podido extraer texto legible de la imagen."), {
        statusCode: 422
      });
      continue;
    }

    return {
      paragraphs,
      rawText
    };
  }

  throw lastError ?? Object.assign(new Error("GitHub Models no ha podido completar el OCR de la imagen."), {
    statusCode: 502
  });
}

export function isSupportedImageUpload(fileName: string, mimeType: string): boolean {
  return supportedImageMimeTypes.has(inferImageMimeType(fileName, mimeType));
}

export async function runOcrOnImage(fileBuffer: Buffer, fileName: string, mimeType: string, ocrMode: ImageOcrMode = "AUTO"): Promise<OcrPageResult> {
  const normalizedMimeType = inferImageMimeType(fileName, mimeType);
  if (!supportedImageMimeTypes.has(normalizedMimeType)) {
    throw Object.assign(new Error(`Formato de imagen no soportado para OCR: ${mimeType || fileName}. Usa PNG, JPG o WEBP.`), {
      statusCode: 415
    });
  }

  if (ocrMode === "LOCAL") {
    return runLocalOcrWithTesseract(fileBuffer);
  }

  if (ocrMode === "VISION") {
    ensureVisionOcrConfiguration();
    return runVisionOcrWithGitHubModels(fileBuffer, "image/png");
  }

  try {
    return await runLocalOcrWithTesseract(fileBuffer);
  } catch (localOcrError) {
    if (hasVisionOcrConfiguration()) {
      return runVisionOcrWithGitHubModels(fileBuffer, "image/png");
    }

    throw Object.assign(new Error(`No se pudo extraer texto legible de la imagen ${fileName}. ${localOcrError instanceof Error ? localOcrError.message : ""}`.trim()), {
      statusCode: 422
    });
  }
}