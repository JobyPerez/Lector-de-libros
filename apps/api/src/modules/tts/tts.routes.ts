import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import {
  ALLOWED_DEEPGRAM_TTS_MODELS,
  appEnv,
  TTS_LANGUAGE_CATALOG,
  type TtsLanguageCode
} from "../../config/env.js";
import { requireBookRole } from "../../services/book-access.js";
import { normalizeTextForDeepgram } from "../../services/paragraph-metrics.js";
import { getUserAiCredentials, type UserAiCredentials } from "../../services/user-ai-credentials.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { resolveBookOutline } from "../books/book-outline.js";

type TtsParagraphRow = {
  bookId: string;
  cachedAudioBlob?: Buffer;
  cachedAudioFileId?: string | null;
  cachedAudioMimeType?: string | null;
  cachedTextChecksum?: string | null;
  legacyAudioBlob?: Buffer;
  legacyAudioFileId?: string | null;
  legacyAudioMimeType?: string | null;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

type BookTtsLanguageRow = {
  languageCode: string | null;
};

type TtsOfflineParagraphRow = Pick<TtsParagraphRow, "cachedTextChecksum" | "paragraphId" | "paragraphText" | "sequenceNumber">;

type TtsAiRequestRow = {
  bookId: string;
  cachedAudioBlob?: Buffer;
  cachedAudioFileId?: string | null;
  cachedAudioMimeType?: string | null;
  cachedTextChecksum?: string | null;
  requestId: string;
  requestKind: "TEXT" | "DIAGRAM";
  responseText: string;
};

function getAiRequestSpeechText(request: Pick<TtsAiRequestRow, "requestKind" | "responseText">) {
  if (request.requestKind !== "DIAGRAM") {
    return request.responseText;
  }

  try {
    const diagram = JSON.parse(request.responseText) as { summary?: unknown; title?: unknown };
    const title = typeof diagram.title === "string" ? diagram.title.trim() : "";
    const summary = typeof diagram.summary === "string" ? diagram.summary.trim() : "";
    return [title, summary].filter(Boolean).join(". ");
  } catch {
    return request.responseText;
  }
}

type DeepgramProjectInfo = {
  projectId: string;
  projectName: string;
};

const ttsRequestSchema = z.object({
  paragraphId: z.string().uuid(),
  voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
});

const DEFAULT_TTS_BLOCK_PARAGRAPH_COUNT = 5;
const MAX_TTS_BLOCK_PARAGRAPH_COUNT = 6;
const DEEPGRAM_TTS_MAX_ATTEMPTS = 3;
const DEEPGRAM_TTS_MAX_CHUNK_LENGTH = 650;
const DEEPGRAM_TTS_REQUEST_TIMEOUT_MS = 30_000;
const DEEPGRAM_TTS_BASE_RETRY_DELAY_MS = 300;
const DEEPGRAM_TTS_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const execFileAsync = promisify(execFile);

const ttsBlockRequestSchema = z.object({
  paragraphCount: z.coerce.number().int().min(1).max(MAX_TTS_BLOCK_PARAGRAPH_COUNT).default(DEFAULT_TTS_BLOCK_PARAGRAPH_COUNT),
  startSequenceNumber: z.coerce.number().int().min(1),
  voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
});

const sectionSummaryTtsParamsSchema = z.object({
  bookId: z.string().uuid(),
  chapterId: z.string().trim().min(1).max(200)
});

const offlineChapterAudioPlanParamsSchema = z.object({
  bookId: z.string().uuid(),
  chapterId: z.string().trim().min(1).max(200)
});

const offlineChapterAudioPlanQuerySchema = z.object({
  voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
});

const aiRequestTtsParamsSchema = z.object({
  bookId: z.string().uuid(),
  requestId: z.string().uuid()
});

export function normalizeTtsLanguageCode(languageCode: string | null | undefined): TtsLanguageCode {
  const normalizedLanguageCode = languageCode?.trim().toLowerCase().split(/[-_]/u)[0] || "es";
  const language = TTS_LANGUAGE_CATALOG.find((candidate) => candidate.languageCode === normalizedLanguageCode);

  if (!language) {
    throw Object.assign(new Error(`El idioma del libro (${languageCode || "sin especificar"}) no admite síntesis de voz.`), {
      statusCode: 422
    });
  }

  return language.languageCode;
}

function getPreferredTtsVoiceModel(credentials: UserAiCredentials, languageCode: TtsLanguageCode) {
  return languageCode === "it" ? credentials.deepgramTtsModelIt : credentials.deepgramTtsModel;
}

export function resolveTtsVoiceModel(
  bookLanguageCode: string | null | undefined,
  requestedVoiceModel: string | undefined,
  credentials: Pick<UserAiCredentials, "deepgramTtsModel" | "deepgramTtsModelIt">
) {
  const languageCode = normalizeTtsLanguageCode(bookLanguageCode);
  const voiceModel = requestedVoiceModel
    ?? (languageCode === "it" ? credentials.deepgramTtsModelIt : credentials.deepgramTtsModel);
  const language = TTS_LANGUAGE_CATALOG.find((candidate) => candidate.languageCode === languageCode);

  if (!language?.voices.some((voice) => voice.model === voiceModel)) {
    throw Object.assign(new Error(`La voz ${voiceModel} no es compatible con el idioma ${languageCode} del libro.`), {
      statusCode: 422
    });
  }

  return { languageCode, voiceModel };
}

async function fetchBookTtsLanguage(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string
) {
  const result = await connection.execute(
    `
      SELECT language_code AS "languageCode"
      FROM books
      WHERE book_id = :bookId
    `,
    { bookId }
  );
  const [book] = (result.rows ?? []) as BookTtsLanguageRow[];

  if (!book) {
    throw Object.assign(new Error("Book not found."), { statusCode: 404 });
  }

  return book.languageCode;
}

function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function computeTextChecksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function getParagraphTextChecksum(paragraphText: string) {
  return computeTextChecksum(normalizeTextForDeepgram(paragraphText));
}

function estimateDeepgramAura2CostUsd(characterCount: number) {
  return Number(((Math.max(characterCount, 0) / 1000) * 0.03).toFixed(4));
}

function encodeHeaderPayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNumericValue(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsedValue = Number(value);
    if (Number.isFinite(parsedValue)) {
      return parsedValue;
    }
  }

  return null;
}

