import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { deriveTitleFromFileName, inferSourceType, parseUploadedBook, sanitizeParagraphs, supportedBookSourceTypes, type SupportedBookSourceType } from "./book-import.js";
import { isSupportedImageUpload, runOcrOnImage } from "./image-ocr.js";

const createBookSchema = z.object({
  title: z.string().trim().min(1).max(500),
  authorName: z.string().trim().min(1).max(255).optional(),
  synopsis: z.string().trim().max(5000).optional(),
  sourceType: z.enum(["PDF", "EPUB", "IMAGES"])
});

const importBookFieldsSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  authorName: z.string().trim().min(1).max(255).optional(),
  synopsis: z.string().trim().max(5000).optional(),
  sourceType: z.enum(supportedBookSourceTypes).optional()
});

const imageBookFieldsSchema = z.object({
  title: z.string().trim().min(1).max(500),
  authorName: z.string().trim().min(1).max(255).optional(),
  synopsis: z.string().trim().max(5000).optional()
});

const importImagesParamsSchema = z.object({
  bookId: z.string().uuid()
});

const importImagesQuerySchema = z.object({
  afterPage: z.coerce.number().int().min(0).optional()
});

const pageParamsSchema = z.object({
  bookId: z.string().uuid(),
  pageNumber: z.coerce.number().int().min(1)
});

const updateOcrPageSchema = z.object({
  editedText: z.string().trim().min(1).max(50000)
});

type UploadedBinaryFile = {
  buffer: Buffer;
  fieldName: string;
  fileName: string;
  mimeType: string;
};

type ProcessedImagePage = UploadedBinaryFile & {
  paragraphs: string[];
  rawText: string;
};

type OwnedBookRecord = {
  authorName: string | null;
  bookId: string;
  sourceType: "PDF" | "EPUB" | "IMAGES";
  status: string;
  synopsis: string | null;
  title: string;
  totalPages: number;
  totalParagraphs: number;
};

type BookPageRecord = {
  editedText: string | null;
  hasSourceImage: number;
  ocrStatus: string;
  pageId: string;
  pageNumber: number;
  rawText: string | null;
  sourceFileId: string | null;
};

function readMultipartField(fields: MultipartFile["fields"], fieldName: string): string | undefined {
  const fieldValue = fields[fieldName] as { value?: string } | Array<{ value?: string }> | undefined;

  if (!fieldValue) {
    return undefined;
  }

  if (Array.isArray(fieldValue)) {
    return fieldValue[0]?.value?.trim() || undefined;
  }

  return fieldValue.value?.trim() || undefined;
}

async function readUploadedFile(file: MultipartFile): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of file.file) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function collectMultipartForm(request: { parts: () => AsyncIterable<unknown> }): Promise<{ fields: Record<string, string>; files: UploadedBinaryFile[] }> {
  const fields: Record<string, string> = {};
  const files: UploadedBinaryFile[] = [];

  for await (const part of request.parts()) {
    const multipartPart = part as {
      fieldname?: string;
      file?: AsyncIterable<Buffer | Uint8Array>;
      filename?: string;
      mimetype?: string;
      type?: string;
      value?: unknown;
    };

    if (multipartPart.type === "file" && multipartPart.file && multipartPart.filename && multipartPart.mimetype) {
      const buffer = await readUploadedFile({ file: multipartPart.file } as MultipartFile);
      files.push({
        buffer,
        fieldName: multipartPart.fieldname ?? "file",
        fileName: multipartPart.filename,
        mimeType: multipartPart.mimetype
      });
      continue;
    }

    if (multipartPart.fieldname) {
      fields[multipartPart.fieldname] = String(multipartPart.value ?? "").trim();
    }
  }

  return { fields, files };
}

function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function paragraphsFromEditedText(editedText: string): string[] {
  const normalizedText = editedText.replace(/\r/g, "").trim();
  const paragraphCandidates = normalizedText
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.replace(/\n+/g, " ").trim())
    .filter(Boolean);

  return sanitizeParagraphs(paragraphCandidates);
}

