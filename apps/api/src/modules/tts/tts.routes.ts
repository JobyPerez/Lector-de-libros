import { createHash, randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { ALLOWED_DEEPGRAM_TTS_MODELS, appEnv } from "../../config/env.js";
import { authenticateRequest } from "../auth/auth.routes.js";

type TtsParagraphRow = {
  audioBlob?: Buffer;
  audioMimeType?: string | null;
  bookId: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

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

const ttsBlockRequestSchema = z.object({
  paragraphCount: z.coerce.number().int().min(1).max(MAX_TTS_BLOCK_PARAGRAPH_COUNT).default(DEFAULT_TTS_BLOCK_PARAGRAPH_COUNT),
  startSequenceNumber: z.coerce.number().int().min(1),
  voiceModel: z.enum(ALLOWED_DEEPGRAM_TTS_MODELS).optional()
});

function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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

async function fetchDeepgramJson(path: string) {
  if (!appEnv.deepgramApiKey) {
    throw Object.assign(new Error("Deepgram no está configurado en el entorno."), {
      statusCode: 503
    });
  }

  const response = await fetch(`https://api.deepgram.com${path}`, {
    headers: {
      Accept: "application/json",
      Authorization: `Token ${appEnv.deepgramApiKey}`
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

async function fetchDeepgramProject() {
  return parseDeepgramProject(await fetchDeepgramJson("/v1/projects"));
}

async function fetchDeepgramProjectBalanceUsd(projectId: string) {
  const balancePaths = [
    `/v1/projects/${encodeURIComponent(projectId)}/balances`,
    `/v1/projects/${encodeURIComponent(projectId)}/balance`
  ];

  let lastError: unknown = null;

  for (const balancePath of balancePaths) {
    try {
      const parsedBalance = parseDeepgramBalanceUsd(await fetchDeepgramJson(balancePath));
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

async function synthesizeTextWithDeepgram(text: string, voiceModel: string): Promise<{ audioBuffer: Buffer; contentType: string }> {
  if (!appEnv.deepgramApiKey) {
    throw Object.assign(new Error("Deepgram no está configurado en el entorno."), {
      statusCode: 503
    });
  }

  const normalizedText = text.trim();
  if (!normalizedText) {
    throw Object.assign(new Error("El párrafo no contiene texto para sintetizar."), {
      statusCode: 422
    });
  }

  const response = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voiceModel)}`, {
    method: "POST",
    headers: {
      Authorization: `Token ${appEnv.deepgramApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: normalizedText.slice(0, 2000)
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw Object.assign(new Error(`Deepgram TTS error: ${errorBody}`), {
      statusCode: 502
    });
  }

  const contentType = response.headers.get("content-type") ?? "audio/mpeg";
  const audioBuffer = Buffer.from(await response.arrayBuffer());

  return {
    audioBuffer,
    contentType
  };
}

async function resolveParagraphAudioBuffer(
  connection: Awaited<ReturnType<typeof getConnection>>,
  paragraph: TtsParagraphRow,
  voiceModel: string,
  canUseCachedAudio: boolean
) {
  if (canUseCachedAudio && paragraph.audioBlob && paragraph.audioMimeType) {
    return {
      audioBuffer: paragraph.audioBlob,
      contentType: paragraph.audioMimeType,
      didMutateCache: false
    };
  }

  const synthesizedAudio = await synthesizeTextWithDeepgram(paragraph.paragraphText, voiceModel);

  if (!canUseCachedAudio) {
    return {
      audioBuffer: synthesizedAudio.audioBuffer,
      contentType: synthesizedAudio.contentType,
      didMutateCache: false
    };
  }

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
      byteSize: synthesizedAudio.audioBuffer.length,
      checksumSha256: computeChecksum(synthesizedAudio.audioBuffer),
      contentBlob: synthesizedAudio.audioBuffer,
      fileId: audioFileId,
      fileName: `paragraph-${paragraph.paragraphId}.mp3`,
      mimeType: synthesizedAudio.contentType,
      paragraphNumber: paragraph.paragraphNumber
    }
  );

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

  return {
    audioBuffer: synthesizedAudio.audioBuffer,
    contentType: synthesizedAudio.contentType,
    didMutateCache: true
  };
}

async function persistParagraphAudioBuffer(
  connection: Awaited<ReturnType<typeof getConnection>>,
  paragraph: TtsParagraphRow,
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
      fileName: `paragraph-${paragraph.paragraphId}.mp3`,
      mimeType: contentType,
      paragraphNumber: paragraph.paragraphNumber
    }
  );

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

export const registerTtsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/tts/deepgram/balance", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const project = await fetchDeepgramProject();
    const balanceUsd = await fetchDeepgramProjectBalanceUsd(project.projectId);

    return reply.send({
      success: true,
      balance_usd: Number(balanceUsd.toFixed(2)),
      project_id: project.projectId,
      project_name: project.projectName
    });
  });

  app.post("/books/:bookId/tts", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = ttsRequestSchema.parse(request.body);
    const requestedVoiceModel = payload.voiceModel ?? appEnv.deepgramTtsModel;
    const canUseCachedAudio = requestedVoiceModel === appEnv.deepgramTtsModel;
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            bp.book_id AS "bookId",
            bp.page_number AS "pageNumber",
            bp.paragraph_id AS "paragraphId",
            bp.paragraph_number AS "paragraphNumber",
            bp.sequence_number AS "sequenceNumber",
            bp.paragraph_text AS "paragraphText",
            bf.mime_type AS "audioMimeType",
            bf.content_blob AS "audioBlob"
          FROM book_paragraphs bp
          JOIN books b
            ON b.book_id = bp.book_id
          LEFT JOIN book_files bf
            ON bf.file_id = bp.audio_file_id
          WHERE bp.book_id = :bookId
            AND bp.paragraph_id = :paragraphId
            AND b.owner_user_id = :ownerUserId
        `,
        {
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId,
          paragraphId: payload.paragraphId
        },
        {
          fetchInfo: {
            audioBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [paragraph] = (result.rows ?? []) as TtsParagraphRow[];
      if (!paragraph) {
        return reply.status(404).send({ message: "Paragraph not found." });
      }

      const resolvedParagraphAudio = await resolveParagraphAudioBuffer(connection, paragraph, requestedVoiceModel, canUseCachedAudio);
      if (resolvedParagraphAudio.didMutateCache) {
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

  app.post("/books/:bookId/tts/block", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = ttsBlockRequestSchema.parse(request.body);
    const requestedVoiceModel = payload.voiceModel ?? appEnv.deepgramTtsModel;
    const canUseCachedAudio = requestedVoiceModel === appEnv.deepgramTtsModel;
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            bp.book_id AS "bookId",
            bp.page_number AS "pageNumber",
            bp.paragraph_id AS "paragraphId",
            bp.paragraph_number AS "paragraphNumber",
            bp.sequence_number AS "sequenceNumber",
            bp.paragraph_text AS "paragraphText",
            bf.mime_type AS "audioMimeType",
            bf.content_blob AS "audioBlob"
          FROM book_paragraphs bp
          JOIN books b
            ON b.book_id = bp.book_id
          LEFT JOIN book_files bf
            ON bf.file_id = bp.audio_file_id
          WHERE bp.book_id = :bookId
            AND bp.sequence_number BETWEEN :startSequenceNumber AND :endSequenceNumber
            AND b.owner_user_id = :ownerUserId
          ORDER BY bp.sequence_number ASC
        `,
        {
          bookId: params.bookId,
          endSequenceNumber: payload.startSequenceNumber + payload.paragraphCount - 1,
          ownerUserId: request.currentUser.userId,
          startSequenceNumber: payload.startSequenceNumber
        },
        {
          fetchInfo: {
            audioBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const paragraphs = (result.rows ?? []) as TtsParagraphRow[];
      if (paragraphs.length === 0) {
        return reply.status(404).send({ message: "No se encontraron párrafos para este bloque." });
      }

      const resolvedParagraphs = await Promise.all(paragraphs.map(async (paragraph) => {
        if (canUseCachedAudio && paragraph.audioBlob && paragraph.audioMimeType) {
          return {
            audioBuffer: paragraph.audioBlob,
            contentType: paragraph.audioMimeType,
            didMutateCache: false,
            paragraph
          };
        }

        const synthesizedAudio = await synthesizeTextWithDeepgram(paragraph.paragraphText, requestedVoiceModel);
        return {
          audioBuffer: synthesizedAudio.audioBuffer,
          contentType: synthesizedAudio.contentType,
          didMutateCache: canUseCachedAudio,
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
            resolvedParagraphAudio.audioBuffer,
            resolvedParagraphAudio.contentType
          );
        }

        contentType = contentType ?? resolvedParagraphAudio.contentType;
        didMutateCache ||= resolvedParagraphAudio.didMutateCache;
        audioBuffers.push(resolvedParagraphAudio.audioBuffer);
      }

      if (didMutateCache) {
        await connection.commit();
      }

      return reply
        .header("Content-Type", contentType ?? "audio/mpeg")
        .header("Cache-Control", "private, max-age=3600")
        .header(
          "X-Reader-Tts-Paragraphs",
          encodeHeaderPayload(
            resolvedParagraphs.map(({ paragraph }) => ({
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
};