import { createHash, randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { appEnv } from "../../config/env.js";
import { authenticateRequest } from "../auth/auth.routes.js";

type TtsParagraphRow = {
  audioBlob?: Buffer;
  audioFileId?: string | null;
  audioMimeType?: string | null;
  bookId: string;
  paragraphNumber: number;
  paragraphText: string;
};

const ttsRequestSchema = z.object({
  paragraphId: z.string().uuid(),
  voiceModel: z.string().regex(/^aura-2-[a-z]+-es$/).optional()
});

function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
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

export const registerTtsRoutes: FastifyPluginAsync = async (app) => {
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
            bp.paragraph_number AS "paragraphNumber",
            bp.paragraph_text AS "paragraphText",
            bf.file_id AS "audioFileId",
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

      if (canUseCachedAudio && paragraph.audioBlob && paragraph.audioMimeType) {
        return reply
          .header("Content-Type", paragraph.audioMimeType)
          .header("Cache-Control", "private, max-age=31536000")
          .send(paragraph.audioBlob);
      }

      const synthesizedAudio = await synthesizeTextWithDeepgram(paragraph.paragraphText, requestedVoiceModel);

      if (canUseCachedAudio) {
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
            fileName: `paragraph-${payload.paragraphId}.mp3`,
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
            bookId: params.bookId,
            paragraphId: payload.paragraphId
          }
        );

        await connection.commit();
      }

      return reply
        .header("Content-Type", synthesizedAudio.contentType)
        .header("Cache-Control", "private, max-age=31536000")
        .send(synthesizedAudio.audioBuffer);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });
};