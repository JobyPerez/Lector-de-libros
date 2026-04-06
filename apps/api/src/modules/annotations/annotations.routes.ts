import { randomUUID } from "node:crypto";

import { load } from "cheerio";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest } from "../auth/auth.routes.js";

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

const createBookmarkSchema = z.object({
  paragraphId: z.string().uuid()
});

const createHighlightSchema = z.object({
  charEnd: z.number().int().min(1),
  charStart: z.number().int().min(0),
  color: z.enum(highlightColors),
  highlightedText: z.string().trim().min(1).max(4000),
  paragraphId: z.string().uuid()
});

const createNoteSchema = z.object({
  highlightId: z.string().uuid().optional(),
  noteText: z.string().trim().min(1).max(4000),
  pageNumber: z.number().int().min(1).optional(),
  paragraphId: z.string().uuid().optional()
});

const updateNoteSchema = z.object({
  noteText: z.string().trim().min(1).max(4000)
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
  updatedAt: string;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function findOwnedBook(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, ownerUserId: string): Promise<OwnedBookRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        book_id AS "bookId",
        source_type AS "sourceType",
        total_pages AS "totalPages"
      FROM books
      WHERE book_id = :bookId
        AND owner_user_id = :ownerUserId
    `,
    {
      bookId,
      ownerUserId
    }
  );

  const [book] = (result.rows ?? []) as OwnedBookRecord[];
  return book ?? null;
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

async function listHighlights(
  connection: Awaited<ReturnType<typeof getConnection>>,
  userId: string,
  bookId: string,
  pageNumber: number
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
        AND page_number = :pageNumber
      ORDER BY paragraph_number ASC, char_start ASC, created_at ASC
    `,
    {
      bookId,
      pageNumber,
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

async function buildBookToc(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string) {
  const [pageResult, paragraphResult] = await Promise.all([
    connection.execute(
      `
        SELECT
          page_number AS "pageNumber",
          html_content AS "htmlContent"
        FROM book_pages
        WHERE book_id = :bookId
          AND html_content IS NOT NULL
        ORDER BY page_number ASC
      `,
      { bookId }
    ),
    connection.execute(
      `
        SELECT
          page_number AS "pageNumber",
          paragraph_number AS "paragraphNumber",
          sequence_number AS "sequenceNumber"
        FROM book_paragraphs
        WHERE book_id = :bookId
      `,
      { bookId }
    )
  ]);

  const paragraphLookup = new Map<string, number>();
  for (const row of (paragraphResult.rows ?? []) as Array<{ pageNumber: number; paragraphNumber: number; sequenceNumber: number }>) {
    paragraphLookup.set(`${row.pageNumber}:${row.paragraphNumber}`, Number(row.sequenceNumber));
  }

  const toc: Array<{ level: number; pageNumber: number; paragraphNumber: number; sequenceNumber: number | null; title: string }> = [];
  const seenEntries = new Set<string>();

  for (const row of (pageResult.rows ?? []) as Array<{ htmlContent: string | null; pageNumber: number }>) {
    if (!row.htmlContent) {
      continue;
    }

    const document = load(row.htmlContent);
    document("h1[data-paragraph-number], h2[data-paragraph-number], h3[data-paragraph-number], h4[data-paragraph-number], h5[data-paragraph-number], h6[data-paragraph-number]").each((_, node) => {
      const element = document(node);
      const title = normalizeWhitespace(element.text());
      const paragraphNumber = Number.parseInt(element.attr("data-paragraph-number") ?? "", 10);
      const tagName = node.tagName?.toLowerCase() ?? "h1";
      const level = Number.parseInt(tagName.replace("h", ""), 10);
      if (!title || !Number.isInteger(paragraphNumber) || !Number.isInteger(level)) {
        return;
      }

      const entryKey = `${row.pageNumber}:${paragraphNumber}:${title}`;
      if (seenEntries.has(entryKey)) {
        return;
      }

      seenEntries.add(entryKey);
      toc.push({
        level,
        pageNumber: row.pageNumber,
        paragraphNumber,
        sequenceNumber: paragraphLookup.get(`${row.pageNumber}:${paragraphNumber}`) ?? null,
        title
      });
    });
  }

  return toc;
}

export const registerAnnotationRoutes: FastifyPluginAsync = async (app) => {
  app.get("/books/:bookId/annotations", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const query = annotationsQuerySchema.parse(request.query);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const [bookmarks, highlights, notes] = await Promise.all([
        listBookmarks(connection, request.currentUser.userId, params.bookId, query.pageNumber),
        listHighlights(connection, request.currentUser.userId, params.bookId, query.pageNumber),
        listNotes(connection, request.currentUser.userId, params.bookId, query.pageNumber)
      ]);

      return reply.send({ bookmarks, highlights, notes });
    } finally {
      await connection.close();
    }
  });

  app.get("/books/:bookId/navigation", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const [bookmarks, notes, toc] = await Promise.all([
        listBookmarks(connection, request.currentUser.userId, params.bookId),
        listNotes(connection, request.currentUser.userId, params.bookId),
        book.sourceType === "EPUB" ? buildBookToc(connection, params.bookId) : Promise.resolve([])
      ]);

      return reply.send({ bookmarks, notes, toc });
    } finally {
      await connection.close();
    }
  });

  app.post("/books/:bookId/bookmarks", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createBookmarkSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
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

      return reply.status(201).send({ bookmark });
    } finally {
      await connection.close();
    }
  });

  app.delete("/books/:bookId/bookmarks/:bookmarkId", { preHandler: authenticateRequest }, async (request, reply) => {
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

  app.post("/books/:bookId/highlights", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createHighlightSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
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

  app.delete("/books/:bookId/highlights/:highlightId", { preHandler: authenticateRequest }, async (request, reply) => {
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

  app.post("/books/:bookId/notes", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = createNoteSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
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

  app.put("/books/:bookId/notes/:noteId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = noteParamsSchema.parse(request.params);
    const payload = updateNoteSchema.parse(request.body);
    const connection = await getConnection();

    try {
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
        },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        return reply.status(404).send({ message: "Note not found." });
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });

  app.delete("/books/:bookId/notes/:noteId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = noteParamsSchema.parse(request.params);
    const connection = await getConnection();

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
        },
        { autoCommit: true }
      );

      if ((result.rowsAffected ?? 0) === 0) {
        return reply.status(404).send({ message: "Note not found." });
      }

      return reply.status(204).send();
    } finally {
      await connection.close();
    }
  });
};