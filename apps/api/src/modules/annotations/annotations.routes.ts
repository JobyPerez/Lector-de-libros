import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { requireBookRole } from "../../services/book-access.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { resolveBookOutlineWithSource } from "../books/book-outline.js";

const highlightColors = ["YELLOW", "GREEN", "BLUE", "PINK"] as const;

const bookParamsSchema = z.object({
  bookId: z.string().uuid()
});

const bookmarkParamsSchema = z.object({
  bookId: z.string().uuid(),
  bookmarkId: z.string().uuid()
});

const highlightParamsSchema = z.object({
  bookId: z.string().uuid(),
  highlightId: z.string().uuid()
});

const noteParamsSchema = z.object({
  bookId: z.string().uuid(),
  noteId: z.string().uuid()
});

const annotationsQuerySchema = z.object({
  pageNumber: z.coerce.number().int().min(1)
});

const sharedWithSchema = z.array(z.string().uuid()).max(200).default([]);

const createBookmarkSchema = z.object({
  paragraphId: z.string().uuid(),
  sharedWithUserIds: sharedWithSchema.optional()
});

const createHighlightSchema = z.object({
  charEnd: z.number().int().min(1),
  charStart: z.number().int().min(0),
  color: z.enum(highlightColors),
  highlightedText: z.string().trim().min(1).max(4000),
  paragraphId: z.string().uuid(),
  sharedWithUserIds: sharedWithSchema.optional()
});

const createNoteSchema = z.object({
  highlightId: z.string().uuid().optional(),
  noteText: z.string().trim().min(1).max(4000),
  pageNumber: z.number().int().min(1).optional(),
  paragraphId: z.string().uuid().optional(),
  sharedWithUserIds: sharedWithSchema.optional()
});

const updateNoteSchema = z.object({
  highlightColor: z.enum(highlightColors).optional(),
  noteText: z.string().trim().min(1).max(4000).optional(),
  sharedWithUserIds: sharedWithSchema.optional()
});

type OwnedBookRecord = {
  bookId: string;
  sourceType: "PDF" | "EPUB" | "IMAGES";
  totalPages: number;
};