function ensureImageFiles(files: UploadedBinaryFile[]): UploadedBinaryFile[] {
  if (files.length === 0) {
    throw Object.assign(new Error("Debes adjuntar al menos una imagen de página."), {
      statusCode: 400
    });
  }

  for (const file of files) {
    if (!isSupportedImageUpload(file.fileName, file.mimeType)) {
      throw Object.assign(new Error(`Archivo no soportado para OCR: ${file.fileName}. Usa PNG, JPG o WEBP.`), {
        statusCode: 415
      });
    }
  }

  return files;
}

async function ocrImageFiles(files: UploadedBinaryFile[]): Promise<ProcessedImagePage[]> {
  const pages: ProcessedImagePage[] = [];

  for (const file of files) {
    const ocrResult = await runOcrOnImage(file.buffer, file.fileName, file.mimeType);
    pages.push({
      ...file,
      paragraphs: ocrResult.paragraphs,
      rawText: ocrResult.rawText
    });
  }

  return pages;
}

async function findOwnedBook(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, ownerUserId: string): Promise<OwnedBookRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        book_id AS "bookId",
        title AS "title",
        author_name AS "authorName",
        synopsis AS "synopsis",
        source_type AS "sourceType",
        status AS "status",
        total_pages AS "totalPages",
        total_paragraphs AS "totalParagraphs"
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

async function findBookPage(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, pageNumber: number): Promise<BookPageRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        page_id AS "pageId",
        page_number AS "pageNumber",
        source_file_id AS "sourceFileId",
        raw_text AS "rawText",
        edited_text AS "editedText",
        ocr_status AS "ocrStatus",
        CASE WHEN source_file_id IS NOT NULL THEN 1 ELSE 0 END AS "hasSourceImage"
      FROM book_pages
      WHERE book_id = :bookId
        AND page_number = :pageNumber
    `,
    {
      bookId,
      pageNumber
    }
  );

  const [page] = (result.rows ?? []) as BookPageRecord[];
  return page ?? null;
}

async function invalidateBookAudioCache(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string): Promise<void> {
  await connection.execute(
    `
      UPDATE book_paragraphs
      SET audio_file_id = NULL
      WHERE book_id = :bookId
        AND audio_file_id IS NOT NULL
    `,
    {
      bookId
    }
  );

  await connection.execute(
    `
      DELETE FROM book_files
      WHERE book_id = :bookId
        AND file_kind = 'TTS_AUDIO'
    `,
    {
      bookId
    }
  );
}

async function shiftSubsequentSequenceNumbers(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number,
  delta: number
): Promise<void> {
  if (delta === 0) {
    return;
  }

  const temporaryOffset = 100000;

  await connection.execute(
    `
      UPDATE book_paragraphs
      SET sequence_number = sequence_number + :temporaryOffset
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageNumber,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_paragraphs
      SET sequence_number = sequence_number - :temporaryOffset + :delta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      delta,
      pageNumber,
      temporaryOffset
    }
  );
}

