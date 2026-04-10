import { extname } from "node:path";

import sharp from "sharp";
import Tesseract from "tesseract.js";
import { z } from "zod";

import { appEnv } from "../../config/env.js";
import { sanitizeParagraphs } from "./book-import.js";
import { buildRichPageFromParagraphs, normalizeWhitespace as normalizeRichWhitespace } from "./rich-content.js";

export type OcrPageResult = {
  editedText: string;
  htmlContent: string | null;
  paragraphs: string[];
  rawText: string;
};

export type OcrRateLimitError = Error & {
  code: "OCR_RATE_LIMIT";
  retryAfterSeconds: number;
  retryable: true;
  statusCode: 429;
};

type VisionTextAlignment = "center" | "left" | "right";

type VisionBoundingBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

type VisionStructuredBlock =
  | {
      altText?: string;
      bbox: VisionBoundingBox;
      type: "image";
    }
  | {
      alignment?: VisionTextAlignment;
      level?: number;
      text: string;
      type: "heading" | "paragraph";
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
    code?: string;
    message?: string;
    param?: string | null;
    type?: string;
  };
};

type VisionImageRequestPayload = {
  buffer: Buffer;
  mimeType: string;
  optimized: boolean;
};

type VisionImageOptimizationVariant = {
  maxWidth?: number;
  quality: number;
};

type VisionOcrPromptAttempt = {
  maxTokens: number;
  system: string;
  user: string;
};