type ParagraphLocationRecord = {
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

type BookmarkRecord = {
  bookmarkId: string;
  createdAt: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  userDisplayName?: string | null;
  userId?: string;
  username?: string;
};

type HighlightRecord = {
  charEnd: number;
  charStart: number;
  color: typeof highlightColors[number];
  createdAt: string;
  highlightId: string;
  highlightedText: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  updatedAt: string;
  userDisplayName?: string | null;
  userId?: string;
  username?: string;
};

type NoteRecord = {
  createdAt: string;
  highlightCharEnd: number | null;
  highlightCharStart: number | null;
  highlightColor: typeof highlightColors[number] | null;
  highlightId: string | null;
  highlightedText: string | null;
  noteId: string;
  noteText: string;
  pageNumber: number;
  paragraphId: string | null;
  paragraphNumber: number | null;
  sequenceNumber: number | null;
  sharedWithUserIds?: string[];
  updatedAt: string;
  userDisplayName?: string | null;
  userId?: string;
  username?: string;
};

type OwnedNoteRecord = {
  highlightId: string | null;
  noteId: string;
};

async function insertAnnotationShares(
  connection: Awaited<ReturnType<typeof getConnection>>,
  annotationId: string,
  annotationType: "bookmark" | "note",
  bookId: string,
  sharedWithUserIds: string[]
): Promise<void> {
  if (sharedWithUserIds.length === 0) {
    return;
  }

  const dedup = Array.from(new Set(sharedWithUserIds));
  const placeholders = dedup.map((_, index) => `:u${index}`).join(",");
  const bind = Object.fromEntries(dedup.map((id, index) => [`u${index}`, id]));

  const accessCheck = await connection.execute(
    `SELECT user_id AS "userId"
       FROM book_shares
      WHERE book_id = :bookId
        AND user_id IN (${placeholders})`,
    { bookId, ...bind }
  );
  const allowed = (accessCheck.rows ?? []).map((row: unknown) => (row as { userId: string }).userId);
  if (allowed.length === 0) {
    return;
  }

  await connection.execute(
    `INSERT INTO annotation_shares (annotation_id, annotation_type, user_id)
     VALUES ${allowed.map(() => "(?, ?, ?)").join(", ")}`,
    allowed.flatMap((userId: string) => [annotationId, annotationType, userId]),
    { autoCommit: true }
  );
}

async function findAccessibleBook(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, userId: string): Promise<OwnedBookRecord & { shareUserAnnotations: boolean } | null> {
  const result = await connection.execute(
    `
      SELECT
        b.book_id AS "bookId",
        b.source_type AS "sourceType",
        b.total_pages AS "totalPages",
        b.share_user_annotations AS "shareUserAnnotations"
      FROM books b
      LEFT JOIN book_shares s
        ON s.book_id = b.book_id
       AND s.user_id = :userId
      WHERE b.book_id = :bookId
        AND (b.owner_user_id = :userId OR s.user_id = :userId)
    `,
    { bookId, userId }
  );

  const [book] = (result.rows ?? []) as Array<OwnedBookRecord & { shareUserAnnotations: string }>;
  if (!book) return null;
  return { ...book, shareUserAnnotations: book.shareUserAnnotations === "Y" };
}

async function findParagraphLocation(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  paragraphId: string
): Promise<ParagraphLocationRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        paragraph_id AS "paragraphId",
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        paragraph_text AS "paragraphText"
      FROM book_paragraphs
      WHERE book_id = :bookId
        AND paragraph_id = :paragraphId
    `,
    {
      bookId,
      paragraphId
    }
  );

  const [paragraph] = (result.rows ?? []) as ParagraphLocationRecord[];
  return paragraph ?? null;
}

async function findOwnedHighlight(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  highlightId: string,
  userId: string
): Promise<HighlightRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        highlight_id AS "highlightId",
        paragraph_id AS "paragraphId",
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        color AS "color",
        char_start AS "charStart",
        char_end AS "charEnd",
        highlighted_text AS "highlightedText",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_highlights
      WHERE book_id = :bookId
        AND highlight_id = :highlightId
        AND user_id = :userId
    `,
    {
      bookId,
      highlightId,
      userId
    }
  );

  const [highlight] = (result.rows ?? []) as HighlightRecord[];
  return highlight ?? null;
}