async function shiftSubsequentPageNumbers(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number,
  delta: number
): Promise<void> {
  if (delta === 0) {
    return;
  }

  const temporaryOffset = 100000;

  await connection.execute(
    `
      UPDATE book_pages
      SET page_number = page_number + :temporaryOffset
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageNumber,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_paragraphs
      SET page_number = page_number + :temporaryOffset
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageNumber,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_files
      SET page_number = page_number + :temporaryOffset
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageNumber,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_pages
      SET page_number = page_number - :temporaryOffset + :delta
      WHERE book_id = :bookId
        AND page_number > :temporaryOffset
    `,
    {
      bookId,
      delta,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_paragraphs
      SET page_number = page_number - :temporaryOffset + :delta
      WHERE book_id = :bookId
        AND page_number > :temporaryOffset
    `,
    {
      bookId,
      delta,
      temporaryOffset
    }
  );

  await connection.execute(
    `
      UPDATE book_files
      SET page_number = page_number - :temporaryOffset + :delta
      WHERE book_id = :bookId
        AND page_number > :temporaryOffset
    `,
    {
      bookId,
      delta,
      temporaryOffset
    }
  );
}

async function countParagraphsUpToPage(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number
): Promise<number> {
  if (pageNumber <= 0) {
    return 0;
  }

  const result = await connection.execute(
    `
      SELECT COUNT(*) AS "paragraphCount"
      FROM book_paragraphs
      WHERE book_id = :bookId
        AND page_number <= :pageNumber
    `,
    {
      bookId,
      pageNumber
    }
  );

  return Number(((result.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
}

async function insertProcessedImagePages(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  processedPages: ProcessedImagePage[],
  startingPageNumber: number,
  startingSequenceNumber: number
): Promise<{ addedPages: number; addedParagraphs: number }> {
  let pageNumber = startingPageNumber;
  let sequenceNumber = startingSequenceNumber;

  for (const processedPage of processedPages) {
    const fileId = randomUUID();
    const pageId = randomUUID();

    await connection.execute(
      `
        INSERT INTO book_files (
          file_id,
          book_id,
          file_kind,
          file_name,
          mime_type,
          page_number,
          byte_size,
          checksum_sha256,
          content_blob
        ) VALUES (
          :fileId,
          :bookId,
          'PAGE_IMAGE',
          :fileName,
          :mimeType,
          :pageNumber,
          :byteSize,
          :checksumSha256,
          :contentBlob
        )
      `,
      {
        bookId,
        byteSize: processedPage.buffer.length,
        checksumSha256: computeChecksum(processedPage.buffer),
        contentBlob: processedPage.buffer,
        fileId,
        fileName: processedPage.fileName,
        mimeType: processedPage.mimeType,
        pageNumber
      }
    );

    await connection.execute(
      `
        INSERT INTO book_pages (
          page_id,
          book_id,
          page_number,
          source_file_id,
          raw_text,
          edited_text,
          ocr_status
        ) VALUES (
          :pageId,
          :bookId,
          :pageNumber,
          :sourceFileId,
          :rawText,
          :editedText,
          'READY'
        )
      `,
      {
        bookId,
        editedText: processedPage.paragraphs.join("\n\n"),
        pageId,
        pageNumber,
        rawText: processedPage.rawText,
        sourceFileId: fileId
      }
    );

    for (const [paragraphIndex, paragraphText] of processedPage.paragraphs.entries()) {
      await connection.execute(
        `
          INSERT INTO book_paragraphs (
            paragraph_id,
            book_id,
            page_id,
            page_number,
            paragraph_number,
            sequence_number,
            paragraph_text
          ) VALUES (
            :paragraphId,
            :bookId,
            :pageId,
            :pageNumber,
            :paragraphNumber,
            :sequenceNumber,
            :paragraphText
          )
        `,
        {
          bookId,
          pageId,
          pageNumber,
          paragraphId: randomUUID(),
          paragraphNumber: paragraphIndex + 1,
          paragraphText,
          sequenceNumber
        }
      );

      sequenceNumber += 1;
    }

    await connection.execute(
      `
        INSERT INTO processing_jobs (
          job_id,
          book_id,
          page_id,
          job_type,
          status,
          attempt_count,
          payload_json,
          started_at,
          finished_at
        ) VALUES (
          :jobId,
          :bookId,
          :pageId,
          'OCR_PAGE',
          'READY',
          1,
          :payloadJson,
          SYSTIMESTAMP,
          SYSTIMESTAMP
        )
      `,
      {
        bookId,
        jobId: randomUUID(),
        pageId,
        payloadJson: JSON.stringify({
          fileName: processedPage.fileName,
          mimeType: processedPage.mimeType,
          pageNumber
        })
      }
    );

    pageNumber += 1;
  }

  return {
    addedPages: processedPages.length,
    addedParagraphs: sequenceNumber - startingSequenceNumber
  };
}

function detectSourceType(fileName: string, mimeType: string, requestedSourceType?: string): SupportedBookSourceType {
  if (requestedSourceType) {
    return requestedSourceType as SupportedBookSourceType;
  }

  const inferredSourceType = inferSourceType(fileName, mimeType);
  if (!inferredSourceType) {
    throw Object.assign(new Error(`Formato no soportado para ${extname(fileName) || mimeType}. Solo PDF y EPUB en esta fase.`), {
      statusCode: 415
    });
  }

  return inferredSourceType;
}

export const registerBookRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            book_id AS "bookId",
            title AS "title",
            author_name AS "authorName",
            source_type AS "sourceType",
            status AS "status",
            total_pages AS "totalPages",
            total_paragraphs AS "totalParagraphs",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM books
          WHERE owner_user_id = :ownerUserId
          ORDER BY updated_at DESC, created_at DESC
        `,
        {
          ownerUserId: request.currentUser.userId
        }
      );

      return reply.send({ books: result.rows ?? [] });
    } finally {
      await connection.close();
    }
  });

  app.post("/", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const payload = createBookSchema.parse(request.body);
    const bookId = randomUUID();
    const connection = await getConnection();

    try {
      await connection.execute(
        `
          INSERT INTO books (
            book_id,
            owner_user_id,
            title,
            author_name,
            synopsis,
            source_type,
            status
          ) VALUES (
            :bookId,
            :ownerUserId,
            :title,
            :authorName,
            :synopsis,
            :sourceType,
            'DRAFT'
          )
        `,
        {
          authorName: payload.authorName ?? null,
          bookId,
          ownerUserId: request.currentUser.userId,
          sourceType: payload.sourceType,
          synopsis: payload.synopsis ?? null,
          title: payload.title
        },
        {
          autoCommit: true
        }
      );
    } finally {
      await connection.close();
    }

    return reply.status(201).send({
      book: {
        authorName: payload.authorName ?? null,
        bookId,
        sourceType: payload.sourceType,
        status: "DRAFT",
        synopsis: payload.synopsis ?? null,
        title: payload.title,
        totalPages: 0,
        totalParagraphs: 0
      }
    });
  });

  app.post("/import", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const uploadedFile = await request.file();
    if (!uploadedFile) {
      return reply.status(400).send({ message: "Debes adjuntar un archivo PDF o EPUB." });
    }

    const rawFields = {
      authorName: readMultipartField(uploadedFile.fields, "authorName"),
      sourceType: readMultipartField(uploadedFile.fields, "sourceType"),
      synopsis: readMultipartField(uploadedFile.fields, "synopsis"),
      title: readMultipartField(uploadedFile.fields, "title")
    };
    const parsedFields = importBookFieldsSchema.parse(rawFields);
    const sourceType = detectSourceType(uploadedFile.filename, uploadedFile.mimetype, parsedFields.sourceType);
    const fileBuffer = await readUploadedFile(uploadedFile);
    const importedDocument = await parseUploadedBook(sourceType, fileBuffer);
    const bookId = randomUUID();
    const originalFileId = randomUUID();
    const title = parsedFields.title ?? deriveTitleFromFileName(uploadedFile.filename);
    const connection = await getConnection();

    try {
      await connection.execute(
        `
          INSERT INTO books (
            book_id,
            owner_user_id,
            title,
            author_name,
            synopsis,
            source_type,
            status,
            total_pages,
            total_paragraphs
          ) VALUES (
            :bookId,
            :ownerUserId,
            :title,
            :authorName,
            :synopsis,
            :sourceType,
            'READY',
            :totalPages,
            :totalParagraphs
          )
        `,
        {
          authorName: parsedFields.authorName ?? null,
          bookId,
          ownerUserId: request.currentUser.userId,
          sourceType,
          synopsis: parsedFields.synopsis ?? null,
          title,
          totalPages: importedDocument.totalPages,
          totalParagraphs: importedDocument.totalParagraphs
        }
      );

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
            :fileKind,
            :fileName,
            :mimeType,
            :byteSize,
            :checksumSha256,
            :contentBlob
          )
        `,
        {
          bookId,
          byteSize: fileBuffer.length,
          checksumSha256: computeChecksum(fileBuffer),
          contentBlob: fileBuffer,
          fileId: originalFileId,
          fileKind: sourceType === "PDF" ? "ORIGINAL_PDF" : "ORIGINAL_EPUB",
          fileName: uploadedFile.filename,
          mimeType: uploadedFile.mimetype
        }
      );

      let sequenceNumber = 1;

      for (const page of importedDocument.pages) {
        const pageId = randomUUID();
        await connection.execute(
          `
            INSERT INTO book_pages (
              page_id,
              book_id,
              page_number,
              raw_text,
              edited_text,
              ocr_status
            ) VALUES (
              :pageId,
              :bookId,
              :pageNumber,
              :rawText,
              :editedText,
              'SKIPPED'
            )
          `,
          {
            bookId,
            editedText: page.paragraphs.join("\n\n"),
            pageId,
            pageNumber: page.pageNumber,
            rawText: page.rawText
          }
        );

        for (const [paragraphIndex, paragraphText] of page.paragraphs.entries()) {
          await connection.execute(
            `
              INSERT INTO book_paragraphs (
                paragraph_id,
                book_id,
                page_id,
                page_number,
                paragraph_number,
                sequence_number,
                paragraph_text
              ) VALUES (
                :paragraphId,
                :bookId,
                :pageId,
                :pageNumber,
                :paragraphNumber,
                :sequenceNumber,
                :paragraphText
              )
            `,
            {
              bookId,
              pageId,
              pageNumber: page.pageNumber,
              paragraphId: randomUUID(),
              paragraphNumber: paragraphIndex + 1,
              paragraphText,
              sequenceNumber
            }
          );

          sequenceNumber += 1;
        }
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }

    return reply.status(201).send({
      book: {
        authorName: parsedFields.authorName ?? null,
        bookId,
        sourceType,
        status: "READY",
        synopsis: parsedFields.synopsis ?? null,
        title,
        totalPages: importedDocument.totalPages,
        totalParagraphs: importedDocument.totalParagraphs
      }
    });
  });

  app.post("/from-images", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const multipartForm = await collectMultipartForm(request);
    const payload = imageBookFieldsSchema.parse({
      authorName: multipartForm.fields.authorName,
      synopsis: multipartForm.fields.synopsis,
      title: multipartForm.fields.title
    });
    const imageFiles = ensureImageFiles(multipartForm.files);
    const processedPages = await ocrImageFiles(imageFiles);
    const connection = await getConnection();
    const bookId = randomUUID();

    try {
      await connection.execute(
        `
          INSERT INTO books (
            book_id,
            owner_user_id,
            title,
            author_name,
            synopsis,
            source_type,
            status,
            total_pages,
            total_paragraphs
          ) VALUES (
            :bookId,
            :ownerUserId,
            :title,
            :authorName,
            :synopsis,
            'IMAGES',
            'PROCESSING',
            0,
            0
          )
        `,
        {
          authorName: payload.authorName ?? null,
          bookId,
          ownerUserId: request.currentUser.userId,
          synopsis: payload.synopsis ?? null,
          title: payload.title
        }
      );

      const insertionSummary = await insertProcessedImagePages(connection, bookId, processedPages, 1, 1);

      await connection.execute(
        `
          UPDATE books
          SET status = 'READY',
              total_pages = :totalPages,
              total_paragraphs = :totalParagraphs
          WHERE book_id = :bookId
        `,
        {
          bookId,
          totalPages: insertionSummary.addedPages,
          totalParagraphs: insertionSummary.addedParagraphs
        }
      );

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }

    return reply.status(201).send({
      book: {
        authorName: payload.authorName ?? null,
        bookId,
        sourceType: "IMAGES",
        status: "READY",
        synopsis: payload.synopsis ?? null,
        title: payload.title,
        totalPages: processedPages.length,
        totalParagraphs: processedPages.reduce((count, page) => count + page.paragraphs.length, 0)
      }
    });
  });

  app.post("/:bookId/import-images", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = importImagesParamsSchema.parse(request.params);
    const query = importImagesQuerySchema.parse(request.query);
    const multipartForm = await collectMultipartForm(request);
    const imageFiles = ensureImageFiles(multipartForm.files);
    const processedPages = await ocrImageFiles(imageFiles);
    const connection = await getConnection();

    try {
      const existingBook = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!existingBook) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (existingBook.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "Solo puedes añadir imágenes a libros creados desde imágenes." });
      }

      const insertionAfterPage = query.afterPage ?? Number(existingBook.totalPages);
      if (insertionAfterPage > Number(existingBook.totalPages)) {
        return reply.status(422).send({ message: "La página de inserción no existe en este libro." });
      }

      const insertionStartPageNumber = insertionAfterPage + 1;
      const startingSequenceNumber = (await countParagraphsUpToPage(connection, existingBook.bookId, insertionAfterPage)) + 1;
      const addedParagraphs = processedPages.reduce((count, page) => count + page.paragraphs.length, 0);

      await invalidateBookAudioCache(connection, existingBook.bookId);
      await shiftSubsequentPageNumbers(connection, existingBook.bookId, insertionAfterPage, processedPages.length);
      await shiftSubsequentSequenceNumbers(connection, existingBook.bookId, insertionAfterPage, addedParagraphs);

      const insertionSummary = await insertProcessedImagePages(
        connection,
        existingBook.bookId,
        processedPages,
        insertionStartPageNumber,
        startingSequenceNumber
      );

      const updatedBook = {
        ...existingBook,
        status: "READY",
        totalPages: Number(existingBook.totalPages) + insertionSummary.addedPages,
        totalParagraphs: Number(existingBook.totalParagraphs) + insertionSummary.addedParagraphs
      };

      await connection.execute(
        `
          UPDATE books
          SET status = 'READY',
              total_pages = :totalPages,
              total_paragraphs = :totalParagraphs
          WHERE book_id = :bookId
        `,
        {
          bookId: updatedBook.bookId,
          totalPages: updatedBook.totalPages,
          totalParagraphs: updatedBook.totalParagraphs
        }
      );

      await connection.commit();

      return reply.status(201).send({
        addedPages: insertionSummary.addedPages,
        addedParagraphs: insertionSummary.addedParagraphs,
        insertionStartPageNumber,
        book: updatedBook
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.delete("/:bookId/pages/:pageNumber", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (book.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "Solo puedes borrar páginas de libros creados desde imágenes." });
      }

      const page = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!page) {
        return reply.status(404).send({ message: "Page not found." });
      }

      const countResult = await connection.execute(
        `
          SELECT COUNT(*) AS "paragraphCount"
          FROM book_paragraphs
          WHERE book_id = :bookId
            AND page_number = :pageNumber
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );
      const deletedParagraphCount = Number(((countResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
      const updatedTotalPages = Math.max(Number(book.totalPages) - 1, 0);
      const updatedTotalParagraphs = Math.max(Number(book.totalParagraphs) - deletedParagraphCount, 0);
      const nextPageNumber = updatedTotalPages === 0
        ? null
        : Math.min(params.pageNumber, updatedTotalPages);

      await invalidateBookAudioCache(connection, params.bookId);

      await connection.execute(
        `
          DELETE FROM book_files
          WHERE book_id = :bookId
            AND page_number = :pageNumber
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );

      await connection.execute(
        `
          DELETE FROM book_pages
          WHERE page_id = :pageId
        `,
        {
          pageId: page.pageId
        }
      );

      await shiftSubsequentPageNumbers(connection, params.bookId, params.pageNumber, -1);
      await shiftSubsequentSequenceNumbers(connection, params.bookId, params.pageNumber, -deletedParagraphCount);

      await connection.execute(
        `
          UPDATE books
          SET total_pages = :totalPages,
              total_paragraphs = :totalParagraphs,
              status = 'READY'
          WHERE book_id = :bookId
        `,
        {
          bookId: params.bookId,
          totalPages: updatedTotalPages,
          totalParagraphs: updatedTotalParagraphs
        }
      );

      await connection.execute(
        `
          UPDATE user_book_progress
          SET current_page_number = CASE
                WHEN current_page_number > :pageNumber THEN current_page_number - 1
                WHEN current_page_number = :pageNumber THEN :fallbackPageNumber
                ELSE current_page_number
              END,
              current_paragraph_number = CASE
                WHEN current_page_number >= :pageNumber THEN 1
                ELSE current_paragraph_number
              END,
              current_sequence_number = CASE
                WHEN current_page_number >= :pageNumber THEN 1
                ELSE current_sequence_number
              END,
              audio_offset_ms = CASE
                WHEN current_page_number >= :pageNumber THEN 0
                ELSE audio_offset_ms
              END,
              reading_percentage = CASE
                WHEN :totalParagraphs = 0 THEN 0
                ELSE reading_percentage
              END
          WHERE book_id = :bookId
        `,
        {
          bookId: params.bookId,
          fallbackPageNumber: nextPageNumber ?? 1,
          pageNumber: params.pageNumber,
          totalParagraphs: updatedTotalParagraphs
        }
      );

      await connection.commit();

      return reply.send({
        book: {
          ...book,
          status: "READY",
          totalPages: updatedTotalPages,
          totalParagraphs: updatedTotalParagraphs
        },
        deletedPageNumber: params.pageNumber,
        nextPageNumber
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({ bookId: z.string().uuid() }).parse(request.params);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            book_id AS "bookId",
            title AS "title",
            author_name AS "authorName",
            synopsis AS "synopsis",
            source_type AS "sourceType",
            status AS "status",
            total_pages AS "totalPages",
            total_paragraphs AS "totalParagraphs",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM books
          WHERE book_id = :bookId
            AND owner_user_id = :ownerUserId
        `,
        {
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId
        }
      );

      const [book] = (result.rows ?? []) as Array<Record<string, unknown>>;
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      return reply.send({ book });
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/pages/:pageNumber", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const bookResult = await connection.execute(
        `
          SELECT
            book_id AS "bookId",
            title AS "title",
            author_name AS "authorName",
            synopsis AS "synopsis",
            source_type AS "sourceType",
            status AS "status",
            total_pages AS "totalPages",
            total_paragraphs AS "totalParagraphs"
          FROM books
          WHERE book_id = :bookId
            AND owner_user_id = :ownerUserId
        `,
        {
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId
        }
      );

      const [book] = (bookResult.rows ?? []) as Array<Record<string, unknown>>;
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const pageRecord = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!pageRecord) {
        return reply.status(404).send({ message: "Page not found." });
      }

      const pageResult = await connection.execute(
        `
          SELECT
            paragraph_id AS "paragraphId",
            paragraph_number AS "paragraphNumber",
            sequence_number AS "sequenceNumber",
            paragraph_text AS "paragraphText"
          FROM book_paragraphs
          WHERE book_id = :bookId
            AND page_number = :pageNumber
          ORDER BY paragraph_number ASC
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );

      const paragraphs = (pageResult.rows ?? []) as Array<Record<string, unknown>>;

      return reply.send({
        book,
        hasNextPage: params.pageNumber < Number(book.totalPages ?? 0),
        hasPreviousPage: params.pageNumber > 1,
        page: {
          editedText: pageRecord.editedText,
          hasSourceImage: Number(pageRecord.hasSourceImage ?? 0) > 0,
          ocrStatus: pageRecord.ocrStatus,
          pageNumber: params.pageNumber,
          rawText: pageRecord.rawText,
          paragraphs
        }
      });
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/pages/:pageNumber/image", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const result = await connection.execute(
        `
          SELECT
            bf.mime_type AS "mimeType",
            bf.content_blob AS "contentBlob"
          FROM books b
          JOIN book_pages bp
            ON bp.book_id = b.book_id
          JOIN book_files bf
            ON bf.file_id = bp.source_file_id
          WHERE b.book_id = :bookId
            AND b.owner_user_id = :ownerUserId
            AND bp.page_number = :pageNumber
        `,
        {
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId,
          pageNumber: params.pageNumber
        },
        {
          fetchInfo: {
            contentBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [image] = (result.rows ?? []) as Array<{ contentBlob?: Buffer; mimeType?: string }>;
      if (!image?.contentBlob || !image.mimeType) {
        return reply.status(404).send({ message: "Source image not found." });
      }

      return reply
        .header("Content-Type", image.mimeType)
        .header("Cache-Control", "private, max-age=3600")
        .send(image.contentBlob);
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/pages/:pageNumber/ocr", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const payload = updateOcrPageSchema.parse(request.body);
    const paragraphs = paragraphsFromEditedText(payload.editedText);

    if (paragraphs.length === 0) {
      return reply.status(422).send({ message: "El texto editado debe producir al menos un párrafo." });
    }

    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (book.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "La edición OCR solo está disponible para libros creados desde imágenes." });
      }

      const page = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!page) {
        return reply.status(404).send({ message: "Page not found." });
      }

      const countResult = await connection.execute(
        `
          SELECT COUNT(*) AS "paragraphCount"
          FROM book_paragraphs
          WHERE book_id = :bookId
            AND page_number = :pageNumber
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );
      const previousCountResult = await connection.execute(
        `
          SELECT COUNT(*) AS "paragraphCount"
          FROM book_paragraphs
          WHERE book_id = :bookId
            AND page_number < :pageNumber
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );

      const currentParagraphCount = Number(((countResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
      const previousParagraphCount = Number(((previousCountResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
      const delta = paragraphs.length - currentParagraphCount;

      await invalidateBookAudioCache(connection, params.bookId);

      await connection.execute(
        `
          DELETE FROM book_paragraphs
          WHERE book_id = :bookId
            AND page_number = :pageNumber
        `,
        {
          bookId: params.bookId,
          pageNumber: params.pageNumber
        }
      );

      await shiftSubsequentSequenceNumbers(connection, params.bookId, params.pageNumber, delta);

      for (const [paragraphIndex, paragraphText] of paragraphs.entries()) {
        await connection.execute(
          `
            INSERT INTO book_paragraphs (
              paragraph_id,
              book_id,
              page_id,
              page_number,
              paragraph_number,
              sequence_number,
              paragraph_text
            ) VALUES (
              :paragraphId,
              :bookId,
              :pageId,
              :pageNumber,
              :paragraphNumber,
              :sequenceNumber,
              :paragraphText
            )
          `,
          {
            bookId: params.bookId,
            pageId: page.pageId,
            pageNumber: params.pageNumber,
            paragraphId: randomUUID(),
            paragraphNumber: paragraphIndex + 1,
            paragraphText,
            sequenceNumber: previousParagraphCount + paragraphIndex + 1
          }
        );
      }

      await connection.execute(
        `
          UPDATE book_pages
          SET edited_text = :editedText,
              ocr_status = 'READY'
          WHERE page_id = :pageId
        `,
        {
          editedText: payload.editedText,
          pageId: page.pageId
        }
      );

      await connection.execute(
        `
          UPDATE books
          SET total_paragraphs = total_paragraphs + :delta,
              status = 'READY'
          WHERE book_id = :bookId
        `,
        {
          bookId: params.bookId,
          delta
        }
      );

      await connection.commit();

      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });
};