function readStringProperty(candidate: unknown, propertyNames: string[]) {
  if (!isRecord(candidate)) {
    return null;
  }

  for (const propertyName of propertyNames) {
    const propertyValue = candidate[propertyName];
    if (typeof propertyValue === "string" && propertyValue.trim()) {
      return propertyValue.trim();
    }
  }

  return null;
}

function delay(durationMs: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function resolveAudioExtension(contentType: string) {
  switch (contentType) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/ogg":
      return "ogg";
    case "audio/webm":
      return "webm";
    default:
      return "bin";
  }
}

async function probeAudioDurationMs(audioBuffer: Buffer, contentType: string) {
  const extension = resolveAudioExtension(contentType);
  const tempFilePath = join(tmpdir(), `conejolector-tts-${randomUUID()}.${extension}`);

  try {
    await writeFile(tempFilePath, audioBuffer);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      tempFilePath
    ]);
    const durationSeconds = Number.parseFloat(stdout.trim());

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      return null;
    }

    return Math.round(durationSeconds * 1000);
  } catch {
    return null;
  } finally {
    await unlink(tempFilePath).catch(() => undefined);
  }
}

function splitLongTextForDeepgram(text: string): string[] {
  const normalizedText = normalizeTextForDeepgram(text);
  if (!normalizedText) {
    return [];
  }

  if (normalizedText.length <= DEEPGRAM_TTS_MAX_CHUNK_LENGTH) {
    return [normalizedText];
  }

  const chunks: string[] = [];
  let remainingText = normalizedText;

  while (remainingText.length > DEEPGRAM_TTS_MAX_CHUNK_LENGTH) {
    const candidate = remainingText.slice(0, DEEPGRAM_TTS_MAX_CHUNK_LENGTH + 1);
    const sentenceBoundary = Math.max(
      candidate.lastIndexOf(". "),
      candidate.lastIndexOf("? "),
      candidate.lastIndexOf("! "),
      candidate.lastIndexOf("; "),
      candidate.lastIndexOf(": "),
      candidate.lastIndexOf("\n")
    );
    const wordBoundary = candidate.lastIndexOf(" ");
    const splitIndex = sentenceBoundary >= Math.floor(DEEPGRAM_TTS_MAX_CHUNK_LENGTH * 0.55)
      ? sentenceBoundary + 1
      : wordBoundary >= Math.floor(DEEPGRAM_TTS_MAX_CHUNK_LENGTH * 0.75)
        ? wordBoundary
        : DEEPGRAM_TTS_MAX_CHUNK_LENGTH;
    const nextChunk = remainingText.slice(0, splitIndex).trim();

    if (!nextChunk) {
      break;
    }

    chunks.push(nextChunk);
    remainingText = remainingText.slice(splitIndex).trim();
  }

  if (remainingText) {
    chunks.push(remainingText);
  }

  return chunks;
}

function buildDeepgramError(
  message: string,
  options?: { isRetryable?: boolean; statusCode?: number; upstreamStatusCode?: number }
) {
  return Object.assign(new Error(message), {
    isRetryable: options?.isRetryable ?? false,
    statusCode: options?.statusCode ?? 502,
    upstreamStatusCode: options?.upstreamStatusCode
  });
}

function isRetryableDeepgramStatusCode(statusCode: number) {
  return DEEPGRAM_TTS_RETRYABLE_STATUS_CODES.has(statusCode);
}

function isRetryableDeepgramError(error: unknown) {
  return isRecord(error) && error.isRetryable === true;
}

function getCachedParagraphAudio(paragraph: TtsParagraphRow, voiceModel: string) {
  const textChecksum = getParagraphTextChecksum(paragraph.paragraphText);

  if (
    paragraph.cachedAudioBlob
    && paragraph.cachedAudioMimeType
    && paragraph.cachedTextChecksum === textChecksum
  ) {
    return {
      audioBuffer: paragraph.cachedAudioBlob,
      cacheSource: "voice-cache" as const,
      contentType: paragraph.cachedAudioMimeType,
      textChecksum
    };
  }

  return null;
}

