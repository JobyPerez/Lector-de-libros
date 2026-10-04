import { extname } from "node:path";

import { AnalyzeDocumentCommand, TextractClient, type Block } from "@aws-sdk/client-textract";
import sharp from "sharp";
import Tesseract from "tesseract.js";
import { z } from "zod";

import { appEnv } from "../../config/env.js";
import {
  getOpenCodeChatCompletionsEndpoint,
  getOpenCodeGeminiEndpoint,
  getOpenCodeGeminiRequestHeaders,
  getOpenCodeRequestHeaders,
  isGeminiModel,
  OPENCODE_RESPONSES_ENDPOINT
} from "../../config/opencode.js";
import { sanitizeParagraphs } from "./book-import.js";
import { inferHintedMargin, marginAlignment, pairBottomMargins, type OcrMarginHints } from "./ocr-margins.js";
import { geometrySchema, pageElementRoles, type Geometry, type PageElementRole, type ParagraphElementMetadata } from "./page-elements.js";
import { buildRichPageFromParagraphs, normalizeWhitespace as normalizeRichWhitespace } from "./rich-content.js";

export type OcrPageResult = {
  editedText: string;
  htmlContent: string | null;
  paragraphs: string[];
  paragraphMetadata?: ParagraphElementMetadata[];
  rawText: string;
};

export type OcrRateLimitError = Error & {
  code: "OCR_RATE_LIMIT";
  retryAfterSeconds: number;
  retryable: true;
  statusCode: 429;
};

export type OcrProviderUnavailableError = Error & {
  code: "OCR_PROVIDER_UNAVAILABLE";
  retryAfterSeconds: number;
  retryable: true;
  statusCode: 503;
};

export type OcrInvalidResponseError = Error & {
  code: "OCR_INVALID_RESPONSE";
  retryAfterSeconds: number;
  retryable: true;
  statusCode: 502;
};

export type RetryableOcrError = OcrInvalidResponseError | OcrProviderUnavailableError | OcrRateLimitError;

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
      readingBlockId?: string;
      readingRowId?: string;
      type: "image";
    }
  | {
      alignment?: VisionTextAlignment;
      bbox?: VisionBoundingBox;
      role?: PageElementRole;
      readAloud?: boolean;
      level?: number;
      readingBlockId?: string;
      readingRowId?: string;
      text: string;
      type: "heading" | "paragraph";
    };

export const supportedImageOcrModes = ["AUTO", "LOCAL", "VISION", "TEXTRACT"] as const;

export type ImageOcrMode = (typeof supportedImageOcrModes)[number];
export const supportedImageRotations = [0, 90, 180, 270] as const;

export type ImageRotation = (typeof supportedImageRotations)[number];

export type OcrLanguage = "es" | "it";

type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | Array<{ text?: string; type?: string }>;
      reasoning?: string | null;
    };
  }>;
  error?: {
    code?: string;
    message?: string;
    param?: string | null;
    type?: string;
  };
};