async function findOwnedNote(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  noteId: string,
  userId: string
): Promise<OwnedNoteRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        note_id AS "noteId",
        highlight_id AS "highlightId"
      FROM user_notes
      WHERE book_id = :bookId
        AND note_id = :noteId
        AND user_id = :userId
    `,
    {
      bookId,
      noteId,
      userId
    }
  );

  const [note] = (result.rows ?? []) as OwnedNoteRecord[];
  return note ?? null;
}

async function countHighlightNotes(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  highlightId: string,
  userId: string
): Promise<number> {
  const result = await connection.execute(
    `
      SELECT COUNT(*) AS "noteCount"
      FROM user_notes
      WHERE book_id = :bookId
        AND highlight_id = :highlightId
        AND user_id = :userId
    `,
    {
      bookId,
      highlightId,
      userId
    }
  );

  const [row] = (result.rows ?? []) as Array<{ noteCount: number }>;
  return row?.noteCount ?? 0;
}

async function listBookmarks(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber?: number
): Promise<BookmarkRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        bookmark_id AS "bookmarkId",
        paragraph_id AS "paragraphId",
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        created_at AS "createdAt"
      FROM user_bookmarks
      WHERE user_id = :userId
        AND book_id = :bookId
        AND (:pageNumber IS NULL OR page_number = :pageNumber)
      ORDER BY page_number ASC, paragraph_number ASC, created_at ASC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      userId
    }
  );

  return (result.rows ?? []) as BookmarkRecord[];
}

async function listBookmarksShared(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber: number | undefined,
  shareUserAnnotations: boolean
): Promise<BookmarkRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        b.bookmark_id AS "bookmarkId",
        b.paragraph_id AS "paragraphId",
        b.page_number AS "pageNumber",
        b.paragraph_number AS "paragraphNumber",
        b.sequence_number AS "sequenceNumber",
        b.created_at AS "createdAt",
        b.user_id AS "userId",
        u.username AS "username",
        u.display_name AS "userDisplayName",
        (SELECT COUNT(*) FROM annotation_shares s
          WHERE s.annotation_id = b.bookmark_id
            AND s.annotation_type = 'bookmark') AS "shareCount"
      FROM user_bookmarks b
      JOIN users u ON u.user_id = b.user_id
      WHERE b.book_id = :bookId
        AND (:pageNumber IS NULL OR b.page_number = :pageNumber)
        AND (
          b.user_id = :userId
          OR EXISTS (
            SELECT 1 FROM annotation_shares s
             WHERE s.annotation_id = b.bookmark_id
               AND s.annotation_type = 'bookmark'
               AND s.user_id = :userId
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM book_shares bs
               WHERE bs.book_id = :bookId
                 AND bs.user_id = :userId
            )
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM books bk
               WHERE bk.book_id = :bookId
                 AND bk.owner_user_id = :userId
            )
          )
        )
      ORDER BY b.page_number ASC, b.paragraph_number ASC, b.created_at ASC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      shareAll: shareUserAnnotations ? 1 : 0,
      userId
    }
  );

  return (result.rows ?? []) as BookmarkRecord[];
}

async function listHighlights(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber?: number
): Promise<HighlightRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        highlight_id AS "highlightId",
        paragraph_id AS "paragraphId",
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        color AS "color",
        char_start AS "charStart",
        char_end AS "charEnd",
        highlighted_text AS "highlightedText",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_highlights
      WHERE user_id = :userId
        AND book_id = :bookId
        AND (:pageNumber IS NULL OR page_number = :pageNumber)
      ORDER BY paragraph_number ASC, char_start ASC, created_at ASC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      userId
    }
  );

  return (result.rows ?? []) as HighlightRecord[];
}

async function listHighlightsShared(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber: number | undefined,
  shareUserAnnotations: boolean
): Promise<HighlightRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        h.highlight_id AS "highlightId",
        h.paragraph_id AS "paragraphId",
        h.page_number AS "pageNumber",
        h.paragraph_number AS "paragraphNumber",
        h.sequence_number AS "sequenceNumber",
        h.color AS "color",
        h.char_start AS "charStart",
        h.char_end AS "charEnd",
        h.highlighted_text AS "highlightedText",
        h.created_at AS "createdAt",
        h.updated_at AS "updatedAt",
        h.user_id AS "userId",
        u.username AS "username",
        u.display_name AS "userDisplayName"
      FROM user_highlights h
      JOIN users u ON u.user_id = h.user_id
      WHERE h.book_id = :bookId
        AND (:pageNumber IS NULL OR h.page_number = :pageNumber)
        AND (
          h.user_id = :userId
          OR EXISTS (
            SELECT 1 FROM annotation_shares s
             WHERE s.annotation_id = h.highlight_id
               AND s.annotation_type = 'bookmark'
               AND s.user_id = :userId
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM book_shares bs
               WHERE bs.book_id = :bookId
                 AND bs.user_id = :userId
            )
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM books bk
               WHERE bk.book_id = :bookId
                 AND bk.owner_user_id = :userId
            )
          )
        )
      ORDER BY h.paragraph_number ASC, h.char_start ASC, h.created_at ASC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      shareAll: shareUserAnnotations ? 1 : 0,
      userId
    }
  );

  return (result.rows ?? []) as HighlightRecord[];
}

async function listNotes(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber?: number
): Promise<NoteRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        n.note_id AS "noteId",
        n.page_number AS "pageNumber",
        n.paragraph_id AS "paragraphId",
        n.paragraph_number AS "paragraphNumber",
        n.sequence_number AS "sequenceNumber",
        n.highlight_id AS "highlightId",
        n.note_text AS "noteText",
        n.created_at AS "createdAt",
        n.updated_at AS "updatedAt",
        h.color AS "highlightColor",
        h.char_start AS "highlightCharStart",
        h.char_end AS "highlightCharEnd",
        h.highlighted_text AS "highlightedText"
      FROM user_notes n
      LEFT JOIN user_highlights h
        ON h.highlight_id = n.highlight_id
      WHERE n.user_id = :userId
        AND n.book_id = :bookId
        AND (:pageNumber IS NULL OR n.page_number = :pageNumber)
      ORDER BY n.page_number ASC, n.paragraph_number ASC NULLS LAST, n.updated_at DESC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      userId
    }
  );

  return (result.rows ?? []) as NoteRecord[];
}

async function listNotesShared(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber: number | undefined,
  shareUserAnnotations: boolean
): Promise<NoteRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        n.note_id AS "noteId",
        n.page_number AS "pageNumber",
        n.paragraph_id AS "paragraphId",
        n.paragraph_number AS "paragraphNumber",
        n.sequence_number AS "sequenceNumber",
        n.highlight_id AS "highlightId",
        n.note_text AS "noteText",
        n.created_at AS "createdAt",
        n.updated_at AS "updatedAt",
        h.color AS "highlightColor",
        h.char_start AS "highlightCharStart",
        h.char_end AS "highlightCharEnd",
        h.highlighted_text AS "highlightedText",
        n.user_id AS "userId",
        u.username AS "username",
        u.display_name AS "userDisplayName",
        (
          SELECT LISTAGG(s.user_id, ',') WITHIN GROUP (ORDER BY s.user_id)
            FROM annotation_shares s
           WHERE s.annotation_id = n.note_id
             AND s.annotation_type = 'note'
        ) AS "sharedWithUserIds"
      FROM user_notes n
      JOIN users u ON u.user_id = n.user_id
      LEFT JOIN user_highlights h
        ON h.highlight_id = n.highlight_id
      WHERE n.book_id = :bookId
        AND (:pageNumber IS NULL OR n.page_number = :pageNumber)
        AND (
          n.user_id = :userId
          OR EXISTS (
            SELECT 1 FROM annotation_shares s
             WHERE s.annotation_id = n.note_id
               AND s.annotation_type = 'note'
               AND s.user_id = :userId
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM book_shares bs
               WHERE bs.book_id = :bookId
                 AND bs.user_id = :userId
            )
          )
          OR (
            :shareAll = 1
            AND EXISTS (
              SELECT 1 FROM books bk
               WHERE bk.book_id = :bookId
                 AND bk.owner_user_id = :userId
            )
          )
        )
      ORDER BY n.page_number ASC, n.paragraph_number ASC NULLS LAST, n.updated_at DESC
    `,
    {
      bookId,
      pageNumber: pageNumber ?? null,
      shareAll: shareUserAnnotations ? 1 : 0,
      userId
    }
  );

  return ((result.rows ?? []) as Array<NoteRecord & { sharedWithUserIds: string | null }>).map((row) => ({
    ...row,
    sharedWithUserIds: row.sharedWithUserIds ? row.sharedWithUserIds.split(",").filter(Boolean) : []
  }));
}

