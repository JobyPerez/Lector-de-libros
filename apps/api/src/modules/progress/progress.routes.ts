import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { requireBookRole } from "../../services/book-access.js";
import { recordListeningActivity } from "../../services/user-activity.js";
import { authenticateRequest } from "../auth/auth.routes.js";

const progressSchema = z.object({
  audioOffsetMs: z.number().int().min(0).default(0),
  currentPageNumber: z.number().int().min(1),
  currentParagraphNumber: z.number().int().min(1),
  currentSequenceNumber: z.number().int().min(1),
  readingPercentage: z.number().min(0).max(100).default(0)
});

const listeningHeartbeatSchema = z.object({
  activeSeconds: z.number().int().min(1).max(60),
  chapterTitle: z.string().trim().max(500).nullish(),
  sessionId: z.string().uuid()
});

export const registerProgressRoutes: FastifyPluginAsync = async (app) => {
  app.post("/books/:bookId/listening-heartbeat", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = listeningHeartbeatSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const bookResult = await connection.execute(
        `
          SELECT title AS "title"
          FROM books
          WHERE book_id = :bookId
        `,
        { bookId: params.bookId }
      );
      const [bookRow] = (bookResult.rows ?? []) as Array<{ title?: string }>;
      const bookTitle = bookRow?.title ?? "Libro";

      await connection.execute(
        `
          MERGE INTO user_reading_sessions target
          USING (SELECT :sessionId AS session_id FROM dual) source
          ON (target.session_id = source.session_id)
          WHEN MATCHED THEN UPDATE SET
            duration_seconds = target.duration_seconds + :activeSeconds,
            last_activity_at = SYSTIMESTAMP
            WHERE target.user_id = :userId AND target.book_id = :bookId
          WHEN NOT MATCHED THEN INSERT (
            session_id,
            user_id,
            book_id,
            duration_seconds
          ) VALUES (
            :sessionId,
            :userId,
            :bookId,
            :activeSeconds
          )
        `,
        {
          activeSeconds: payload.activeSeconds,
          bookId: params.bookId,
          sessionId: payload.sessionId,
          userId: request.currentUser.userId
        }
      );

      await recordListeningActivity(connection, {
        activeSeconds: payload.activeSeconds,
        bookId: params.bookId,
        bookTitle,
        chapterTitle: payload.chapterTitle ?? null,
        sessionId: payload.sessionId,
        userId: request.currentUser.userId
      });

      await connection.commit();

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });

  app.get("/books/:bookId/progress", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            progress_id AS "progressId",
            current_page_number AS "currentPageNumber",
            current_paragraph_number AS "currentParagraphNumber",
            current_sequence_number AS "currentSequenceNumber",
            audio_offset_ms AS "audioOffsetMs",
            reading_percentage AS "readingPercentage",
            last_opened_at AS "lastOpenedAt",
            updated_at AS "updatedAt"
          FROM user_book_progress
          WHERE user_id = :userId
            AND book_id = :bookId
        `,
        {
          bookId: params.bookId,
          userId: request.currentUser.userId
        }
      );

      const [progress] = (result.rows ?? []) as Array<Record<string, unknown>>;
      return reply.send({ progress: progress ?? null });
    } finally {
      await connection.close();
    }
  });

  app.put("/books/:bookId/progress", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const payload = progressSchema.parse(request.body);
    const connection = await getConnection();
    const progressId = randomUUID();

    try {
      await connection.execute(
        `
          MERGE INTO user_book_progress target
          USING (
            SELECT :userId AS user_id, :bookId AS book_id FROM dual
          ) source
          ON (target.user_id = source.user_id AND target.book_id = source.book_id)
          WHEN MATCHED THEN UPDATE SET
            current_page_number = :currentPageNumber,
            current_paragraph_number = :currentParagraphNumber,
            current_sequence_number = :currentSequenceNumber,
            audio_offset_ms = :audioOffsetMs,
            reading_percentage = :readingPercentage,
            last_opened_at = SYSTIMESTAMP,
            updated_at = SYSTIMESTAMP
          WHEN NOT MATCHED THEN INSERT (
            progress_id,
            user_id,
            book_id,
            current_page_number,
            current_paragraph_number,
            current_sequence_number,
            audio_offset_ms,
            reading_percentage,
            last_opened_at,
            updated_at
          ) VALUES (
            :progressId,
            :userId,
            :bookId,
            :currentPageNumber,
            :currentParagraphNumber,
            :currentSequenceNumber,
            :audioOffsetMs,
            :readingPercentage,
            SYSTIMESTAMP,
            SYSTIMESTAMP
          )
        `,
        {
          audioOffsetMs: payload.audioOffsetMs,
          bookId: params.bookId,
          currentPageNumber: payload.currentPageNumber,
          currentParagraphNumber: payload.currentParagraphNumber,
          currentSequenceNumber: payload.currentSequenceNumber,
          progressId,
          readingPercentage: payload.readingPercentage,
          userId: request.currentUser.userId
        },
        {
          autoCommit: true
        }
      );

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });
};