async function fetchDeepgramJson(path: string, apiKey: string) {
  if (!apiKey) {
    throw Object.assign(new Error("Configura tu clave de Deepgram en tu perfil para usar este servicio."), {
      statusCode: 503
    });
  }

  const response = await fetch(`https://api.deepgram.com${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${apiKey}`
    },
    method: "GET"
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`Deepgram API error: ${responseBody}`), {
      statusCode: 502,
      upstreamStatusCode: response.status
    });
  }

  try {
    return responseBody ? JSON.parse(responseBody) as unknown : null;
  } catch {
    throw Object.assign(new Error(`Deepgram devolvió una respuesta JSON inválida al consultar ${path}.`), {
      statusCode: 502
    });
  }
}

function parseDeepgramProject(payload: unknown): DeepgramProjectInfo {
  const projectCandidates: unknown[] = [];

  if (Array.isArray(payload)) {
    projectCandidates.push(...payload);
  }

  if (isRecord(payload)) {
    if (Array.isArray(payload.projects)) {
      projectCandidates.push(...payload.projects);
    }

    if (Array.isArray(payload.data)) {
      projectCandidates.push(...payload.data);
    }

    if (Array.isArray(payload.result)) {
      projectCandidates.push(...payload.result);
    }

    if (isRecord(payload.project)) {
      projectCandidates.push(payload.project);
    }
  }

  for (const projectCandidate of projectCandidates) {
    const projectId = readStringProperty(projectCandidate, ["project_id", "projectId", "id"]);
    if (!projectId) {
      continue;
    }

    return {
      projectId,
      projectName: readStringProperty(projectCandidate, ["name", "project_name", "projectName"]) ?? projectId
    };
  }

  throw Object.assign(new Error("Deepgram no devolvió ningún proyecto disponible para esta cuenta."), {
    statusCode: 502
  });
}

function parseDeepgramBalanceUsd(payload: unknown): number | null {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const parsedBalance = parseDeepgramBalanceUsd(item);
      if (parsedBalance !== null) {
        return parsedBalance;
      }
    }

    return null;
  }

  if (!isRecord(payload)) {
    return null;
  }

  const directUsdBalance = parseNumericValue(payload.balance_usd ?? payload.balanceUsd);
  if (directUsdBalance !== null) {
    return directUsdBalance;
  }

  const normalizedCurrency = [payload.currency, payload.currencyCode, payload.unit, payload.units]
    .find((candidate) => typeof candidate === "string");
  const hasUsdCurrency = typeof normalizedCurrency === "string"
    ? normalizedCurrency.trim().toUpperCase() === "USD"
    : false;

  const directAmount = parseNumericValue(payload.amount);
  if (directAmount !== null && (hasUsdCurrency || normalizedCurrency === undefined)) {
    return directAmount;
  }

  const directBalance = parseNumericValue(payload.balance);
  if (directBalance !== null && (hasUsdCurrency || normalizedCurrency === undefined)) {
    return directBalance;
  }

  for (const nestedValue of Object.values(payload)) {
    const parsedBalance = parseDeepgramBalanceUsd(nestedValue);
    if (parsedBalance !== null) {
      return parsedBalance;
    }
  }

  return null;
}

async function fetchDeepgramProject(apiKey: string) {
  return parseDeepgramProject(await fetchDeepgramJson("/v1/projects", apiKey));
}