export const registerAnnotationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/books/:bookId/annotations", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const query = annotationsQuerySchema.parse(request.query);
    const connection = await getConnection();

    try {
      const book = await findAccessibleBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const access = request.bookAccess!;
      const isAuthorish = access.role === "OWNER" || access.role === "EDITOR" || access.role === "COMMENTER";
      const shareAll = isAuthorish && book.shareUserAnnotations;

      const [bookmarks, highlights, notes] = await Promise.all([
        listBookmarksShared(connection, request.currentUser.userId, params.bookId, query.pageNumber, shareAll),
        listHighlightsShared(connection, request.currentUser.userId, params.bookId, query.pageNumber, shareAll),
        listNotesShared(connection, request.currentUser.userId, params.bookId, query.pageNumber, shareAll)
      ]);

      return reply.send({ bookmarks, highlights, notes, shareUserAnnotations: book.shareUserAnnotations });
    } finally {
      await connection.close();
    }
  });

  app.get("/books/:bookId/navigation", { preHandler: [authenticateRequest, requireBookRole("VIEWER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findAccessibleBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const [bookmarks, highlights, notes, resolvedOutline] = await Promise.all([
        listBookmarks(connection, request.currentUser.userId, params.bookId),
        listHighlights(connection, request.currentUser.userId, params.bookId),
        listNotes(connection, request.currentUser.userId, params.bookId),
        resolveBookOutlineWithSource(connection, params.bookId)
      ]);

      return reply.send({
        bookmarks,
        highlights,
        notes,
        toc: resolvedOutline.outline,
        tocSource: resolvedOutline.source
      });
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/bookmarks", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createBookmarkSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findAccessibleBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const paragraph = await findParagraphLocation(connection, params.bookId, payload.paragraphId);
      if (!paragraph) {
        return reply.status(404).send({ message: "Paragraph not found." });
      }

      const existingBookmarks = await listBookmarks(connection, request.currentUser.userId, params.bookId, paragraph.pageNumber);
      const existingBookmark = existingBookmarks.find((bookmark) => bookmark.paragraphId === payload.paragraphId) ?? null;
      if (existingBookmark) {
        return reply.send({ bookmark: existingBookmark });
      }

      const bookmark = {
        bookmarkId: randomUUID(),
        createdAt: new Date().toISOString(),
        pageNumber: paragraph.pageNumber,
        paragraphId: paragraph.paragraphId,
        paragraphNumber: paragraph.paragraphNumber,
        sequenceNumber: paragraph.sequenceNumber
      } satisfies BookmarkRecord;

      await connection.execute(
        `
          INSERT INTO user_bookmarks (
            bookmark_id,
            user_id,
            book_id,
            paragraph_id,
            page_number,
            paragraph_number,
            sequence_number
          ) VALUES (
            :bookmarkId,
            :userId,
            :bookId,
            :paragraphId,
            :pageNumber,
            :paragraphNumber,
            :sequenceNumber
          )
        `,
        {
          bookmarkId: bookmark.bookmarkId,
          bookId: params.bookId,
          pageNumber: bookmark.pageNumber,
          paragraphId: bookmark.paragraphId,
          paragraphNumber: bookmark.paragraphNumber,
          sequenceNumber: bookmark.sequenceNumber,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      if (payload.sharedWithUserIds?.length) {
        await insertAnnotationShares(connection, bookmark.bookmarkId, "bookmark", params.bookId, payload.sharedWithUserIds);
      }

      return reply.status(201).send({ bookmark });
    } finally {
      await connection.close();
    }
  });

  app.delete("/books/:bookId/bookmarks/:bookmarkId", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookmarkParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          DELETE FROM user_bookmarks
          WHERE bookmark_id = :bookmarkId
            AND book_id = :bookId
            AND user_id = :userId
        `,
        {
          bookId: params.bookId,
          bookmarkId: params.bookmarkId,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        return reply.status(404).send({ message: "Bookmark not found." });
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/highlights", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createHighlightSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findAccessibleBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const paragraph = await findParagraphLocation(connection, params.bookId, payload.paragraphId);
      if (!paragraph) {
        return reply.status(404).send({ message: "Paragraph not found." });
      }

      if (payload.charEnd > paragraph.paragraphText.length) {
        return reply.status(422).send({ message: "El rango seleccionado supera la longitud del párrafo." });
      }

      const highlight = {
        charEnd: payload.charEnd,
        charStart: payload.charStart,
        color: payload.color,
        createdAt: new Date().toISOString(),
        highlightId: randomUUID(),
        highlightedText: payload.highlightedText,
        pageNumber: paragraph.pageNumber,
        paragraphId: paragraph.paragraphId,
        paragraphNumber: paragraph.paragraphNumber,
        sequenceNumber: paragraph.sequenceNumber,
        updatedAt: new Date().toISOString()
      } satisfies HighlightRecord;

      await connection.execute(
        `
          INSERT INTO user_highlights (
            highlight_id,
            user_id,
            book_id,
            paragraph_id,
            page_number,
            paragraph_number,
            sequence_number,
            color,
            char_start,
            char_end,
            highlighted_text,
            created_at,
            updated_at
          ) VALUES (
            :highlightId,
            :userId,
            :bookId,
            :paragraphId,
            :pageNumber,
            :paragraphNumber,
            :sequenceNumber,
            :color,
            :charStart,
            :charEnd,
            :highlightedText,
            SYSTIMESTAMP,
            SYSTIMESTAMP
          )
        `,
        {
          bookId: params.bookId,
          charEnd: highlight.charEnd,
          charStart: highlight.charStart,
          color: highlight.color,
          highlightId: highlight.highlightId,
          highlightedText: highlight.highlightedText,
          pageNumber: highlight.pageNumber,
          paragraphId: highlight.paragraphId,
          paragraphNumber: highlight.paragraphNumber,
          sequenceNumber: highlight.sequenceNumber,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      return reply.status(201).send({ highlight });
    } finally {
      await connection.close();
    }
  });

  app.delete("/books/:bookId/highlights/:highlightId", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = highlightParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          DELETE FROM user_highlights
          WHERE highlight_id = :highlightId
            AND book_id = :bookId
            AND user_id = :userId
        `,
        {
          bookId: params.bookId,
          highlightId: params.highlightId,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        return reply.status(404).send({ message: "Highlight not found." });
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/notes", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createNoteSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findAccessibleBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      let pageNumber = payload.pageNumber ?? null;
      let paragraphId = payload.paragraphId ?? null;
      let paragraphNumber: number | null = null;
      let sequenceNumber: number | null = null;
      const highlightId: string | null = payload.highlightId ?? null;

      if (payload.highlightId) {
        const highlight = await findOwnedHighlight(connection, params.bookId, payload.highlightId, request.currentUser.userId);
        if (!highlight) {
          return reply.status(404).send({ message: "Highlight not found." });
        }

        pageNumber = highlight.pageNumber;
        paragraphId = highlight.paragraphId;
        paragraphNumber = highlight.paragraphNumber;
        sequenceNumber = highlight.sequenceNumber;
      } else if (payload.paragraphId) {
        const paragraph = await findParagraphLocation(connection, params.bookId, payload.paragraphId);
        if (!paragraph) {
          return reply.status(404).send({ message: "Paragraph not found." });
        }

        pageNumber = paragraph.pageNumber;
        paragraphId = paragraph.paragraphId;
        paragraphNumber = paragraph.paragraphNumber;
        sequenceNumber = paragraph.sequenceNumber;
      } else if (!pageNumber || pageNumber > book.totalPages) {
        return reply.status(422).send({ message: "Debes indicar una página válida o un párrafo del libro." });
      }

      const noteId = randomUUID();

      await connection.execute(
        `
          INSERT INTO user_notes (
            note_id,
            user_id,
            book_id,
            page_number,
            paragraph_id,
            paragraph_number,
            sequence_number,
            highlight_id,
            note_text,
            created_at,
            updated_at
          ) VALUES (
            :noteId,
            :userId,
            :bookId,
            :pageNumber,
            :paragraphId,
            :paragraphNumber,
            :sequenceNumber,
            :highlightId,
            :noteText,
            SYSTIMESTAMP,
            SYSTIMESTAMP
          )
        `,
        {
          bookId: params.bookId,
          highlightId,
          noteId,
          noteText: payload.noteText,
          pageNumber,
          paragraphId,
          paragraphNumber,
          sequenceNumber,
          userId: request.currentUser.userId
        },
        { autoCommit: true }
      );

      if (payload.sharedWithUserIds?.length) {
        await insertAnnotationShares(connection, noteId, "note", params.bookId, payload.sharedWithUserIds);
      }

      return reply.status(201).send({
        note: {
          createdAt: new Date().toISOString(),
          highlightCharEnd: null,
          highlightCharStart: null,
          highlightColor: null,
          highlightId,
          highlightedText: null,
          noteId,
          noteText: payload.noteText,
          pageNumber,
          paragraphId,
          paragraphNumber,
          sequenceNumber,
          updatedAt: new Date().toISOString()
        }
      });
    } finally {
      await connection.close();
    }
  });

  app.put("/books/:bookId/notes/:noteId", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = noteParamsSchema.parse(request.params);
    const payload = updateNoteSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const note = await findOwnedNote(connection, params.bookId, params.noteId, request.currentUser.userId);
      if (!note) {
        return reply.status(404).send({ message: "Note not found." });
      }

      if (payload.highlightColor && !note.highlightId) {
        return reply.status(422).send({ message: "La nota no tiene un resaltado asociado para cambiar de color." });
      }

      try {
        if (payload.noteText) {
          const result = await connection.execute(
            `
              UPDATE user_notes
              SET note_text = :noteText,
                  updated_at = SYSTIMESTAMP
              WHERE note_id = :noteId
                AND book_id = :bookId
                AND user_id = :userId
            `,
            {
              bookId: params.bookId,
              noteId: params.noteId,
              noteText: payload.noteText,
              userId: request.currentUser.userId
            }
          );

          if ((result.rowsAffected ?? 0) === 0) {
            await connection.rollback();
            return reply.status(404).send({ message: "Note not found." });
          }
        }

        if (payload.sharedWithUserIds) {
          await connection.execute(
            `DELETE FROM annotation_shares
              WHERE annotation_id = :noteId
                AND annotation_type = 'note'`,
            { noteId: params.noteId },
            { autoCommit: true }
          );
          if (payload.sharedWithUserIds.length > 0) {
            await insertAnnotationShares(connection, params.noteId, "note", params.bookId, payload.sharedWithUserIds);
          }
        }

        if (payload.highlightColor && note.highlightId) {
          const highlightResult = await connection.execute(
            `
              UPDATE user_highlights
              SET color = :color,
                  updated_at = SYSTIMESTAMP
              WHERE highlight_id = :highlightId
                AND book_id = :bookId
                AND user_id = :userId
            `,
            {
              bookId: params.bookId,
              color: payload.highlightColor,
              highlightId: note.highlightId,
              userId: request.currentUser.userId
            }
          );

          if ((highlightResult.rowsAffected ?? 0) === 0) {
            await connection.rollback();
            return reply.status(404).send({ message: "Highlight not found." });
          }
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });

  app.delete("/books/:bookId/notes/:noteId", { preHandler: [authenticateRequest, requireBookRole("COMMENTER")] }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = noteParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const note = await findOwnedNote(connection, params.bookId, params.noteId, request.currentUser.userId);
      if (!note) {
        return reply.status(404).send({ message: "Note not found." });
      }

      try {
        const result = await connection.execute(
          `
            DELETE FROM user_notes
            WHERE note_id = :noteId
              AND book_id = :bookId
              AND user_id = :userId
          `,
          {
            bookId: params.bookId,
            noteId: params.noteId,
            userId: request.currentUser.userId
          }
        );

        if ((result.rowsAffected ?? 0) === 0) {
          await connection.rollback();
          return reply.status(404).send({ message: "Note not found." });
        }

        if (note.highlightId) {
          const remainingNotes = await countHighlightNotes(connection, params.bookId, note.highlightId, request.currentUser.userId);
          if (remainingNotes === 0) {
            await connection.execute(
              `
                DELETE FROM user_highlights
                WHERE highlight_id = :highlightId
                  AND book_id = :bookId
                  AND user_id = :userId
              `,
              {
                bookId: params.bookId,
                highlightId: note.highlightId,
                userId: request.currentUser.userId
              }
            );
          }
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });
};