const ocrResponseSchema = z.object({
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({
      alignment: z.enum(["left", "center", "right"]).optional(),
      level: z.coerce.number().int().min(1).max(6).optional(),
      text: z.string().trim().min(1),
      type: z.literal("heading")
    }),
    z.object({
      alignment: z.enum(["left", "center", "right"]).optional(),
      text: z.string().trim().min(1),
      type: z.literal("paragraph")
    }),
    z.object({
      altText: z.string().trim().max(300).optional(),
      bbox: z.object({
        height: z.coerce.number().min(1).max(1000),
        width: z.coerce.number().min(1).max(1000),
        x: z.coerce.number().min(0).max(1000),
        y: z.coerce.number().min(0).max(1000)
      }),
      type: z.literal("image")
    })
  ])).default([]),
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
const githubModelsImageByteLimit = 5 * 1024 * 1024;
const minimumHeightForMarginCrop = 900;
const optimizedVisionImageTargetBytes = Math.floor(githubModelsImageByteLimit * 0.9);
const optimizedVisionRetryVariants: readonly VisionImageOptimizationVariant[] = [
  { quality: 82 },
  { maxWidth: 2400, quality: 78 },
  { maxWidth: 2000, quality: 74 },
  { maxWidth: 1800, quality: 70 },
  { maxWidth: 1600, quality: 66 },
  { maxWidth: 1400, quality: 62 },
  { maxWidth: 1200, quality: 58 }
] as const;

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function emphasizeBiographyLead(text: string): string {
  if (/\*\*/u.test(text)) {
    return text;
  }

  const biographyLeadMatch = text.match(/^([A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'’-]+){1,5})\.(?=\s+[A-ZÁÉÍÓÚÑ][^\n]*\d{4})/u);
  if (!biographyLeadMatch?.[1]) {
    return text;
  }

  return text.replace(biographyLeadMatch[1], `**${biographyLeadMatch[1]}**`);
}

function stripInlineMarkdown(text: string): string {
  return text.replace(/[*_`~]/g, "").trim();
}

function shouldDemoteHeading(text: string): boolean {
  const normalizedText = stripInlineMarkdown(normalizeRichWhitespace(text));
  if (!normalizedText) {
    return true;
  }

  if (/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/u.test(normalizedText)) {
    return true;
  }

  if (/^[A-ZÁÉÍÓÚÑ][\p{L}'’.-]+(?:\s+[A-ZÁÉÍÓÚÑ][\p{L}'’.-]+){0,4}\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u.test(normalizedText)) {
    return true;
  }

  return false;
}

function isStandaloneDateText(text: string): boolean {
  return /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u.test(stripInlineMarkdown(normalizeRichWhitespace(text)));
}

function looksLikeSignatureHeading(text: string): boolean {
  const normalizedText = stripInlineMarkdown(normalizeRichWhitespace(text));
  if (!normalizedText || normalizedText.length > 48) {
    return false;
  }

  return /^[A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\p{L}'’-]+|[A-ZÁÉÍÓÚÑ]\.)){1,4}$/u.test(normalizedText);
}

function formatStructuredTextBlock(
  block: Extract<VisionStructuredBlock, { type: "heading" | "paragraph" }>,
  nextBlock?: VisionStructuredBlock
): string {
  const hasAdjacentDate = Boolean(nextBlock && nextBlock.type !== "image" && isStandaloneDateText(nextBlock.text));

  if (block.type === "heading" && !shouldDemoteHeading(block.text) && !(hasAdjacentDate && looksLikeSignatureHeading(block.text))) {
    const headingPrefix = `${"#".repeat(Math.max(1, Math.min(6, block.level ?? 1)))} ${block.text}`;
    if (block.alignment === "center" || block.alignment === "left" || block.alignment === "right") {
      return `::${block.alignment}:: ${headingPrefix}`;
    }

    return headingPrefix;
  }

  return emphasizeBiographyLead(block.text);
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

function isRecoverableVisionInputError(errorMessage: string): boolean {
  return /image_too_large|unsupported image|image size exceeds|below\s+5\s*mb|under\s+5\s*mb|one\s+of\s+the\s+following\s+formats|one\s+the\s+following\s+formats|format\s+is\s+not\s+supported/iu.test(errorMessage);
}

function isVisionRateLimitError(errorMessage: string): boolean {
  return /rate\s*limit|too\s+many\s+requests|retry\s+after|please\s+wait\s+\d+\s+seconds?/iu.test(errorMessage);
}

function parseRetryAfterHeader(retryAfterValue: string | null): number | null {
  if (!retryAfterValue) {
    return null;
  }

  const trimmedValue = retryAfterValue.trim();
  const numericValue = Number.parseInt(trimmedValue, 10);
  if (Number.isFinite(numericValue) && numericValue > 0) {
    return numericValue;
  }

  const retryDate = Date.parse(trimmedValue);
  if (Number.isNaN(retryDate)) {
    return null;
  }

  return Math.max(1, Math.ceil((retryDate - Date.now()) / 1000));
}

function extractRetryAfterSecondsFromMessage(errorMessage: string): number | null {
  const explicitSecondsMatch = errorMessage.match(/please\s+wait\s+(\d+)\s+seconds?/iu);
  if (explicitSecondsMatch?.[1]) {
    const seconds = Number.parseInt(explicitSecondsMatch[1], 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  const retryAfterMatch = errorMessage.match(/retry\s+after\s+(\d+)\s+seconds?/iu);
  if (retryAfterMatch?.[1]) {
    const seconds = Number.parseInt(retryAfterMatch[1], 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }

  return null;
}

function normalizeRetryAfterSeconds(retryAfterSeconds: number | null | undefined): number {
  if (!retryAfterSeconds || !Number.isFinite(retryAfterSeconds)) {
    return 15;
  }

  return Math.min(Math.max(Math.ceil(retryAfterSeconds), 1), 300);
}

function createVisionRateLimitError(providerMessage: string, retryAfterSeconds?: number | null): OcrRateLimitError {
  const normalizedRetryAfterSeconds = normalizeRetryAfterSeconds(retryAfterSeconds);

  return Object.assign(new Error(
    `GitHub Models limitó temporalmente el OCR. Reintentando en ${normalizedRetryAfterSeconds} segundos. ${providerMessage}`.trim()
  ), {
    code: "OCR_RATE_LIMIT" as const,
    retryAfterSeconds: normalizedRetryAfterSeconds,
    retryable: true as const,
    statusCode: 429 as const
  });
}

function extractRetryAfterSeconds(response: Response | null, errorMessage: string): number | null {
  const headerRetryAfter = parseRetryAfterHeader(response?.headers.get("retry-after") ?? null);
  if (headerRetryAfter) {
    return headerRetryAfter;
  }

  return extractRetryAfterSecondsFromMessage(errorMessage);
}

export function isRateLimitOcrError(error: unknown): error is OcrRateLimitError {
  return error instanceof Error
    && (error as Partial<OcrRateLimitError>).code === "OCR_RATE_LIMIT"
    && (error as Partial<OcrRateLimitError>).retryable === true
    && typeof (error as Partial<OcrRateLimitError>).retryAfterSeconds === "number";
}

function createVisionProviderError(
  details: { code?: string | null; message?: string | null },
  optimized: boolean,
  fallbackPrefix = "Error OCR de GitHub Models"
): Error {
  const providerMessage = details.message?.trim() || "GitHub Models devolvió un error al procesar la imagen.";
  const providerCode = details.code?.trim() || null;
  const normalizedProviderError = `${providerCode ?? ""} ${providerMessage}`.trim();

  if (isRecoverableVisionInputError(normalizedProviderError)) {
    return Object.assign(new Error(
      optimized
        ? "La imagen sigue siendo demasiado grande o incompatible para el OCR con IA incluso tras optimizarla. Reduce la resolución o usa el modo local."
        : `${fallbackPrefix}: ${providerMessage}`
    ), {
      retryWithOptimizedImage: !optimized,
      statusCode: optimized ? 413 : 502
    });
  }

  return Object.assign(new Error(`${fallbackPrefix}: ${providerMessage}`), {
    statusCode: 502
  });
}

function extractVisionProviderErrorDetails(source: string | ChatCompletionResponse["error"]): { code: string | null; message: string } {
  if (typeof source !== "string") {
    return {
      code: source?.code?.trim() || null,
      message: source?.message?.trim() || "GitHub Models devolvió un error al procesar la imagen."
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
    // Se mantiene el texto crudo cuando el proveedor no devuelve JSON válido.
  }

  return {
    code: null,
    message: source.trim() || "GitHub Models devolvió un error al procesar la imagen."
  };
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

  return pipeline.toBuffer();
}

async function buildOptimizedVisionImagePayload(fileBuffer: Buffer): Promise<VisionImageRequestPayload> {
  let smallestBuffer: Buffer | null = null;

  for (const variant of optimizedVisionRetryVariants) {
    const optimizedBuffer = await sharp(fileBuffer)
      .flatten({ background: "#ffffff" })
      .resize(variant.maxWidth ? { width: variant.maxWidth, withoutEnlargement: true } : undefined)
      .jpeg({ mozjpeg: true, quality: variant.quality })
      .toBuffer();

    if (!smallestBuffer || optimizedBuffer.length < smallestBuffer.length) {
      smallestBuffer = optimizedBuffer;
    }

    if (optimizedBuffer.length <= optimizedVisionImageTargetBytes) {
      return {
        buffer: optimizedBuffer,
        mimeType: "image/jpeg",
        optimized: true
      };
    }
  }

  return {
    buffer: smallestBuffer ?? await sharp(fileBuffer).flatten({ background: "#ffffff" }).jpeg({ mozjpeg: true, quality: 58 }).toBuffer(),
    mimeType: "image/jpeg",
    optimized: true
  };
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

  const richPage = buildRichPageFromParagraphs(paragraphs);

  return {
    editedText: richPage.editedText,
    htmlContent: richPage.htmlContent,
    paragraphs,
    rawText
  };
}

async function cropInlineImageFromBoundingBox(pageBuffer: Buffer, bbox: VisionBoundingBox): Promise<string | null> {
  const metadata = await sharp(pageBuffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (width <= 0 || height <= 0) {
    return null;
  }

  const left = clamp(Math.round((bbox.x / 1000) * width), 0, Math.max(0, width - 1));
  const top = clamp(Math.round((bbox.y / 1000) * height), 0, Math.max(0, height - 1));
  const extractedWidth = clamp(Math.round((bbox.width / 1000) * width), 24, width - left);
  const extractedHeight = clamp(Math.round((bbox.height / 1000) * height), 24, height - top);

  if (extractedWidth < 24 || extractedHeight < 24) {
    return null;
  }

  const imageBuffer = await sharp(pageBuffer)
    .extract({
      height: extractedHeight,
      left,
      top,
      width: extractedWidth
    })
    .png()
    .toBuffer();

  return `data:image/png;base64,${imageBuffer.toString("base64")}`;
}

async function buildStructuredVisionPage(
  croppedBuffer: Buffer,
  blocks: VisionStructuredBlock[],
  fallbackParagraphs: string[],
  fallbackRawText: string
): Promise<OcrPageResult> {
  const paragraphCandidates: string[] = [];
  const embeddedImages = new Map<string, string>();
  let embeddedImageIndex = 1;

  for (const [index, block] of blocks.entries()) {
    const nextBlock = blocks[index + 1];

    if (block.type === "image") {
      const source = await cropInlineImageFromBoundingBox(croppedBuffer, block.bbox);
      if (!source) {
        continue;
      }

      const placeholder = `embedded-image-${embeddedImageIndex}`;
      embeddedImages.set(placeholder, source);
      paragraphCandidates.push(`![${normalizeRichWhitespace(block.altText ?? "Imagen integrada")}](${placeholder})`);
      embeddedImageIndex += 1;
      continue;
    }

    paragraphCandidates.push(formatStructuredTextBlock(block, nextBlock));
  }

  const richPage = paragraphCandidates.length > 0
    ? buildRichPageFromParagraphs(paragraphCandidates, { embeddedImages })
    : buildRichPageFromParagraphs(fallbackParagraphs);
  const paragraphs = sanitizeParagraphs(richPage.paragraphs.length > 0 ? richPage.paragraphs : fallbackParagraphs);
  const rawText = normalizeWhitespace(richPage.rawText || fallbackRawText || paragraphs.join(" "));

  return {
    editedText: richPage.editedText,
    htmlContent: richPage.htmlContent,
    paragraphs,
    rawText
  };
}

async function executeVisionOcrAttempts(
  croppedBuffer: Buffer,
  requestPayload: VisionImageRequestPayload
): Promise<OcrPageResult> {
  const endpointBase = appEnv.githubModelsEndpoint!.replace(/\/$/u, "");
  const promptAttempts: VisionOcrPromptAttempt[] = [
    {
      maxTokens: 2600,
      system: "Analiza una página de libro en español y devuelve una reconstrucción editorial estructurada. Responde solo JSON con las claves rawText, paragraphs y blocks. Usa blocks en orden de lectura con type=heading, paragraph o image. En heading y paragraph preserva negrita y cursiva usando markdown (**negrita**, *cursiva*). En image devuelve altText y bbox con x,y,width,height enteros entre 0 y 1000 relativos a la página recortada. Para headings puedes añadir alignment con left, center o right solo si la alineación es visualmente clara; si no, omítelo. Los párrafos deben respetar el layout real, no los saltos de línea impresos. Omite cabeceras repetidas, pies y números de página. No clasifiques como heading las firmas, dedicatorias manuscritas, nombres firmados ni las fechas.",
      user: "Procesa esta página. Detecta retratos, ilustraciones o imágenes relevantes que formen parte del contenido y devuélvelas como blocks de tipo image. Si el nombre del autor está en negrita, márcalo con **. Si títulos de obras están en cursiva, márcalos con *. Si un heading está claramente centrado o alineado a la derecha, indícalo en alignment. Las firmas y fechas deben ir como paragraph. Una firma seguida por una fecha nunca es heading. Devuelve solo JSON válido."
    },
    {
      maxTokens: 3600,
      system: "Haz OCR estructurado de una página de libro. Devuelve una sola línea JSON válida con rawText, paragraphs y blocks. paragraphs debe contener el texto limpio por párrafos. blocks debe contener headings, paragraphs e imágenes en orden de lectura. Usa markdown dentro del texto para negrita y cursiva. Usa bbox normalizado 0-1000 para imágenes no decorativas. Para headings puedes añadir alignment con left, center o right solo cuando la alineación sea clara. Las firmas, dedicatorias y fechas nunca deben ir como heading.",
      user: "Reconstruye esta página para un EPUB: conserva títulos, énfasis tipográficos e imágenes del contenido. No inventes texto. Si un título está claramente centrado o alineado a la derecha, añádelo en alignment. Devuelve firmas y fechas como paragraph. Una firma seguida de fecha no debe ir como heading. Devuelve solo JSON válido."
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
                  url: `data:${requestPayload.mimeType};base64,${requestPayload.buffer.toString("base64")}`
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
      const errorDetails = extractVisionProviderErrorDetails(errorBody);
      const normalizedProviderError = `${errorDetails.code ?? ""} ${errorDetails.message}`.trim();

      if (response.status === 429 || isVisionRateLimitError(normalizedProviderError)) {
        throw createVisionRateLimitError(
          errorDetails.message,
          extractRetryAfterSeconds(response, normalizedProviderError)
        );
      }

      const nextError = createVisionProviderError(errorDetails, requestPayload.optimized);

      if (isContentFilterError(normalizedProviderError)) {
        lastError = nextError;
        continue;
      }

      throw nextError;
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    if (payload.error?.message) {
      const errorDetails = extractVisionProviderErrorDetails(payload.error);
      const normalizedProviderError = `${errorDetails.code ?? ""} ${errorDetails.message}`.trim();

      if (isVisionRateLimitError(normalizedProviderError)) {
        throw createVisionRateLimitError(
          errorDetails.message,
          extractRetryAfterSeconds(null, normalizedProviderError)
        );
      }

      const nextError = createVisionProviderError(errorDetails, requestPayload.optimized);

      if (isContentFilterError(normalizedProviderError)) {
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

    const paragraphs = sanitizeParagraphs(parsedPayload.paragraphs.map(normalizeWhitespace).filter(Boolean));
    const rawText = normalizeWhitespace(parsedPayload.rawText || paragraphs.join(" "));

    if (paragraphs.length === 0 && parsedPayload.blocks.length === 0) {
      lastError = Object.assign(new Error("GitHub Models no ha podido extraer texto legible de la imagen."), {
        statusCode: 422
      });
      continue;
    }

    return buildStructuredVisionPage(croppedBuffer, parsedPayload.blocks as VisionStructuredBlock[], paragraphs, rawText);
  }

  throw lastError ?? Object.assign(new Error("GitHub Models no ha podido completar el OCR de la imagen."), {
    statusCode: 502
  });
}

async function runVisionOcrWithGitHubModels(fileBuffer: Buffer, normalizedMimeType: string): Promise<OcrPageResult> {
  const croppedBuffer = await cropImageBufferToContent(fileBuffer);

  try {
    return await executeVisionOcrAttempts(croppedBuffer, {
      buffer: croppedBuffer,
      mimeType: normalizedMimeType,
      optimized: false
    });
  } catch (error) {
    if (!(error instanceof Error) || !("retryWithOptimizedImage" in error) || !error.retryWithOptimizedImage) {
      throw error;
    }

    return executeVisionOcrAttempts(croppedBuffer, await buildOptimizedVisionImagePayload(croppedBuffer));
  }
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
    return runVisionOcrWithGitHubModels(fileBuffer, normalizedMimeType);
  }

  try {
    return await runLocalOcrWithTesseract(fileBuffer);
  } catch (localOcrError) {
    if (hasVisionOcrConfiguration()) {
      return runVisionOcrWithGitHubModels(fileBuffer, normalizedMimeType);
    }

    throw Object.assign(new Error(`No se pudo extraer texto legible de la imagen ${fileName}. ${localOcrError instanceof Error ? localOcrError.message : ""}`.trim()), {
      statusCode: 422
    });
  }
}