type ResponsesApiResponse = {
  error?: ChatCompletionResponse["error"];
  incomplete_details?: {
    reason?: string;
  } | null;
  output?: Array<{
    content?: Array<{
      text?: string;
      type?: string;
    }>;
    type?: string;
  }>;
  output_text?: string;
  status?: string;
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
  usageMetadata?: {
    candidatesTokenCount?: number;
    promptTokenCount?: number;
    totalTokenCount?: number;
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

type VisionOcrPrompt = {
  maxTokens: number;
  system: string;
  user: string;
};

export type RunOcrOnImageOptions = {
  awsCredentials?: AwsTextractCredentials | null | undefined;
  language?: OcrLanguage;
  marginHints?: OcrMarginHints;
  model?: string;
  ocrMode?: ImageOcrMode;
  opencodeApiKey?: string | null | undefined;
  promptOverride?: string;
  rotation?: ImageRotation;
};

export type AwsTextractCredentials = {
  accessKeyId: string | null;
  region: string | null;
  secretAccessKey: string | null;
};

type CompleteAwsTextractCredentials = {
  accessKeyId: string;
  region: string;
  secretAccessKey: string;
};

const visionBoundingBoxSchema = z.object({
  height: z.coerce.number().min(1).max(1000),
  width: z.coerce.number().min(1).max(1000),
  x: z.coerce.number().min(0).max(1000),
  y: z.coerce.number().min(0).max(1000)
});

const ocrResponseSchema = z.object({
  blocks: z.array(z.discriminatedUnion("type", [
    z.object({
      alignment: z.enum(["left", "center", "right"]).optional(),
      level: z.coerce.number().int().min(1).max(6).optional(),
      readingBlockId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      readingRowId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      text: z.string().trim().min(1),
      type: z.literal("heading"),
      role: z.enum(pageElementRoles).optional(),
      readAloud: z.boolean().optional(),
      bbox: visionBoundingBoxSchema.optional()
    }),
    z.object({
      alignment: z.enum(["left", "center", "right"]).optional(),
      readingBlockId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      readingRowId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      text: z.string().trim().min(1),
      type: z.literal("paragraph"),
      role: z.enum(pageElementRoles).optional(),
      readAloud: z.boolean().optional(),
      bbox: visionBoundingBoxSchema.optional()
    }),
    z.object({
      altText: z.string().trim().max(300).optional(),
      readingBlockId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      readingRowId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u).optional(),
      bbox: visionBoundingBoxSchema,
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
const opencodeVisionImageByteLimit = 5 * 1024 * 1024;
const minimumHeightForMarginCrop = 900;
const optimizedVisionImageTargetBytes = Math.floor(opencodeVisionImageByteLimit * 0.9);
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

function startsWithLowercaseLetter(value: string): boolean {
  return /^\p{Ll}/u.test(value);
}

function joinLinesJoiningHyphens(lines: string[]): string {
  let mergedText = "";

  for (const line of lines) {
    const normalizedLine = normalizeWhitespace(line);
    if (!normalizedLine) {
      continue;
    }

    if (!mergedText) {
      mergedText = normalizedLine;
      continue;
    }

    if (/[\p{L}\p{N}]-$/u.test(mergedText) && startsWithLowercaseLetter(normalizedLine)) {
      mergedText = `${mergedText.slice(0, -1)}${normalizedLine}`;
      continue;
    }

    mergedText = `${mergedText} ${normalizedLine}`;
  }

  return normalizeWhitespace(mergedText);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function elementMetadata(role: PageElementRole, geometry: Geometry | null = null, readAloud?: boolean): ParagraphElementMetadata {
  return { role, readAloud: readAloud ?? !["header", "footer", "pageNumber"].includes(role), geometry };
}

function normalizedGeometry(box: Geometry["bbox"] | null): Geometry | null {
  const parsed = geometrySchema.safeParse(box ? { bbox: box } : null);
  return parsed.success ? parsed.data : null;
}

function emphasizeBiographyLead(text: string): string {
  if (/\*\*/u.test(text)) {
    return text;
  }

  const biographyLeadMatch = text.match(/^(\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){1,5})\.(?=\s+\p{Lu}[^\n]*\d{4})/u);
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

  if (/^\p{Lu}[\p{L}'’.-]+(?:\s+\p{Lu}[\p{L}'’.-]+){0,4}\s+\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u.test(normalizedText)) {
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

  return /^\p{Lu}[\p{L}'’-]+(?:\s+(?:\p{Lu}[\p{L}'’-]+|\p{Lu}\.)){1,4}$/u.test(normalizedText);
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

  const paragraph = emphasizeBiographyLead(block.text);
  return block.alignment ? `::${block.alignment}:: ${paragraph}` : paragraph;
}

function cleanOcrText(rawText: string): string {
  return rawText
    .replace(/[|]/g, "I")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/(\p{Ll})\n(?=\p{Ll})/gu, "$1 ")
    .replace(/([\p{L}\p{N}])-\n(?=\p{Ll})/gu, "$1")
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

  return content?.[0]?.message?.reasoning?.trim() ?? "";
}

export function extractResponsesApiText(payload: ResponsesApiResponse): string {
  if (payload.output_text?.trim()) {
    return payload.output_text.trim();
  }

  return (payload.output ?? [])
    .flatMap((item) => item.content ?? [])
    .map((item) => item.text ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function getOpenCodeMaxTokens(model: string, requestedMaxTokens: number): number {
  return model.endsWith("-free") ? Math.max(requestedMaxTokens, 4096) : requestedMaxTokens;
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

function escapeControlCharsInsideJsonStrings(jsonText: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (const char of jsonText) {
    if (!inString) {
      if (char === "\"") {
        inString = true;
      }
      repaired += char;
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      repaired += char;
      continue;
    }

    if (char === "\"") {
      inString = false;
      repaired += char;
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }

    if (char === "\r") {
      repaired += "\\r";
      continue;
    }

    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function parseOcrJsonPayload(jsonText: string): z.infer<typeof ocrResponseSchema> {
  try {
    return ocrResponseSchema.parse(JSON.parse(jsonText));
  } catch (error) {
    const repairedJsonText = escapeControlCharsInsideJsonStrings(jsonText);
    if (repairedJsonText === jsonText) {
      throw error;
    }

    return ocrResponseSchema.parse(JSON.parse(repairedJsonText));
  }
}

function createVisionOcrParseError(responseText: string, reason?: string): OcrInvalidResponseError {
  const message = reason === "length"
    ? "OpenCode devolvió un JSON incompleto durante el OCR de la imagen."
    : "OpenCode devolvió una respuesta no válida durante el OCR de la imagen.";

  return Object.assign(new Error(`${message} Respuesta recibida: ${responseText.slice(0, 400)}`), {
    code: "OCR_INVALID_RESPONSE" as const,
    retryAfterSeconds: 5,
    retryable: true as const,
    statusCode: 502 as const
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
    `OpenCode limitó temporalmente el OCR. Reintentando en ${normalizedRetryAfterSeconds} segundos. ${providerMessage}`.trim()
  ), {
    code: "OCR_RATE_LIMIT" as const,
    retryAfterSeconds: normalizedRetryAfterSeconds,
    retryable: true as const,
    statusCode: 429 as const
  });
}

function createVisionProviderUnavailableError(providerMessage: string, retryAfterSeconds?: number | null): OcrProviderUnavailableError {
  const normalizedRetryAfterSeconds = normalizeRetryAfterSeconds(retryAfterSeconds ?? 10);

  return Object.assign(new Error(
    `El servicio de OCR de OpenCode no está disponible temporalmente. Reintentando en ${normalizedRetryAfterSeconds} segundos. ${providerMessage}`.trim()
  ), {
    code: "OCR_PROVIDER_UNAVAILABLE" as const,
    retryAfterSeconds: normalizedRetryAfterSeconds,
    retryable: true as const,
    statusCode: 503 as const
  });
}

function isVisionProviderUnavailableError(code: string | null, message: string): boolean {
  return /router\.unavailable/iu.test(`${code ?? ""} ${message}`) || code === "CreditsError" || /CreditsError/iu.test(message);
}

function extractRetryAfterSeconds(response: Response | null, errorMessage: string): number | null {
  const headerRetryAfter = parseRetryAfterHeader(response?.headers.get("retry-after") ?? null);
  if (headerRetryAfter) {
    return headerRetryAfter;
  }

  return extractRetryAfterSecondsFromMessage(errorMessage);
}

export function isRetryableOcrError(error: unknown): error is RetryableOcrError {
  return error instanceof Error
    && ((error as Partial<RetryableOcrError>).code === "OCR_RATE_LIMIT" || (error as Partial<RetryableOcrError>).code === "OCR_PROVIDER_UNAVAILABLE" || (error as Partial<RetryableOcrError>).code === "OCR_INVALID_RESPONSE")
    && (error as Partial<RetryableOcrError>).retryable === true
    && typeof (error as Partial<RetryableOcrError>).retryAfterSeconds === "number";
}

function createVisionProviderError(
  details: { code?: string | null; message?: string | null },
  optimized: boolean,
  fallbackPrefix = "Error OCR de OpenCode"
): Error {
  const providerMessage = details.message?.trim() || "OpenCode devolvió un error al procesar la imagen.";
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
      message: source?.message?.trim() || "OpenCode devolvió un error al procesar la imagen."
    };
  }

  try {
    const payload = JSON.parse(source) as ChatCompletionResponse & { type?: string };
    if (payload.error?.message) {
      return {
        code: payload.error.code?.trim() || null,
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
    // Se mantiene el texto crudo cuando el proveedor no devuelve JSON válido.
  }

  return {
    code: null,
    message: source.trim() || "OpenCode devolvió un error al procesar la imagen."
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

export async function applyImageRotation(fileBuffer: Buffer, rotation: ImageRotation = 0): Promise<Buffer> {
  if (rotation === 0) {
    return fileBuffer;
  }

  return sharp(fileBuffer).rotate(rotation).toBuffer();
}

function buildParagraphsFromRawText(rawText: string): string[] {
  const normalizedText = cleanOcrText(rawText.replace(/\r/g, "")).trim();
  if (!normalizedText) {
    return [];
  }

  const paragraphCandidates = normalizedText
    .split(/\n+/u)
    .map(normalizeWhitespace)
    .filter(Boolean);

  return sanitizeParagraphs(paragraphCandidates.length > 0 ? paragraphCandidates : [normalizedText]);
}

export function hasVisionOcrConfiguration(opencodeApiKey?: string | null): boolean {
  return Boolean(opencodeApiKey ?? appEnv.opencodeGoApiKey);
}

export function ensureVisionOcrConfiguration(opencodeApiKey?: string | null): void {
  if (!hasVisionOcrConfiguration(opencodeApiKey)) {
    throw Object.assign(new Error("Te falta la clave de OpenCode para el OCR con visión. Rellénala en Configuración IA (/ai-settings) o usa la compartida del administrador."), {
      code: "MISSING_OPENCODE",
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

export function getTesseractLanguages(language: OcrLanguage): "ita+eng" | "spa+eng" {
  return language === "it" ? "ita+eng" : "spa+eng";
}

async function runLocalOcrWithTesseract(fileBuffer: Buffer, language: OcrLanguage): Promise<OcrPageResult> {
  const processedBuffer = await preprocessImageBuffer(fileBuffer);
  const result = await Tesseract.recognize(processedBuffer, getTesseractLanguages(language), {
    logger: () => undefined
  });
  const cleanedText = cleanOcrText(result.data.text ?? "");
  const rawText = normalizeWhitespace(cleanedText);
  const paragraphs = buildParagraphsFromRawText(cleanedText);

  if (rawText.length === 0 || paragraphs.length === 0) {
    throw new Error("Tesseract no ha podido extraer texto legible de la imagen.");
  }

  const richPage = buildRichPageFromParagraphs(paragraphs, { inferHeadings: false });

  return {
    editedText: richPage.editedText,
    htmlContent: richPage.htmlContent,
    paragraphs,
    paragraphMetadata: paragraphs.map(() => elementMetadata("body")),
    rawText
  };
}

async function cropInlineImageFromBoundingBox(pageBuffer: Buffer, bbox: VisionBoundingBox): Promise<{ source: string; geometry: Geometry } | null> {
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

  return { source: `data:image/png;base64,${imageBuffer.toString("base64")}`, geometry: {
    bbox: { left: left / width, top: top / height, width: extractedWidth / width, height: extractedHeight / height }
  } };
}

export async function buildStructuredVisionPage(
  pageBuffer: Buffer,
  blocks: VisionStructuredBlock[],
  fallbackParagraphs: string[],
  fallbackRawText: string,
  language: OcrLanguage = "es",
  marginHints?: OcrMarginHints
): Promise<OcrPageResult> {
  const visionGeometry = (block: VisionStructuredBlock) => block.bbox ? normalizedGeometry({
    left: block.bbox.x / 1000, top: block.bbox.y / 1000, width: block.bbox.width / 1000, height: block.bbox.height / 1000
  })?.bbox ?? null : null;
  const body = blocks.filter((block) => block.type === "paragraph" && (!block.role || block.role === "body"))
    .flatMap((block) => { const box = visionGeometry(block); return box ? [box] : []; });
  const reserved = new Set(blocks.map((block) => block.readingBlockId));
  blocks = blocks.map((block, index): VisionStructuredBlock => {
    if (block.type === "image") return { ...block };
    const box = visionGeometry(block);
    const inferred = (!block.role || ["body", "heading"].includes(block.role)) && inferHintedMargin(block.text, box, body, marginHints);
    const role = inferred || block.role;
    let readingBlockId = block.readingBlockId;
    if (inferred) {
      readingBlockId = `vision-margin-${index + 1}`;
      while (reserved.has(readingBlockId)) readingBlockId += "-2";
      reserved.add(readingBlockId);
    }
    const result = { ...block };
    if (role) result.role = role;
    if (inferred) {
      result.type = "paragraph";
      result.readAloud = false;
      result.readingBlockId = readingBlockId!;
      delete result.readingRowId;
    }
    if (role && ["header", "footer", "pageNumber"].includes(role) && !result.readingBlockId) {
      let id = `vision-margin-${index + 1}`;
      while (reserved.has(id)) id += "-2";
      reserved.add(id);
      result.readingBlockId = id;
    }
    const alignment = role ? marginAlignment(role, box) : undefined;
    if (alignment) result.alignment = alignment;
    return result;
  });
  const providerRows = new Set(blocks.map((block) => block.readingRowId));
  const bodyBlockIds = new Set(blocks.filter((block) => block.type === "image" || !["footer", "pageNumber"].includes(block.role ?? ""))
    .map((block) => block.readingBlockId).filter(Boolean));
  blocks = pairBottomMargins(blocks, (block) => block.type === "image" || (block.readingBlockId && bodyBlockIds.has(block.readingBlockId))
    ? null : { role: block.role ?? "body", box: visionGeometry(block) }, "vision");
  blocks = blocks.map((block, index) => {
    if (!block.readingRowId || providerRows.has(block.readingRowId)) return block;
    let id = `vision-margin-block-${index + 1}`;
    while (reserved.has(id)) id += "-2";
    reserved.add(id);
    return { ...block, readingBlockId: id };
  });
  const paragraphCandidates: string[] = [];
  const paragraphMetadata: ParagraphElementMetadata[] = [];
  const embeddedImages = new Map<string, string>();
  let embeddedImageIndex = 1;
  let currentReadingBlockId: string | undefined;
  let implicitBodyId: string | undefined;
  let previousWasMargin = false;
  const reservedIds = new Set(blocks.map((block) => block.readingBlockId));
  const usedIds = new Set<string>();
  const reservedRows = new Set(blocks.map((block) => block.readingRowId));
  const usedRows = new Set<string>();
  let currentRow: string | undefined;
  let normalizedRow: string | undefined;

  for (const [index, block] of blocks.entries()) {
    const nextBlock = blocks[index + 1];
    let editableBlock: string;
    let descriptor: ParagraphElementMetadata;

    if (block.type === "image") {
      const source = await cropInlineImageFromBoundingBox(pageBuffer, block.bbox);
      if (!source) {
        continue;
      }

      const placeholder = `embedded-image-${embeddedImageIndex}`;
      embeddedImages.set(placeholder, source.source);
      descriptor = elementMetadata("image", source.geometry);
      editableBlock = `![${normalizeRichWhitespace(block.altText ?? "Imagen integrada")}](${placeholder})`;
      embeddedImageIndex += 1;
    } else {
      editableBlock = formatStructuredTextBlock(["header", "footer", "pageNumber"].includes(block.role ?? "") ? { ...block, type: "paragraph" } : block, nextBlock);
      const box = block.bbox;
      descriptor = elementMetadata(block.role ?? (block.type === "heading" ? "heading" : "body"), box ? normalizedGeometry({
        left: box.x / 1000, top: box.y / 1000, width: box.width / 1000, height: box.height / 1000
      }) : null, block.readAloud);
    }

    const row = block.readingRowId;
    const rowChanged = row !== currentRow;
    const isMargin = ["header", "footer", "pageNumber"].includes(descriptor.role);
    if (!isMargin && previousWasMargin && !block.readingBlockId) {
      implicitBodyId = `vision-body-${index + 1}`;
      while (reservedIds.has(implicitBodyId) || usedIds.has(implicitBodyId)) implicitBodyId += "-2";
      reservedIds.add(implicitBodyId);
    }
    if (isMargin) implicitBodyId = undefined;
    previousWasMargin = isMargin;
    const requestedId = block.readingBlockId ?? (row || rowChanged ? `vision-${index + 1}` : implicitBodyId);
    if (requestedId && (requestedId !== currentReadingBlockId || rowChanged)) {
      if (rowChanged) {
        normalizedRow = row;
        if (row) {
          for (let suffix = 2; usedRows.has(normalizedRow!) || (normalizedRow !== row && reservedRows.has(normalizedRow)); suffix += 1) {
            const ending = `-${suffix}`;
            normalizedRow = `${row.slice(0, 80 - ending.length)}${ending}`;
          }
          usedRows.add(normalizedRow!);
        }
        currentRow = row;
      }
      let markerId = requestedId;
      // Keep reading order even if the model reuses an ID in a nonconsecutive run.
      for (let suffix = 2; usedIds.has(markerId) || (markerId !== requestedId && reservedIds.has(markerId)); suffix += 1) {
        const ending = `-${suffix}`;
        markerId = `${requestedId.slice(0, 80 - ending.length)}${ending}`;
      }
      usedIds.add(markerId);
      paragraphCandidates.push(`:::block ${markerId}${normalizedRow ? ` row=${normalizedRow}` : ""}`);
      currentReadingBlockId = requestedId;
    }
    paragraphCandidates.push(editableBlock);
    // Only rendered paragraphs consume a descriptor; markers and empty text do not.
    if (block.type === "image" || buildRichPageFromParagraphs([editableBlock], { inferHeadings: false }).paragraphs.length) paragraphMetadata.push(descriptor);
  }

  let richPage = buildRichPageFromParagraphs(paragraphCandidates, { embeddedImages, inferHeadings: false, languageCode: language, paragraphMetadata });
  if (richPage.paragraphs.length === 0) {
    const fallback = buildRichPageFromParagraphs(fallbackParagraphs, { inferHeadings: false, languageCode: language });
    richPage = { ...fallback, paragraphMetadata: fallback.paragraphs.map(() => elementMetadata("body")) };
  }
  const paragraphs = richPage.paragraphs;
  const rawText = normalizeWhitespace(richPage.rawText || fallbackRawText || paragraphs.join(" "));

  return {
    editedText: richPage.editedText,
    htmlContent: richPage.htmlContent,
    paragraphs,
    ...(richPage.paragraphMetadata ? { paragraphMetadata: richPage.paragraphMetadata } : {}),
    rawText
  };
}

export function buildVisionOcrPrompt(language: OcrLanguage, promptOverride?: string, marginHints?: OcrMarginHints): VisionOcrPrompt {
  const normalizedPromptOverride = promptOverride?.trim();
  const marginInstructions = (language === "it"
    ? "Pie di pagina e numero affiancati sulla stessa riga: due readingBlockId distinti, stesso readingRowId. "
    : "Pie y numero de pagina contiguos en la misma fila: dos readingBlockId distintos, mismo readingRowId. ") +
    (marginHints ? `Known repeated margin hints (not chapter titles; require isolated margin geometry): ${JSON.stringify(marginHints)}. ` : "");

  const system = language === "it"
    ? "Esegui un OCR strutturato di una pagina di libro in italiano. Restituisci esclusivamente JSON valido con le chiavi rawText, paragraphs e blocks. rawText deve contenere il testo globale ripulito; paragraphs deve contenere il testo ripulito suddiviso in paragrafi; blocks deve contenere elementi type=heading, paragraph o image nell'ordine di lettura. In heading e paragraph conserva grassetto e corsivo usando markdown (**grassetto**, *corsivo*). In image restituisci altText e bbox con x,y,width,height interi tra 0 e 1000 relativi alla pagina ritagliata. Rileva ritratti, illustrazioni o immagini rilevanti del contenuto e restituiscili come blocks di tipo image. I paragrafi devono rispettare il layout reale, non le interruzioni di riga stampate. Non inventare testo. Per gli heading puoi aggiungere alignment con left, center o right solo se l'allineamento è visivamente chiaro; altrimenti omettilo. Firme, dediche manoscritte, nomi firmati e date non devono mai essere classificati come heading; devono essere paragraph. Una firma seguita da una data non è mai un heading."
    : "Haz OCR estructurado de una página de libro en español. Devuelve solo JSON válido con las claves rawText, paragraphs y blocks. rawText debe contener el texto limpio global; paragraphs debe contener el texto limpio por párrafos; blocks debe contener elementos type=heading, paragraph o image en orden de lectura. En heading y paragraph preserva negrita y cursiva usando markdown (**negrita**, *cursiva*). En image devuelve altText y bbox con x,y,width,height enteros entre 0 y 1000 relativos a la página recortada. Detecta retratos, ilustraciones o imágenes relevantes del contenido y devuélvelas como blocks de tipo image. Los párrafos deben respetar el layout real, no los saltos de línea impresos. No inventes texto. Para headings puedes añadir alignment con left, center o right solo si la alineación es visualmente clara; si no, omítelo. Las firmas, dedicatorias manuscritas, nombres firmados y fechas nunca deben clasificarse como heading; deben ir como paragraph. Una firma seguida de una fecha nunca es heading.";

  return {
    maxTokens: 8192,
    system: marginInstructions + (language === "it"
      ? "In heading e paragraph aggiungi role opzionale: body, heading, imageCaption, header, footer o pageNumber; bbox opzionale usa x,y,width,height tra 0 e 1000 della pagina completa. Distingui le intestazioni ripetute (header) dai veri titoli di capitolo (heading). Conserva visivamente i numeri di pagina come pageNumber. Classifica le didascalie vicine alle immagini come imageCaption. readAloud opzionale e false per header, footer e pageNumber, true per gli altri ruoli; rispetta un valore esplicitamente richiesto dall'utente. "
      : "En heading y paragraph añade role opcional: body, heading, imageCaption, header, footer o pageNumber; bbox opcional usa x,y,width,height entre 0 y 1000 de la pagina completa. Distingue cabeceras repetidas (header) de verdaderos titulos de capitulo (heading). Conserva visualmente los numeros de pagina como pageNumber. Clasifica los pies cercanos a imagenes como imageCaption. readAloud opcional es false para header, footer y pageNumber, true para los otros roles; respeta un valor solicitado explicitamente por el usuario. ") + (language === "it"
      ? "Ogni elemento puo avere readingRowId opzionale con ^[a-zA-Z0-9_-]{1,80}$. Rileva colonne o riquadri affiancati: assegna lo stesso readingRowId ai loro blocchi distinti. Completa ciascun blocco prima del successivo; tutti i blocchi della stessa riga devono essere consecutivi e la riga non puo ricomparire dopo altre righe o blocchi senza riga. Intestazioni e pie di pagina sono gruppi separati. "
      : "Cada elemento puede tener readingRowId opcional con ^[a-zA-Z0-9_-]{1,80}$. Detecta columnas o recuadros side-by-side: asigna el mismo readingRowId a sus bloques distintos. Completa cada bloque antes del siguiente; todos los bloques de la misma fila deben ser consecutivos y la fila no puede reaparecer tras otras filas o bloques sin fila. Cabeceras y pies son grupos aparte. ") + system.replace(language === "it" ? "pagina ritagliata" : "página recortada", language === "it" ? "pagina completa" : "página completa") + (language === "it"
      ? " Conserva anche intestazioni e piè di pagina: non ritagliare né omettere automaticamente i margini. Ogni elemento di blocks può avere readingBlockId, una stringa che rispetta ^[a-zA-Z0-9_-]{1,80}$. Assegna lo stesso id a paragrafi, titoli e immagini dello stesso blocco semantico. Il testo continuo forma un unico blocco; colonne, riquadri e sezioni di vocabolario formano blocchi separati. Gli elementi di ogni blocco devono essere consecutivi e i blocchi devono seguire l'ordine di lettura, completando una colonna prima della successiva. Non confondere le dimensioni dei titoli con un indice: usa level per la gerarchia del titolo, non per il numero o l'ordine del blocco."
      : " Conserva también cabeceras y pies de página: no recortes ni omitas automáticamente los márgenes. Cada elemento de blocks puede tener readingBlockId, una cadena que cumple ^[a-zA-Z0-9_-]{1,80}$. Asigna el mismo id a párrafos, títulos e imágenes del mismo bloque semántico. El texto corrido forma un único bloque; columnas, recuadros y secciones de vocabulario forman bloques separados. Los elementos de cada bloque deben ser consecutivos y los bloques deben seguir el orden de lectura, completando una columna antes de la siguiente. No confundas los tamaños de los títulos con un índice: usa level para la jerarquía del título, no para el número ni el orden del bloque."),
    user: normalizedPromptOverride || (language === "it"
      ? "Nessuna istruzione aggiuntiva dell'utente. Applica esclusivamente le regole del messaggio system."
      : "Sin instrucciones adicionales del usuario. Aplica únicamente las reglas del mensaje system.")
  };
}

const visionOcrMaxTokensCeiling = 16384;

async function executeVisionOcrRequest(
  pageBuffer: Buffer,
  requestPayload: VisionImageRequestPayload,
  language: OcrLanguage,
  model: string,
  promptOverride?: string,
  maxTokensOverride?: number,
  opencodeApiKey?: string | null,
  marginHints?: OcrMarginHints
): Promise<OcrPageResult> {
  const prompt = buildVisionOcrPrompt(language, promptOverride, marginHints);
  const maxTokens = maxTokensOverride ?? prompt.maxTokens;
  const usesGeminiApi = isGeminiModel(model);
  const usesResponsesApi = model === "gpt-5.4-nano" || model === "gpt-5.4-mini";
  const endpoint = usesGeminiApi
    ? getOpenCodeGeminiEndpoint(model)
    : usesResponsesApi
      ? OPENCODE_RESPONSES_ENDPOINT
      : getOpenCodeChatCompletionsEndpoint(model);
  const imageUrl = `data:${requestPayload.mimeType};base64,${requestPayload.buffer.toString("base64")}`;

  const effectiveApiKey = opencodeApiKey ?? appEnv.opencodeGoApiKey;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: usesGeminiApi
      ? getOpenCodeGeminiRequestHeaders(effectiveApiKey)
      : getOpenCodeRequestHeaders(effectiveApiKey),
    body: JSON.stringify(usesGeminiApi
      ? {
          contents: [
            {
              parts: [
                { text: `${prompt.system}\n\n${prompt.user}` },
                {
                  inlineData: {
                    data: requestPayload.buffer.toString("base64"),
                    mimeType: requestPayload.mimeType
                  }
                }
              ],
              role: "user"
            }
          ],
          generationConfig: {
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
            temperature: 0
          }
        }
      : usesResponsesApi
        ? {
            input: [{
              content: [
                {
                  text: `${prompt.user}\n\n${language === "it" ? "Restituisci esclusivamente JSON valido." : "Devuelve solo JSON válido."}`,
                  type: "input_text"
                },
                { image_url: imageUrl, type: "input_image" }
              ],
              role: "user"
            }],
            instructions: prompt.system,
            max_output_tokens: maxTokens,
            model,
            reasoning: { effort: "none" },
            text: { format: { type: "json_object" } }
          }
        : {
            max_tokens: getOpenCodeMaxTokens(model, maxTokens),
            messages: [
              {
                role: "system",
                content: prompt.system
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: prompt.user
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: imageUrl
                    }
                  }
                ]
              }
            ],
            model,
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

    if (isVisionProviderUnavailableError(errorDetails.code, errorDetails.message)) {
      throw createVisionProviderUnavailableError(
        errorDetails.message,
        extractRetryAfterSeconds(response, normalizedProviderError)
      );
    }

    throw createVisionProviderError(errorDetails, requestPayload.optimized);
  }

  const payload = (await response.json()) as ChatCompletionResponse & ResponsesApiResponse & GeminiGenerateContentResponse;
  if (payload.error?.message) {
    const errorDetails = extractVisionProviderErrorDetails(payload.error as any);
    const normalizedProviderError = `${errorDetails.code ?? ""} ${errorDetails.message}`.trim();

    if (isVisionRateLimitError(normalizedProviderError)) {
      throw createVisionRateLimitError(
        errorDetails.message,
        extractRetryAfterSeconds(null, normalizedProviderError)
      );
    }

    if (isVisionProviderUnavailableError(errorDetails.code, errorDetails.message)) {
      throw createVisionProviderUnavailableError(
        errorDetails.message,
        extractRetryAfterSeconds(null, normalizedProviderError)
      );
    }

    throw createVisionProviderError(errorDetails, requestPayload.optimized);
  }

  let assistantText: string;
  let finishReason: string | undefined;

  if (usesGeminiApi) {
    const candidate = payload.candidates?.[0];
    if (payload.promptFeedback?.blockReason || (candidate?.finishReason && !["STOP", "MAX_TOKENS"].includes(candidate.finishReason))) {
      throw Object.assign(new Error("OpenCode bloqueó el OCR por sus políticas de contenido."), {
        statusCode: 422
      });
    }

    if (candidate?.finishReason === "MAX_TOKENS") {
      finishReason = "length";
    } else {
      finishReason = candidate?.finishReason;
    }

    assistantText = (candidate?.content?.parts || [])
      .filter((part) => !part.thought && typeof part.text === "string")
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  } else if (usesResponsesApi) {
    assistantText = extractResponsesApiText(payload);
    finishReason = payload.status === "incomplete"
      ? payload.incomplete_details?.reason === "max_output_tokens" ? "length" : payload.incomplete_details?.reason
      : payload.choices?.[0]?.finish_reason;
  } else {
    assistantText = extractAssistantText(payload.choices);
    finishReason = payload.choices?.[0]?.finish_reason;
  }

  let parsedPayload: z.infer<typeof ocrResponseSchema>;
  try {
    parsedPayload = parseOcrJsonPayload(extractJsonPayload(assistantText));
  } catch {
    if (finishReason === "length" && maxTokens < visionOcrMaxTokensCeiling) {
      return executeVisionOcrRequest(
        pageBuffer,
        requestPayload,
        language,
        model,
        promptOverride,
        Math.min(maxTokens * 2, visionOcrMaxTokensCeiling),
        opencodeApiKey,
        marginHints
      );
    }

    throw createVisionOcrParseError(assistantText, finishReason);
  }

  const paragraphs = sanitizeParagraphs(parsedPayload.paragraphs.map(normalizeWhitespace).filter(Boolean));
  const rawText = normalizeWhitespace(parsedPayload.rawText || paragraphs.join(" "));

  if (paragraphs.length === 0 && parsedPayload.blocks.length === 0) {
    throw Object.assign(new Error("OpenCode no ha podido extraer texto legible de la imagen."), {
      statusCode: 422
    });
  }

  return buildStructuredVisionPage(pageBuffer, parsedPayload.blocks as VisionStructuredBlock[], paragraphs, rawText, language, marginHints);
}

async function runVisionOcrWithOpenCode(fileBuffer: Buffer, normalizedMimeType: string, language: OcrLanguage, model: string, promptOverride?: string, opencodeApiKey?: string | null, marginHints?: OcrMarginHints): Promise<OcrPageResult> {
  try {
    return await executeVisionOcrRequest(fileBuffer, {
      buffer: fileBuffer,
      mimeType: normalizedMimeType,
      optimized: false
    }, language, model, promptOverride, undefined, opencodeApiKey, marginHints);
  } catch (error) {
    if (!(error instanceof Error) || !("retryWithOptimizedImage" in error) || !error.retryWithOptimizedImage) {
      throw error;
    }

    return executeVisionOcrRequest(fileBuffer, await buildOptimizedVisionImagePayload(fileBuffer), language, model, promptOverride, undefined, opencodeApiKey, marginHints);
  }
}

function hasTextractConfiguration(credentials?: AwsTextractCredentials | null): credentials is CompleteAwsTextractCredentials {
  return Boolean(credentials?.region && credentials.accessKeyId && credentials.secretAccessKey);
}

function ensureTextractConfiguration(credentials?: AwsTextractCredentials | null): asserts credentials is CompleteAwsTextractCredentials {
  if (!hasTextractConfiguration(credentials)) {
    throw Object.assign(new Error("Te faltan las credenciales de AWS para el OCR con Textract. Rellénalas en Configuración IA (/ai-settings) o usa las compartidas del administrador."), {
      code: "MISSING_AWS",
      statusCode: 503
    });
  }
}

type LayoutBox = { left: number; top: number; width: number; height: number };
export type TextractReadingGroup = { readingBlockId: string; readingRowId?: string; blocks: Block[] };

function layoutBox(block: Block): LayoutBox | null {
  const box = block.Geometry?.BoundingBox;
  if (!box || ![box.Left, box.Top, box.Width, box.Height].every((value) => typeof value === "number" && Number.isFinite(value)) || box.Width! <= 0 || box.Height! <= 0) return null;
  return { left: box.Left!, top: box.Top!, width: box.Width!, height: box.Height! };
}

// Pure geometry grouping. Incomplete legacy boxes retain AWS's reading order.
export function groupTextractLayoutBlocks(blocks: Block[]): TextractReadingGroup[] {
  const map = new Map(blocks.map((block) => [block.Id, block]));
  const nested = new Set<string>();
  for (const block of blocks.filter((item) => item.BlockType?.startsWith("LAYOUT_"))) {
    const visited = new Set<string>();
    const visit = (parent: Block) => {
      for (const relation of parent.Relationships ?? []) {
        if (relation.Type !== "CHILD") continue;
        for (const id of relation.Ids ?? []) {
          if (visited.has(id)) continue;
          visited.add(id);
          const child = map.get(id);
          if (!child) continue;
          if (child.BlockType?.startsWith("LAYOUT_")) nested.add(id);
          visit(child);
        }
      }
    };
    visit(block);
  }
  const layouts = blocks.filter((block) => block.BlockType && ["LAYOUT_TEXT", "LAYOUT_TITLE", "LAYOUT_SECTION_HEADER", "LAYOUT_LIST", "LAYOUT_FIGURE", "LAYOUT_HEADER", "LAYOUT_FOOTER", "LAYOUT_PAGE_NUMBER"].includes(block.BlockType) && (!block.Id || !nested.has(block.Id)));
  const margin = (block: Block) => ["LAYOUT_HEADER", "LAYOUT_FOOTER", "LAYOUT_PAGE_NUMBER"].includes(block.BlockType ?? "");
  const horizontalOverlap = (a: LayoutBox, b: LayoutBox) => Math.max(0, Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left));
  const sideBySide = (a: LayoutBox, b: LayoutBox) => horizontalOverlap(a, b) <= 0.01 && Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top) >= -0.015;
  const body = layouts.filter((block) => !margin(block));
  const complete = body.every((block) => layoutBox(block));
  // Inline icons, short headings and captions cannot establish columns.
  const anchors = body.filter((block) => {
    const box = layoutBox(block);
    return box && box.width >= 0.15 && box.height >= 0.025;
  });
  const pairs = complete ? anchors.flatMap((block, index) => anchors.slice(index + 1).flatMap((other) => {
    const a = layoutBox(block)!;
    const b = layoutBox(other)!;
    return sideBySide(a, b) ? [[a, b] as const] : [];
  })) : [];
  const columns = pairs.length > 0;
  const geometry = layouts.map((block, index) => {
    const box = layoutBox(block);
    const rawTop = block.Geometry?.BoundingBox?.Top;
    const top = typeof rawTop === "number" && Number.isFinite(rawTop) ? rawTop : undefined;
    return { block, index, box, top, margin: margin(block), spanning: Boolean(!margin(block) && box && pairs.some((pair) => pair.every((column) => horizontalOverlap(box, column) / column.width >= 0.6))) };
  });
  if (columns) {
    const substantial = geometry.filter((item) => !item.margin && !item.spanning && anchors.includes(item.block));
    const intervals: Array<{ top: number; bottom: number }> = [];
    for (const item of [...substantial].sort((a, b) => a.top! - b.top!)) {
      const box = item.box!;
      const last = intervals.at(-1);
      if (last && box.top <= last.bottom) last.bottom = Math.max(last.bottom, box.top + box.height);
      else intervals.push({ top: box.top, bottom: box.top + box.height });
    }
    const gutters = intervals.slice(1).flatMap((interval, index) => {
      const end = intervals[index]!.bottom;
      const above = substantial.filter((item) => item.box!.top + item.box!.height <= end);
      const below = substantial.filter((item) => item.box!.top >= interval.top);
      const paired = (items: typeof substantial) => items.some((a, i) => items.slice(i + 1).some((b) => sideBySide(a.box!, b.box!)));
      // A short paragraph gap is not a section boundary. Both sides must form substantial rows.
      return interval.top - end >= 0.04 && end - intervals[0]!.top >= 0.18
        && intervals.at(-1)!.bottom - interval.top >= 0.18 && paired(above) && paired(below)
        ? [{ end, start: interval.top }] : [];
    });
    const top = Math.min(...substantial.map((item) => item.top!));
    const bottom = Math.max(...substantial.map((item) => item.top! + item.box!.height));
    const barriers = geometry.filter((item) => item.spanning || (item.margin
      && !(gutters.length && item.box && (item.top! < top || item.top! >= bottom))));
    const bandOf = (item: typeof geometry[number]) => barriers.filter((barrier) => item.top !== undefined && barrier.top !== undefined
      ? barrier.top < item.top : barrier.index < item.index).length
      + gutters.filter((gutter) => item.top! >= gutter.start).length;
    const regions: Array<{ items: typeof geometry; box: LayoutBox; band: number; barrier: boolean }> = [];
    for (const item of [...substantial, ...barriers].sort((a, b) => a.index - b.index)) {
      const band = bandOf(item);
      const isBarrier = barriers.includes(item);
      const box = item.box;
      const region = !isBarrier && regions.find((candidate) => !candidate.barrier && candidate.band === band
        && horizontalOverlap(candidate.box, box!) / Math.min(candidate.box.width, box!.width) >= 0.6);
      if (region) {
        region.items.push(item);
        const left = Math.min(region.box.left, box!.left);
        const top = Math.min(region.box.top, box!.top);
        region.box = { left, top, width: Math.max(region.box.left + region.box.width, box!.left + box!.width) - left,
          height: Math.max(region.box.top + region.box.height, box!.top + box!.height) - top };
      } else {
        // Partial margin boxes still retain their finite Top or source-order position.
        regions.push({ items: [item], box: box ?? { left: 0, top: item.top ?? 0, width: 1, height: 0 }, band, barrier: isBarrier });
      }
    }
    for (const item of geometry.filter((entry) => !substantial.includes(entry) && !barriers.includes(entry))) {
      const box = item.box!;
      const gutter = gutters.find((gap) => box.top >= gap.end && box.top < gap.start);
      // Section headings and decorative icons in a gutter introduce the following band.
      const following = gutter && ["LAYOUT_TITLE", "LAYOUT_SECTION_HEADER", "LAYOUT_FIGURE"].includes(item.block.BlockType ?? "");
      const band = following ? bandOf({ ...item, top: gutter.start }) : bandOf(item);
      const candidates = regions.filter((region) => !region.barrier && (item.margin || region.band === band));
      const distance = (region: typeof regions[number]) => {
        const horizontal = Math.max(region.box.left - box.left - box.width, box.left - region.box.left - region.box.width, 0);
        const vertical = Math.max(region.box.top - box.top - box.height, box.top - region.box.top - region.box.height, 0);
        return horizontal * 4 + vertical;
      };
      const nearest = [...candidates].sort((a, b) => distance(a) - distance(b))[0];
      if (nearest) nearest.items.push(item);
      else regions.push({ items: [item], box, band, barrier: false });
    }
    regions.sort((a, b) => a.items.every((item) => item.top !== undefined) && b.items.every((item) => item.top !== undefined)
      ? a.box.top - b.box.top : a.items[0]!.index - b.items[0]!.index);
    const remaining = new Set(regions);
    const result: TextractReadingGroup[] = [];
    let rowIndex = 1;
    for (const seed of regions) {
      if (!remaining.delete(seed)) continue;
      const row = [seed];
      for (const candidate of remaining) {
        if (!seed.barrier && !candidate.barrier && candidate.band === seed.band
          && row.some((member) => sideBySide(member.box, candidate.box))
          && row.every((member) => horizontalOverlap(member.box, candidate.box) <= 0.01)) {
          row.push(candidate);
          remaining.delete(candidate);
        }
      }
      row.sort((a, b) => a.box.left - b.box.left);
      for (const region of row) result.push({ readingBlockId: `textract-${result.length + 1}`,
        ...(row.length > 1 ? { readingRowId: `textract-row-${rowIndex}` } : {}),
        blocks: region.items.sort((a, b) => a.top !== undefined && b.top !== undefined ? a.top - b.top || a.index - b.index : a.index - b.index).map((item) => item.block) });
      rowIndex += 1;
    }
    return pairTextractMargins(result);
  }
  const barriers = geometry.filter((item) => item.margin || item.spanning);
  // A transversal block separates vertical bands, including when AWS lists columns out of order.
  // Unknown barrier positions use source order rather than an invented Top=0.
  const bands = new Map(geometry.map((item) => [item.block, barriers.filter((barrier) => item.top !== undefined && barrier.top !== undefined ? barrier.top < item.top : barrier.index < item.index).length]));
  const groups: Array<TextractReadingGroup & { margin: boolean; band: number }> = [];
  for (const { block, margin: isMargin } of geometry) {
    const band = bands.get(block)!;
    const group = !isMargin && groups.find((candidate) => !candidate.margin && candidate.band === band);
    if (group) {
      group.blocks.push(block);
    } else {
      groups.push({ readingBlockId: `textract-${groups.length + 1}`, blocks: [block], margin: isMargin, band });
    }
  }
  return pairTextractMargins(groups.map(({ margin, band, ...group }) => group));
}

function pairTextractMargins(groups: TextractReadingGroup[]): TextractReadingGroup[] {
  return pairBottomMargins(groups, (group) => {
    if (group.blocks.length !== 1) return null;
    const block = group.blocks[0]!;
    const role = block.BlockType === "LAYOUT_FOOTER" ? "footer" : block.BlockType === "LAYOUT_PAGE_NUMBER" ? "pageNumber" : "body";
    return { role, box: normalizedGeometry(layoutBox(block))?.bbox ?? null };
  }, "textract");
}

export async function buildTextractPage(pageBuffer: Buffer, blocks: Block[], language: OcrLanguage = "es", marginHints?: OcrMarginHints): Promise<OcrPageResult> {
  const sourceMap = new Map(blocks.map((block) => [block.Id, block]));
  const body = blocks.filter((block) => ["LAYOUT_TEXT", "LAYOUT_LIST"].includes(block.BlockType ?? ""))
    .flatMap((block) => { const box = normalizedGeometry(layoutBox(block)); return box ? [box.bbox] : []; });
  const hintText = (block: Block, visited = new Set<Block>()): string[] => {
    if (visited.has(block)) return [];
    visited.add(block);
    if (block.BlockType === "LINE") return block.Text ? [block.Text] : [];
    const lines = (block.Relationships ?? []).filter((relation) => relation.Type === "CHILD")
      .flatMap((relation) => (relation.Ids ?? []).flatMap((id) => { const child = sourceMap.get(id); return child ? hintText(child, visited) : []; }));
    return lines.length ? lines : block.Text ? [block.Text] : [];
  };
  blocks = blocks.map((block): Block => {
    if (!["LAYOUT_TEXT", "LAYOUT_TITLE", "LAYOUT_SECTION_HEADER"].includes(block.BlockType ?? "")) return { ...block };
    const role = inferHintedMargin(joinLinesJoiningHyphens(hintText(block)), normalizedGeometry(layoutBox(block))?.bbox ?? null, body, marginHints);
    return { ...block, ...(role ? { BlockType: role === "header" ? "LAYOUT_HEADER" : "LAYOUT_FOOTER" } : {}) };
  });
  const map = new Map(blocks.map((block) => [block.Id, block]));
  const seen = new Set<Block>();
  const candidates: string[] = [];
  const paragraphMetadata: ParagraphElementMetadata[] = [];
  const embeddedImages = new Map<string, string>();
  let imageIndex = 1;
  const figures = blocks.filter((block) => block.BlockType === "LAYOUT_FIGURE").flatMap((block) => {
    const box = normalizedGeometry(layoutBox(block));
    return box ? [box.bbox] : [];
  });
  let sourceLines: Block[] = [];
  const textLines = (block: Block): string[] => {
    if (seen.has(block)) return [];
    seen.add(block);
    if (block.BlockType === "LINE") {
      if (block.Text) sourceLines.push(block);
      return block.Text ? [block.Text] : [];
    }
    const lines = (block.Relationships ?? []).filter((relation) => relation.Type === "CHILD").flatMap((relation) => (relation.Ids ?? []).flatMap((id) => {
      const child = map.get(id);
      return child ? textLines(child) : [];
    }));
    return lines.length ? lines : block.Text ? [block.Text] : [];
  };
  const sourceTextGeometry = (): Geometry | null => {
    const boxes = sourceLines.map((line) => normalizedGeometry(layoutBox(line)));
    if (boxes.length === 1) return boxes[0]!;
    if (!boxes.length || boxes.some((box) => box === null)) return null;
    const left = Math.min(...boxes.map((box) => box!.bbox.left));
    const top = Math.min(...boxes.map((box) => box!.bbox.top));
    return normalizedGeometry({ left, top,
      width: Math.max(...boxes.map((box) => box!.bbox.left + box!.bbox.width)) - left,
      height: Math.max(...boxes.map((box) => box!.bbox.top + box!.bbox.height)) - top });
  };
  for (const group of groupTextractLayoutBlocks(blocks)) {
    const content: string[] = [];
    for (const block of group.blocks) {
      const geometry = normalizedGeometry(layoutBox(block));
      if (block.BlockType === "LAYOUT_FIGURE") {
        const box = layoutBox(block);
        const source = box && await cropInlineImageFromBoundingBox(pageBuffer, { x: box.left * 1000, y: box.top * 1000, width: box.width * 1000, height: box.height * 1000 });
        if (source) {
          const token = `embedded-image-${imageIndex++}`;
          embeddedImages.set(token, source.source);
          content.push(`![](${token})`);
          paragraphMetadata.push(elementMetadata("image", source.geometry));
        }
      }
      sourceLines = [];
      const text = joinLinesJoiningHyphens(textLines(block));
      if (text) {
        let role: PageElementRole = block.BlockType === "LAYOUT_HEADER" ? "header"
          : block.BlockType === "LAYOUT_FOOTER" ? "footer"
          : block.BlockType === "LAYOUT_PAGE_NUMBER" ? "pageNumber"
          : ["LAYOUT_TITLE", "LAYOUT_SECTION_HEADER"].includes(block.BlockType ?? "") ? "heading"
          : block.BlockType === "LAYOUT_FIGURE" ? "imageCaption" : "body";
        let textGeometry = geometry ?? sourceTextGeometry();
        if (block.BlockType === "LAYOUT_FIGURE") {
          // CHILD text can lie outside the figure. Preserve its own box, never the image's.
          textGeometry = sourceTextGeometry();
        } else if (block.BlockType === "LAYOUT_TEXT" && geometry
          && figures.some((figure) => {
            const box = geometry.bbox;
            const overlap = Math.min(box.left + box.width, figure.left + figure.width) - Math.max(box.left, figure.left);
            const gap = Math.max(box.top - figure.top - figure.height, figure.top - box.top - box.height, 0);
            const labeled = /^(?:fig(?:ura|ure)?\.?|foto(?:graf[ií]a)?|imagen|ilustraci[oó]n|didascalia)\s*\d*\b/iu.test(text);
            const directlyBelow = figure.width >= 0.15 && figure.height >= 0.1 && box.top >= figure.top + figure.height
              && gap <= 0.025 && Math.abs(box.left - figure.left) <= 0.02
              && Math.abs(box.width - figure.width) <= 0.04 && box.height <= 0.06 && text.length <= 300;
            return overlap >= Math.min(box.width, figure.width) * 0.5 && gap <= 0.04 && box.height <= 0.1 && (labeled || directlyBelow);
          })) role = "imageCaption";
        const alignment = marginAlignment(role, textGeometry?.bbox ?? null);
        const editableText = role === "heading" ? `::center:: ## ${text}` : alignment ? `::${alignment}:: ${text}` : text;
        if (!buildRichPageFromParagraphs([editableText], { inferHeadings: false }).paragraphs.length) continue;
        content.push(editableText);
        paragraphMetadata.push(elementMetadata(role, textGeometry));
      }
    }
    if (content.length) candidates.push(`:::block ${group.readingBlockId}${group.readingRowId ? ` row=${group.readingRowId}` : ""}`, ...content);
  }
  if (!candidates.length) {
    sourceLines = blocks.filter((block) => block.BlockType === "LINE" && block.Text);
    const text = joinLinesJoiningHyphens(sourceLines.map((block) => block.Text ?? ""));
    if (text) {
      candidates.push(":::block textract-1", text);
      paragraphMetadata.push(elementMetadata("body", sourceTextGeometry()));
    }
  }
  return buildRichPageFromParagraphs(candidates, { embeddedImages, inferHeadings: false, languageCode: language, paragraphMetadata });
}

async function runTextractOcr(fileBuffer: Buffer, credentials?: AwsTextractCredentials | null, language: OcrLanguage = "es", marginHints?: OcrMarginHints): Promise<OcrPageResult> {
  ensureTextractConfiguration(credentials);

  const optimizedBuffer = await sharp(fileBuffer).flatten({ background: "#ffffff" }).jpeg({ quality: 80 }).toBuffer();

  const client = new TextractClient({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey
    }
  });

  const command = new AnalyzeDocumentCommand({
    Document: {
      Bytes: new Uint8Array(optimizedBuffer)
    },
    FeatureTypes: ["LAYOUT"]
  });

  const response = await client.send(command);
  return buildTextractPage(optimizedBuffer, response.Blocks ?? [], language, marginHints);
}

export function isSupportedImageUpload(fileName: string, mimeType: string): boolean {
  return supportedImageMimeTypes.has(inferImageMimeType(fileName, mimeType));
}

export async function runOcrOnImage(
  fileBuffer: Buffer,
  fileName: string,
  mimeType: string,
  options: RunOcrOnImageOptions = {}
): Promise<OcrPageResult> {
  const ocrMode = options.ocrMode ?? "AUTO";
  const awsCredentials = options.awsCredentials;
  const language = options.language ?? "es";
  const model = options.model ?? appEnv.opencodeOcrModel;
  const opencodeApiKey = options.opencodeApiKey ?? appEnv.opencodeGoApiKey;
  const rotation = options.rotation ?? 0;
  const promptOverride = options.promptOverride?.trim();
  const normalizedMimeType = inferImageMimeType(fileName, mimeType);
  if (!supportedImageMimeTypes.has(normalizedMimeType)) {
    throw Object.assign(new Error(`Formato de imagen no soportado para OCR: ${mimeType || fileName}. Usa PNG, JPG o WEBP.`), {
      statusCode: 415
    });
  }

  const rotatedBuffer = await applyImageRotation(fileBuffer, rotation);

  if (ocrMode === "LOCAL") {
    return runLocalOcrWithTesseract(rotatedBuffer, language);
  }

  if (ocrMode === "VISION") {
    ensureVisionOcrConfiguration(opencodeApiKey);
    return runVisionOcrWithOpenCode(rotatedBuffer, normalizedMimeType, language, model, promptOverride, opencodeApiKey, options.marginHints);
  }

  if (ocrMode === "TEXTRACT") {
    return runTextractOcr(rotatedBuffer, awsCredentials, language, options.marginHints);
  }

  try {
    return await runTextractOcr(rotatedBuffer, awsCredentials, language, options.marginHints);
  } catch (textractError) {
    if (hasVisionOcrConfiguration(opencodeApiKey)) {
      try {
        return await runVisionOcrWithOpenCode(rotatedBuffer, normalizedMimeType, language, model, promptOverride, opencodeApiKey, options.marginHints);
      } catch {
        // fall through to local
      }
    }

    try {
      return await runLocalOcrWithTesseract(rotatedBuffer, language);
    } catch (localOcrError) {
      throw Object.assign(new Error(`No se pudo extraer texto legible de la imagen ${fileName}. ${textractError instanceof Error ? textractError.message : ""}`.trim()), {
        statusCode: 422
      });
    }
  }
}