async function fetchDeepgramProjectBalanceUsd(projectId: string, apiKey: string) {
  const balancePaths = [
    `/v1/projects/${encodeURIComponent(projectId)}/balances`,
    `/v1/projects/${encodeURIComponent(projectId)}/balance`
  ];

  let lastError: unknown = null;

  for (const balancePath of balancePaths) {
    try {
      const parsedBalance = parseDeepgramBalanceUsd(await fetchDeepgramJson(balancePath, apiKey));
      if (parsedBalance !== null) {
        return parsedBalance;
      }

      lastError = Object.assign(new Error("Deepgram no devolvió un balance en USD reconocible para el proyecto."), {
        statusCode: 502
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? Object.assign(new Error("No se pudo consultar el balance de Deepgram."), {
    statusCode: 502
  });
}

function requireDeepgramApiKey(credentials: UserAiCredentials): string {
  if (!credentials.deepgramApiKey) {
    throw Object.assign(new Error("Configura tu clave de Deepgram en tu perfil para generar audio."), {
      statusCode: 503
    });
  }

  return credentials.deepgramApiKey;
}

async function synthesizeDeepgramTextChunk(text: string, voiceModel: string, apiKey: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
  const normalizedText = normalizeTextForDeepgram(text);
  if (!normalizedText) {
    throw Object.assign(new Error("El párrafo no contiene texto para sintetizar."), {
      statusCode: 422
    });
  }

  let lastError: unknown = null;

  for (let attempt = 1; attempt <= DEEPGRAM_TTS_MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, DEEPGRAM_TTS_REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceModel)}`, {
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text: normalizedText
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw buildDeepgramError(
          `Deepgram TTS error (${response.status}): ${errorBody}`,
          {
            isRetryable: isRetryableDeepgramStatusCode(response.status),
            statusCode: 502,
            upstreamStatusCode: response.status
          }
        );
      }

      const contentType = response.headers.get("content-type") ?? "audio/mpeg";
      const audioBuffer = Buffer.from(await response.arrayBuffer());

      return {
        audioBuffer,
        contentType
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        lastError = buildDeepgramError(
          `Deepgram TTS timeout tras ${DEEPGRAM_TTS_REQUEST_TIMEOUT_MS} ms.`,
          {
            isRetryable: true,
            statusCode: 504
          }
        );
      } else if (isRetryableDeepgramError(error)) {
        lastError = error;
      } else if (error instanceof Error && error.name === "TypeError") {
        lastError = buildDeepgramError(`No se pudo conectar con Deepgram: ${error.message}`, {
          isRetryable: true,
          statusCode: 502
        });
      } else {
        throw error;
      }
    } finally {
      clearTimeout(timeoutId);
    }

    if (!lastError || attempt >= DEEPGRAM_TTS_MAX_ATTEMPTS || !isRetryableDeepgramError(lastError)) {
      break;
    }

    await delay(DEEPGRAM_TTS_BASE_RETRY_DELAY_MS * attempt);
  }

  throw lastError ?? buildDeepgramError("No se pudo sintetizar el texto con Deepgram.");
}

async function synthesizeTextWithDeepgram(text: string, voiceModel: string, apiKey: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
  const chunks = splitLongTextForDeepgram(text);
  if (chunks.length === 0) {
    throw Object.assign(new Error("El párrafo no contiene texto para sintetizar."), {
      statusCode: 422
    });
  }

  if (chunks.length === 1) {
    const [singleChunk] = chunks;
    if (!singleChunk) {
      throw Object.assign(new Error("El párrafo no contiene texto para sintetizar."), {
        statusCode: 422
      });
    }

    return synthesizeDeepgramTextChunk(singleChunk, voiceModel, apiKey);
  }

  const synthesizedChunks = await Promise.all(chunks.map((chunk) => synthesizeDeepgramTextChunk(chunk, voiceModel, apiKey)));
  const contentType = synthesizedChunks[0]?.contentType ?? "audio/mpeg";

  if (synthesizedChunks.some((chunk) => chunk.contentType !== contentType)) {
    throw buildDeepgramError("Deepgram devolvió formatos de audio inconsistentes al sintetizar el párrafo.");
  }

  return {
    audioBuffer: Buffer.concat(synthesizedChunks.map((chunk) => chunk.audioBuffer)),
    contentType
  };
}

async function upsertParagraphAudioCacheEntry(
  connection: Awaited<ReturnType<typeof getConnection>>,
  paragraphId: string,
  voiceModel: string,
  textChecksumSha256: string,
  fileId: string
) {
  await connection.execute(
    `
      MERGE INTO book_paragraph_tts_audio_cache cache
      USING (
        SELECT
          :paragraphId AS paragraph_id,
          :voiceModel AS voice_model,
          :textChecksumSha256 AS text_checksum_sha256,
          :fileId AS file_id
        FROM dual
      ) incoming
      ON (
        cache.paragraph_id = incoming.paragraph_id
        AND cache.voice_model = incoming.voice_model
      )
      WHEN MATCHED THEN
        UPDATE SET
          cache.text_checksum_sha256 = incoming.text_checksum_sha256,
          cache.file_id = incoming.file_id,
          cache.updated_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
        INSERT (
          paragraph_id,
          voice_model,
          text_checksum_sha256,
          file_id
        )
        VALUES (
          incoming.paragraph_id,
          incoming.voice_model,
          incoming.text_checksum_sha256,
          incoming.file_id
        )
    `,
    {
      fileId,
      paragraphId,
      textChecksumSha256,
      voiceModel
    }
  );
}

async function persistParagraphAudioBuffer(
  connection: Awaited<ReturnType<typeof getConnection>>,
  paragraph: TtsParagraphRow,
  voiceModel: string,
  audioBuffer: Buffer,
  contentType: string,
  updateLegacyAudioFileId: boolean
) {
  const audioFileId = randomUUID();

  await connection.execute(
    `
      INSERT INTO book_files (
        file_id,
        book_id,
        file_kind,
        file_name,
        mime_type,
        paragraph_number,
        byte_size,
        checksum_sha256,
        content_blob
      ) VALUES (
        :fileId,
        :bookId,
        'TTS_AUDIO',
        :fileName,
        :mimeType,
        :paragraphNumber,
        :byteSize,
        :checksumSha256,
        :contentBlob
      )
    `,
    {
      bookId: paragraph.bookId,
      byteSize: audioBuffer.length,
      checksumSha256: computeChecksum(audioBuffer),
      contentBlob: audioBuffer,
      fileId: audioFileId,
      fileName: `paragraph-${paragraph.paragraphId}-${voiceModel}.mp3`,
      mimeType: contentType,
      paragraphNumber: paragraph.paragraphNumber
    }
  );

  await upsertParagraphAudioCacheEntry(
    connection,
    paragraph.paragraphId,
    voiceModel,
    getParagraphTextChecksum(paragraph.paragraphText),
    audioFileId
  );

  if (updateLegacyAudioFileId) {
    await connection.execute(
      `
        UPDATE book_paragraphs
        SET audio_file_id = :audioFileId
        WHERE book_id = :bookId
          AND paragraph_id = :paragraphId
      `,
      {
        audioFileId,
        bookId: paragraph.bookId,
        paragraphId: paragraph.paragraphId
      }
    );
  }

  return {
    audioBuffer,
    contentType
  };
}

async function persistAiRequestAudioBuffer(
  connection: Awaited<ReturnType<typeof getConnection>>,
  aiRequest: TtsAiRequestRow,
  voiceModel: string,
  audioBuffer: Buffer,
  contentType: string
) {
  const audioFileId = randomUUID();

  await connection.execute(
    `
      INSERT INTO book_files (
        file_id,
        book_id,
        file_kind,
        file_name,
        mime_type,
        byte_size,
        checksum_sha256,
        content_blob
      ) VALUES (
        :fileId,
        :bookId,
        'TTS_AUDIO',
        :fileName,
        :mimeType,
        :byteSize,
        :checksumSha256,
        :contentBlob
      )
    `,
    {
      bookId: aiRequest.bookId,
      byteSize: audioBuffer.length,
      checksumSha256: computeChecksum(audioBuffer),
      contentBlob: audioBuffer,
      fileId: audioFileId,
      fileName: `ai-request-${aiRequest.requestId}-${voiceModel}.mp3`,
      mimeType: contentType
    }
  );

  await connection.execute(
    `
      MERGE INTO user_book_ai_request_tts_audio_cache cache
      USING (
        SELECT
          :requestId AS request_id,
          :voiceModel AS voice_model,
          :textChecksumSha256 AS text_checksum_sha256,
          :fileId AS file_id
        FROM dual
      ) incoming
      ON (
        cache.request_id = incoming.request_id
        AND cache.voice_model = incoming.voice_model
      )
      WHEN MATCHED THEN
        UPDATE SET
          cache.text_checksum_sha256 = incoming.text_checksum_sha256,
          cache.file_id = incoming.file_id,
          cache.updated_at = SYSTIMESTAMP
      WHEN NOT MATCHED THEN
        INSERT (
          request_id,
          voice_model,
          text_checksum_sha256,
          file_id
        )
        VALUES (
          incoming.request_id,
          incoming.voice_model,
          incoming.text_checksum_sha256,
          incoming.file_id
        )
    `,
    {
      fileId: audioFileId,
      requestId: aiRequest.requestId,
      textChecksumSha256: computeTextChecksum(normalizeTextForDeepgram(aiRequest.responseText)),
      voiceModel
    }
  );

  if (aiRequest.cachedAudioFileId && aiRequest.cachedAudioFileId !== audioFileId) {
    await connection.execute(
      `
        DELETE FROM book_files
        WHERE file_id = :fileId
      `,
      {
        fileId: aiRequest.cachedAudioFileId
      }
    );
  }

  return {
    audioBuffer,
    contentType
  };
}

export const registerTtsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tts/config", async (_request, reply) => reply.send({
    defaults: {
      es: appEnv.deepgramTtsModel,
      it: appEnv.deepgramTtsModelIt
    },
    languages: TTS_LANGUAGE_CATALOG
  }));

  app.get("/tts/deepgram/balance", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const credentials = await getUserAiCredentials(request.currentUser.userId);
    const deepgramApiKey = requireDeepgramApiKey(credentials);
    const project = await fetchDeepgramProject(deepgramApiKey);
    const balanceUsd = await fetchDeepgramProjectBalanceUsd(project.projectId, deepgramApiKey);

    return reply.send({
      success: true,
      balance_usd: Number(balanceUsd.toFixed(2)),
      project_id: project.projectId,
      project_name: project.projectName
    });
  });

  app.get("/books/:bookId/sections/:chapterId/tts/offline-plan", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = offlineChapterAudioPlanParamsSchema.parse(request.params);
    const query = offlineChapterAudioPlanQuerySchema.parse(request.query);
    const connection = await getConnection();

    try {
      const credentials = await getUserAiCredentials(request.currentUser.userId, connection);
      const bookResult = await connection.execute(
        `
          SELECT
            title AS "title",
            language_code AS "languageCode"
          FROM books
          WHERE book_id = :bookId
        `,
        {
          bookId: params.bookId
        }
      );
      const [book] = (bookResult.rows ?? []) as Array<{ languageCode: string | null; title: string }>;
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }
      const { voiceModel: requestedVoiceModel } = resolveTtsVoiceModel(book.languageCode, query.voiceModel, credentials);

      const outline = await resolveBookOutline(connection, params.bookId);
      const sectionIndex = outline.findIndex((entry) => entry.chapterId === params.chapterId);
      if (sectionIndex < 0) {
        return reply.status(404).send({ message: "Section not found." });
      }

      const section = outline[sectionIndex];
      if (!section) {
        return reply.status(404).send({ message: "Section not found." });
      }
      const nextSection = outline.slice(sectionIndex + 1).find((entry) => entry.level <= section.level) ?? null;
      const result = await connection.execute(
        `
          SELECT
            bp.paragraph_id AS "paragraphId",
            bp.sequence_number AS "sequenceNumber",
            bp.paragraph_text AS "paragraphText",
            cache.text_checksum_sha256 AS "cachedTextChecksum"
          FROM book_paragraphs bp
          LEFT JOIN book_paragraph_tts_audio_cache cache
            ON cache.paragraph_id = bp.paragraph_id
            AND cache.voice_model = :voiceModel
          WHERE bp.book_id = :bookId
            AND bp.sequence_number >= :startSequenceNumber
            ${nextSection ? "AND bp.sequence_number < :endSequenceNumber" : ""}
          ORDER BY bp.sequence_number ASC
        `,
        {
          bookId: params.bookId,
          ...(nextSection ? { endSequenceNumber: nextSection.sequenceNumber } : {}),
          startSequenceNumber: section.sequenceNumber,
          voiceModel: requestedVoiceModel
        }
      );

      const paragraphs = (result.rows ?? []) as TtsOfflineParagraphRow[];
      const blocks: Array<{
        cachedCharacters: number;
        missingCharacters: number;
        paragraphCount: number;
        startSequenceNumber: number;
        totalCharacters: number;
      }> = [];
      let totalCharacters = 0;
      let cachedCharacters = 0;
      let missingCharacters = 0;

      for (let index = 0; index < paragraphs.length; index += MAX_TTS_BLOCK_PARAGRAPH_COUNT) {
        const blockParagraphs = paragraphs.slice(index, index + MAX_TTS_BLOCK_PARAGRAPH_COUNT);
        let blockTotalCharacters = 0;
        let blockCachedCharacters = 0;
        let blockMissingCharacters = 0;

        for (const paragraph of blockParagraphs) {
          const textLength = normalizeTextForDeepgram(paragraph.paragraphText).length;
          const isCached = paragraph.cachedTextChecksum === getParagraphTextChecksum(paragraph.paragraphText);

          blockTotalCharacters += textLength;
          if (isCached) {
            blockCachedCharacters += textLength;
          } else {
            blockMissingCharacters += textLength;
          }
        }

        const startSequenceNumber = blockParagraphs[0]?.sequenceNumber;
        if (startSequenceNumber !== undefined) {
          blocks.push({
            cachedCharacters: blockCachedCharacters,
            missingCharacters: blockMissingCharacters,
            paragraphCount: blockParagraphs.length,
            startSequenceNumber,
            totalCharacters: blockTotalCharacters
          });
        }

        totalCharacters += blockTotalCharacters;
        cachedCharacters += blockCachedCharacters;
        missingCharacters += blockMissingCharacters;
      }

      return reply.send({
        blocks,
        cachedCharacters,
        chapterId: params.chapterId,
        endSequenceNumber: paragraphs.at(-1)?.sequenceNumber ?? section.sequenceNumber,
        estimatedCostUsd: estimateDeepgramAura2CostUsd(missingCharacters),
        missingCharacters,
        startSequenceNumber: section.sequenceNumber,
        title: section.title,
        totalCharacters,
        voiceModel: requestedVoiceModel
      });
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/tts", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = ttsRequestSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const credentials = await getUserAiCredentials(request.currentUser.userId, connection);
      const bookLanguageCode = await fetchBookTtsLanguage(connection, params.bookId);
      const { languageCode, voiceModel: requestedVoiceModel } = resolveTtsVoiceModel(bookLanguageCode, payload.voiceModel, credentials);
      const deepgramApiKey = requireDeepgramApiKey(credentials);
      const result = await connection.execute(
        `
          SELECT
            bp.book_id AS "bookId",
            bp.page_number AS "pageNumber",
            bp.paragraph_id AS "paragraphId",
            bp.paragraph_number AS "paragraphNumber",
            bp.sequence_number AS "sequenceNumber",
            bp.paragraph_text AS "paragraphText",
            cache.file_id AS "cachedAudioFileId",
            cache.text_checksum_sha256 AS "cachedTextChecksum",
            cached_bf.mime_type AS "cachedAudioMimeType",
            cached_bf.content_blob AS "cachedAudioBlob",
            bp.audio_file_id AS "legacyAudioFileId",
            legacy_bf.mime_type AS "legacyAudioMimeType",
            legacy_bf.content_blob AS "legacyAudioBlob"
          FROM book_paragraphs bp
          JOIN books b
            ON b.book_id = bp.book_id
          LEFT JOIN book_paragraph_tts_audio_cache cache
            ON cache.paragraph_id = bp.paragraph_id
            AND cache.voice_model = :voiceModel
          LEFT JOIN book_files cached_bf
            ON cached_bf.file_id = cache.file_id
          LEFT JOIN book_files legacy_bf
            ON legacy_bf.file_id = bp.audio_file_id
          WHERE bp.book_id = :bookId
            AND bp.paragraph_id = :paragraphId
        `,
        {
          bookId: params.bookId,
          paragraphId: payload.paragraphId,
          voiceModel: requestedVoiceModel
        },
        {
          fetchInfo: {
            cachedAudioBlob: { type: oracledb.BUFFER },
            legacyAudioBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [paragraph] = (result.rows ?? []) as TtsParagraphRow[];
      if (!paragraph) {
        return reply.status(404).send({ message: "Paragraph not found." });
      }

      const cachedParagraphAudio = getCachedParagraphAudio(paragraph, requestedVoiceModel);
      let didMutateCache = false;
      let resolvedParagraphAudio: { audioBuffer: Buffer; contentType: string };

      if (cachedParagraphAudio) {
        resolvedParagraphAudio = {
          audioBuffer: cachedParagraphAudio.audioBuffer,
          contentType: cachedParagraphAudio.contentType
        };
      } else {
        const synthesizedAudio = await synthesizeTextWithDeepgram(paragraph.paragraphText, requestedVoiceModel, deepgramApiKey);
        resolvedParagraphAudio = await persistParagraphAudioBuffer(
          connection,
          paragraph,
          requestedVoiceModel,
          synthesizedAudio.audioBuffer,
          synthesizedAudio.contentType,
          requestedVoiceModel === getPreferredTtsVoiceModel(credentials, languageCode)
        );
      }

      if (!cachedParagraphAudio) {
        didMutateCache = true;
      }

      if (didMutateCache) {
        await connection.commit();
      }

      return reply
        .header("Content-Type", resolvedParagraphAudio.contentType)
        .header("Cache-Control", "private, max-age=31536000")
        .send(resolvedParagraphAudio.audioBuffer);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/tts/block", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = ttsBlockRequestSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const credentials = await getUserAiCredentials(request.currentUser.userId, connection);
      const bookLanguageCode = await fetchBookTtsLanguage(connection, params.bookId);
      const { languageCode, voiceModel: requestedVoiceModel } = resolveTtsVoiceModel(bookLanguageCode, payload.voiceModel, credentials);
      const deepgramApiKey = requireDeepgramApiKey(credentials);
      const result = await connection.execute(
        `
          SELECT
            bp.book_id AS "bookId",
            bp.page_number AS "pageNumber",
            bp.paragraph_id AS "paragraphId",
            bp.paragraph_number AS "paragraphNumber",
            bp.sequence_number AS "sequenceNumber",
            bp.paragraph_text AS "paragraphText",
            cache.file_id AS "cachedAudioFileId",
            cache.text_checksum_sha256 AS "cachedTextChecksum",
            cached_bf.mime_type AS "cachedAudioMimeType",
            cached_bf.content_blob AS "cachedAudioBlob",
            bp.audio_file_id AS "legacyAudioFileId",
            legacy_bf.mime_type AS "legacyAudioMimeType",
            legacy_bf.content_blob AS "legacyAudioBlob"
          FROM book_paragraphs bp
          JOIN books b
            ON b.book_id = bp.book_id
          LEFT JOIN book_paragraph_tts_audio_cache cache
            ON cache.paragraph_id = bp.paragraph_id
            AND cache.voice_model = :voiceModel
          LEFT JOIN book_files cached_bf
            ON cached_bf.file_id = cache.file_id
          LEFT JOIN book_files legacy_bf
            ON legacy_bf.file_id = bp.audio_file_id
          WHERE bp.book_id = :bookId
            AND bp.sequence_number BETWEEN :startSequenceNumber AND :endSequenceNumber
          ORDER BY bp.sequence_number ASC
        `,
        {
          bookId: params.bookId,
          endSequenceNumber: payload.startSequenceNumber + payload.paragraphCount - 1,
          startSequenceNumber: payload.startSequenceNumber,
          voiceModel: requestedVoiceModel
        },
        {
          fetchInfo: {
            cachedAudioBlob: { type: oracledb.BUFFER },
            legacyAudioBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const paragraphs = (result.rows ?? []) as TtsParagraphRow[];
      if (paragraphs.length === 0) {
        return reply.status(404).send({ message: "No se encontraron párrafos para este bloque." });
      }

      const resolvedParagraphs = await Promise.all(paragraphs.map(async (paragraph) => {
        const cachedParagraphAudio = getCachedParagraphAudio(paragraph, requestedVoiceModel);
        if (cachedParagraphAudio) {
          return {
            audioBuffer: cachedParagraphAudio.audioBuffer,
            cacheSource: cachedParagraphAudio.cacheSource,
            contentType: cachedParagraphAudio.contentType,
            didMutateCache: false,
            paragraph
          };
        }

        const synthesizedAudio = await synthesizeTextWithDeepgram(paragraph.paragraphText, requestedVoiceModel, deepgramApiKey);
        return {
          audioBuffer: synthesizedAudio.audioBuffer,
          cacheSource: null,
          contentType: synthesizedAudio.contentType,
          didMutateCache: true,
          paragraph
        };
      }));

      let contentType: string | null = null;
      let didMutateCache = false;
      const audioBuffers: Buffer[] = [];

      for (const resolvedParagraphAudio of resolvedParagraphs) {
        if (contentType && resolvedParagraphAudio.contentType !== contentType) {
          throw Object.assign(new Error("El bloque de audio usa formatos incompatibles entre párrafos."), {
            statusCode: 409
          });
        }

        if (resolvedParagraphAudio.didMutateCache) {
          await persistParagraphAudioBuffer(
            connection,
            resolvedParagraphAudio.paragraph,
            requestedVoiceModel,
            resolvedParagraphAudio.audioBuffer,
            resolvedParagraphAudio.contentType,
            requestedVoiceModel === getPreferredTtsVoiceModel(credentials, languageCode)
          );
        }

        contentType = contentType ?? resolvedParagraphAudio.contentType;
        didMutateCache ||= resolvedParagraphAudio.didMutateCache;
        audioBuffers.push(resolvedParagraphAudio.audioBuffer);
      }

      if (didMutateCache) {
        await connection.commit();
      }

      const paragraphDurationMs = await Promise.all(
        resolvedParagraphs.map(({ audioBuffer, contentType }) => probeAudioDurationMs(audioBuffer, contentType))
      );

      return reply
        .header("Content-Type", contentType ?? "audio/mpeg")
        .header("Cache-Control", "private, max-age=3600")
        .header(
          "X-Reader-Tts-Paragraphs",
          encodeHeaderPayload(
            resolvedParagraphs.map(({ audioBuffer, paragraph }, index) => ({
              audioByteLength: audioBuffer.length,
              durationMs: paragraphDurationMs[index] ?? undefined,
              pageNumber: paragraph.pageNumber,
              paragraphId: paragraph.paragraphId,
              paragraphNumber: paragraph.paragraphNumber,
              sequenceNumber: paragraph.sequenceNumber,
              textLength: paragraph.paragraphText.trim().length
            }))
          )
        )
        .send(Buffer.concat(audioBuffers));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/sections/:chapterId/summary/tts", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = sectionSummaryTtsParamsSchema.parse(request.params);
    const payload = z.object({
      voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
    }).parse(request.body);
    const connection = await getConnection();

    try {
      const credentials = await getUserAiCredentials(request.currentUser.userId, connection);
      const bookLanguageCode = await fetchBookTtsLanguage(connection, params.bookId);
      const { voiceModel: requestedVoiceModel } = resolveTtsVoiceModel(bookLanguageCode, payload.voiceModel, credentials);
      const deepgramApiKey = requireDeepgramApiKey(credentials);
      const result = await connection.execute(
        `
          SELECT
            uss.summary_text AS "summaryText"
          FROM user_book_section_summaries uss
          JOIN books b
            ON b.book_id = uss.book_id
          WHERE uss.book_id = :bookId
            AND uss.chapter_id = :chapterId
            AND uss.user_id = :userId
        `,
        {
          bookId: params.bookId,
          chapterId: params.chapterId,
          userId: request.currentUser.userId
        }
      );

      const [summary] = (result.rows ?? []) as Array<{ summaryText: string }>;
      if (!summary?.summaryText?.trim()) {
        return reply.status(404).send({ message: "Summary not found." });
      }

      const synthesizedAudio = await synthesizeTextWithDeepgram(summary.summaryText, requestedVoiceModel, deepgramApiKey);

      return reply
        .header("Content-Type", synthesizedAudio.contentType)
        .header("Cache-Control", "private, max-age=3600")
        .send(synthesizedAudio.audioBuffer);
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/ai-requests/:requestId/tts", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = aiRequestTtsParamsSchema.parse(request.params);
    const payload = z.object({
      voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
    }).parse(request.body);
    const connection = await getConnection();

    try {
      const credentials = await getUserAiCredentials(request.currentUser.userId, connection);
      const bookLanguageCode = await fetchBookTtsLanguage(connection, params.bookId);
      const { voiceModel: requestedVoiceModel } = resolveTtsVoiceModel(bookLanguageCode, payload.voiceModel, credentials);
      const result = await connection.execute(
        `
          SELECT
            ar.book_id AS "bookId",
            ar.request_id AS "requestId",
            ar.request_kind AS "requestKind",
            ar.response_text AS "responseText",
            cache.file_id AS "cachedAudioFileId",
            cache.text_checksum_sha256 AS "cachedTextChecksum",
            cached_bf.mime_type AS "cachedAudioMimeType",
            cached_bf.content_blob AS "cachedAudioBlob"
          FROM user_book_ai_requests ar
          JOIN books b
            ON b.book_id = ar.book_id
          LEFT JOIN user_book_ai_request_tts_audio_cache cache
            ON cache.request_id = ar.request_id
            AND cache.voice_model = :voiceModel
          LEFT JOIN book_files cached_bf
            ON cached_bf.file_id = cache.file_id
          WHERE ar.request_id = :requestId
            AND ar.book_id = :bookId
            AND (
              ar.user_id = :userId
              OR EXISTS (
                SELECT 1 FROM ai_request_shares ars
                WHERE ars.request_id = ar.request_id
                  AND ars.user_id = :userId
              )
            )
        `,
        {
          bookId: params.bookId,
          requestId: params.requestId,
          userId: request.currentUser.userId,
          voiceModel: requestedVoiceModel
        },
        {
          fetchInfo: {
            cachedAudioBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [aiRequest] = (result.rows ?? []) as TtsAiRequestRow[];
      if (!aiRequest?.responseText?.trim()) {
        return reply.status(404).send({ message: "AI request not found." });
      }

      const speechText = getAiRequestSpeechText(aiRequest);
      const textChecksum = computeTextChecksum(normalizeTextForDeepgram(speechText));
      const cachedAudio = aiRequest.cachedAudioBlob
        && aiRequest.cachedAudioMimeType
        && aiRequest.cachedTextChecksum === textChecksum
        ? {
            audioBuffer: aiRequest.cachedAudioBlob,
            contentType: aiRequest.cachedAudioMimeType
          }
        : null;
      let resolvedAudio = cachedAudio;

      if (!resolvedAudio) {
        const deepgramApiKey = requireDeepgramApiKey(credentials);
        const synthesizedAudio = await synthesizeTextWithDeepgram(speechText, requestedVoiceModel, deepgramApiKey);
        resolvedAudio = await persistAiRequestAudioBuffer(
          connection,
          aiRequest,
          requestedVoiceModel,
          synthesizedAudio.audioBuffer,
          synthesizedAudio.contentType
        );
        await connection.commit();
      }

      return reply
        .header("Content-Type", resolvedAudio.contentType)
        .header("Cache-Control", "private, max-age=31536000")
        .send(resolvedAudio.audioBuffer);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });
};
