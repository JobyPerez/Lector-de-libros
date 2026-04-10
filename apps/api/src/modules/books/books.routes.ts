import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { buildEpubExport, buildPdfExport } from "./book-export.js";
import { deriveTitleFromFileName, inferSourceType, parseUploadedBook, sanitizeParagraphs, supportedBookSourceTypes, type SupportedBookSourceType } from "./book-import.js";
import { replaceBookOutline, resolveBookOutline, type BookOutlineEntry } from "./book-outline.js";
import { isRateLimitOcrError, isSupportedImageUpload, runOcrOnImage, supportedImageOcrModes, supportedImageRotations, type ImageOcrMode, type ImageRotation } from "./image-ocr.js";
import { buildRichPageFromEditableText, extractEmbeddedImageSources } from "./rich-content.js";
import { generateSectionSummary } from "./section-summary.js";

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
  synopsis: z.string().trim().max(5000).optional(),
  ocrMode: z.enum(supportedImageOcrModes).default("AUTO")
});

const importImagesFieldsSchema = z.object({
  ocrMode: z.enum(supportedImageOcrModes).default("AUTO")
});

const importImagesParamsSchema = z.object({
  bookId: z.string().uuid()
});

const importImagesQuerySchema = z.object({
  afterPage: z.coerce.number().int().min(0).optional(),
  progressId: z.string().uuid().optional()
});

const bookParamsSchema = z.object({
  bookId: z.string().uuid()
});

const sectionParamsSchema = z.object({
  bookId: z.string().uuid(),
  chapterId: z.string().trim().min(1).max(200)
});

const updateBookSchema = z.object({
  title: z.string().trim().min(1).max(500),
  authorName: z.string().trim().min(1).max(255).optional(),
  synopsis: z.string().trim().max(5000).optional()
});

const pageParamsSchema = z.object({
  bookId: z.string().uuid(),
  pageNumber: z.coerce.number().int().min(1)
});

const updateOcrPageSchema = z.object({
  editedText: z.string().trim().min(1).max(50000),
  sourceImageRotation: z.coerce.number().int().refine((value): value is ImageRotation => supportedImageRotations.includes(value as ImageRotation), {
    message: "La rotación debe ser 0, 90, 180 o 270 grados."
  }).optional()
});

const rerunOcrPageSchema = z.object({
  ocrMode: z.enum(supportedImageOcrModes).default("VISION")
});

const updateImageRotationSchema = z.object({
  rotation: z.coerce.number().int().refine((value): value is ImageRotation => supportedImageRotations.includes(value as ImageRotation), {
    message: "La rotación debe ser 0, 90, 180 o 270 grados."
  })
});

const updateOutlineSchema = z.object({
  entries: z.array(z.object({
    level: z.coerce.number().int().min(1).max(6),
    pageNumber: z.coerce.number().int().min(1),
    paragraphNumber: z.coerce.number().int().min(1),
    title: z.string().trim().min(1).max(500)
  })).max(400)
});

type UploadedBinaryFile = {
  buffer: Buffer;
  fieldName: string;
  fileName: string;
  mimeType: string;
};

type ProcessedImagePage = UploadedBinaryFile & {
  editedText: string;
  htmlContent: string | null;
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
  htmlContent: string | null;
  ocrStatus: string;
  pageId: string;
  pageLabel: string | null;
  pageType: string;
  pageNumber: number;
  rawText: string | null;
  sourceImageRotation: ImageRotation;
  sourceFileId: string | null;
  updatedAt: string;
};

type BookBinaryFileRecord = {
  contentBlob?: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
};

type ImportImagesProgressRecord = {
  bookId: string;
  completedFiles: number;
  currentFileIndex: number | null;
  currentFileName: string | null;
  errorMessage: string | null;
  stage: "ocr" | "waiting" | "saving" | "completed" | "failed";
  totalFiles: number;
  waitMessage: string | null;
  waitUntil: number | null;
  updatedAt: number;
  userId: string;
};

type SectionParagraphBoundary = {
  pageNumber: number;
  paragraphNumber: number;
  sequenceNumber: number;
};

type BookSectionContext = {
  chapterId: string;
  endPageNumber: number;
  endParagraphNumber: number;
  endSequenceNumber: number;
  isGenerated: boolean;
  level: number;
  startPageNumber: number;
  startParagraphNumber: number;
  startSequenceNumber: number;
  title: string;
};

type StoredSectionSummaryRecord = {
  createdAt: string;
  endPageNumber: number;
  endParagraphNumber: number;
  endSequenceNumber: number;
  sectionTitle: string;
  startPageNumber: number;
  startParagraphNumber: number;
  startSequenceNumber: number;
  summaryId: string;
  summaryText: string;
  updatedAt: string;
};

const importImagesProgressStore = new Map<string, ImportImagesProgressRecord>();
const importImagesProgressTtlMs = 10 * 60 * 1000;
const maximumUploadedImageBytes = 32 * 1024 * 1024;
const maximumOcrRateLimitRetriesPerFile = 3;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function pruneImportImagesProgressStore() {
  const expiresBefore = Date.now() - importImagesProgressTtlMs;

  for (const [progressId, progress] of importImagesProgressStore.entries()) {
    if (progress.updatedAt < expiresBefore) {
      importImagesProgressStore.delete(progressId);
    }
  }
}

function setImportImagesProgress(progressId: string, progress: ImportImagesProgressRecord) {
  pruneImportImagesProgressStore();
  importImagesProgressStore.set(progressId, {
    ...progress,
    updatedAt: Date.now()
  });
}

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

async function readUploadedFile(file: MultipartFile, options?: { fileName?: string; maxBytes?: number }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of file.file) {
    const bufferChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bufferChunk.length;

    if (options?.maxBytes && totalBytes > options.maxBytes) {
      throw Object.assign(new Error(
        options.fileName
          ? `La imagen ${options.fileName} supera el maximo permitido de 32 MB.`
          : "La imagen supera el maximo permitido de 32 MB."
      ), {
        statusCode: 413
      });
    }

    chunks.push(bufferChunk);
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
      const buffer = await readUploadedFile({ file: multipartPart.file } as MultipartFile, {
        fileName: multipartPart.filename,
        maxBytes: maximumUploadedImageBytes
      });
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

function buildDownloadFileName(baseName: string, extension: string): string {
  const normalizedBaseName = deriveTitleFromFileName(baseName).replace(/\s+/gu, "-").toLowerCase() || "libro";
  return `${normalizedBaseName}.${extension}`;
}

function paragraphsFromEditedText(editedText: string): string[] {
  return sanitizeParagraphs(buildRichPageFromEditableText(editedText).paragraphs);
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

    if (file.buffer.length > maximumUploadedImageBytes) {
      throw Object.assign(new Error(`La imagen ${file.fileName} supera el maximo permitido de 32 MB.`), {
        statusCode: 413
      });
    }
  }

  return files;
}

async function ocrImageFiles(
  files: UploadedBinaryFile[],
  ocrMode: ImageOcrMode,
  onProgress?: (progress: {
    completedFiles: number;
    currentFileIndex: number;
    currentFileName: string;
    totalFiles: number;
  }) => void,
  onWaiting?: (progress: {
    completedFiles: number;
    currentFileIndex: number;
    currentFileName: string;
    retryAfterSeconds: number;
    totalFiles: number;
    waitMessage: string;
  }) => void
): Promise<ProcessedImagePage[]> {
  const pages: ProcessedImagePage[] = [];

  for (const [index, file] of files.entries()) {
    onProgress?.({
      completedFiles: index,
      currentFileIndex: index,
      currentFileName: file.fileName,
      totalFiles: files.length
    });

    let rateLimitRetries = 0;
    let ocrResult;

    while (true) {
      try {
        ocrResult = await runOcrOnImage(file.buffer, file.fileName, file.mimeType, ocrMode);
        break;
      } catch (error) {
        if (!isRateLimitOcrError(error) || rateLimitRetries >= maximumOcrRateLimitRetriesPerFile) {
          throw error;
        }

        onWaiting?.({
          completedFiles: index,
          currentFileIndex: index,
          currentFileName: file.fileName,
          retryAfterSeconds: error.retryAfterSeconds,
          totalFiles: files.length,
          waitMessage: error.message
        });

        await delay(error.retryAfterSeconds * 1000);
        rateLimitRetries += 1;

        onProgress?.({
          completedFiles: index,
          currentFileIndex: index,
          currentFileName: file.fileName,
          totalFiles: files.length
        });
      }
    }

    pages.push({
      ...file,
      editedText: ocrResult.editedText,
      htmlContent: ocrResult.htmlContent,
      paragraphs: ocrResult.paragraphs,
      rawText: ocrResult.rawText
    });

    onProgress?.({
      completedFiles: index + 1,
      currentFileIndex: index,
      currentFileName: file.fileName,
      totalFiles: files.length
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

async function findParagraphBoundary(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number,
  paragraphNumber: number
): Promise<SectionParagraphBoundary | null> {
  const result = await connection.execute(
    `
      SELECT
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber"
      FROM book_paragraphs
      WHERE book_id = :bookId
        AND page_number = :pageNumber
        AND paragraph_number = :paragraphNumber
    `,
    {
      bookId,
      pageNumber,
      paragraphNumber
    }
  );

  const [boundary] = (result.rows ?? []) as SectionParagraphBoundary[];
  return boundary ?? null;
}

async function findLastParagraphBoundary(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  startSequenceNumber?: number,
  endSequenceNumber?: number
): Promise<SectionParagraphBoundary | null> {
  const result = await connection.execute(
    `
      SELECT
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber"
      FROM book_paragraphs
      WHERE book_id = :bookId
        AND (:startSequenceNumber IS NULL OR sequence_number >= :startSequenceNumber)
        AND (:endSequenceNumber IS NULL OR sequence_number <= :endSequenceNumber)
      ORDER BY sequence_number DESC
      FETCH FIRST 1 ROWS ONLY
    `,
    {
      bookId,
      endSequenceNumber: endSequenceNumber ?? null,
      startSequenceNumber: startSequenceNumber ?? null
    }
  );

  const [boundary] = (result.rows ?? []) as SectionParagraphBoundary[];
  return boundary ?? null;
}

async function resolveBookSectionContext(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  chapterId: string
): Promise<BookSectionContext | null> {
  const outline = await resolveBookOutline(connection, bookId);
  const sectionIndex = outline.findIndex((entry) => entry.chapterId === chapterId);
  if (sectionIndex === -1) {
    return null;
  }

  const currentSection = outline[sectionIndex];
  if (!currentSection) {
    return null;
  }

  const nextSection = outline[sectionIndex + 1] ?? null;
  const startBoundary = await findParagraphBoundary(
    connection,
    bookId,
    currentSection.pageNumber,
    currentSection.paragraphNumber
  );

  if (!startBoundary) {
    throw Object.assign(new Error("La entrada del índice no apunta a un párrafo válido del libro."), {
      statusCode: 409
    });
  }

  const nextBoundary = nextSection
    ? await findParagraphBoundary(connection, bookId, nextSection.pageNumber, nextSection.paragraphNumber)
    : null;

  if (nextSection && !nextBoundary) {
    throw Object.assign(new Error("La siguiente entrada del índice no apunta a un párrafo válido del libro."), {
      statusCode: 409
    });
  }

  const fallbackEndBoundary = await findLastParagraphBoundary(connection, bookId, startBoundary.sequenceNumber);
  if (!fallbackEndBoundary) {
    throw Object.assign(new Error("El libro no contiene párrafos para resolver el rango de la sección."), {
      statusCode: 409
    });
  }

  const endSequenceNumber = nextBoundary
    ? Math.max(startBoundary.sequenceNumber, nextBoundary.sequenceNumber - 1)
    : fallbackEndBoundary.sequenceNumber;
  const endBoundary = await findLastParagraphBoundary(connection, bookId, startBoundary.sequenceNumber, endSequenceNumber);

  if (!endBoundary) {
    throw Object.assign(new Error("No se pudo determinar el final de la sección."), {
      statusCode: 409
    });
  }

  return {
    chapterId: currentSection.chapterId,
    endPageNumber: endBoundary.pageNumber,
    endParagraphNumber: endBoundary.paragraphNumber,
    endSequenceNumber: endBoundary.sequenceNumber,
    isGenerated: currentSection.isGenerated,
    level: currentSection.level,
    startPageNumber: startBoundary.pageNumber,
    startParagraphNumber: startBoundary.paragraphNumber,
    startSequenceNumber: startBoundary.sequenceNumber,
    title: currentSection.title
  };
}

async function findStoredSectionSummary(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  chapterId: string,
  userId: string
): Promise<StoredSectionSummaryRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        summary_id AS "summaryId",
        section_title AS "sectionTitle",
        start_page_number AS "startPageNumber",
        end_page_number AS "endPageNumber",
        start_paragraph_number AS "startParagraphNumber",
        end_paragraph_number AS "endParagraphNumber",
        start_sequence_number AS "startSequenceNumber",
        end_sequence_number AS "endSequenceNumber",
        summary_text AS "summaryText",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM user_book_section_summaries
      WHERE book_id = :bookId
        AND chapter_id = :chapterId
        AND user_id = :userId
    `,
    {
      bookId,
      chapterId,
      userId
    }
  );

  const [summary] = (result.rows ?? []) as StoredSectionSummaryRecord[];
  return summary ?? null;
}

async function findBookPage(connection: Awaited<ReturnType<typeof getConnection>>, bookId: string, pageNumber: number): Promise<BookPageRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        page_id AS "pageId",
        page_number AS "pageNumber",
        source_file_id AS "sourceFileId",
        raw_text AS "rawText",
        html_content AS "htmlContent",
        edited_text AS "editedText",
        source_image_rotation AS "sourceImageRotation",
        page_label AS "pageLabel",
        page_type AS "pageType",
        ocr_status AS "ocrStatus",
        updated_at AS "updatedAt",
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

async function shiftSubsequentRelatedReferences(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number,
  pageDelta: number,
  sequenceDelta: number
): Promise<void> {
  if (pageDelta === 0 && sequenceDelta === 0) {
    return;
  }

  const temporaryOffset = 100000;

  if (sequenceDelta !== 0) {
    await connection.execute(
      `
        UPDATE book_chapters
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
  }

  await connection.execute(
    `
      UPDATE user_bookmarks
      SET page_number = page_number + :pageDelta,
          sequence_number = sequence_number + :sequenceDelta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageDelta,
      pageNumber,
      sequenceDelta
    }
  );

  await connection.execute(
    `
      UPDATE user_highlights
      SET page_number = page_number + :pageDelta,
          sequence_number = sequence_number + :sequenceDelta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageDelta,
      pageNumber,
      sequenceDelta
    }
  );

  await connection.execute(
    `
      UPDATE user_notes
      SET page_number = page_number + :pageDelta,
          sequence_number = CASE
            WHEN sequence_number IS NULL THEN NULL
            ELSE sequence_number + :sequenceDelta
          END
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageDelta,
      pageNumber,
      sequenceDelta
    }
  );

  await connection.execute(
    `
      UPDATE user_book_progress
      SET current_page_number = current_page_number + :pageDelta,
          current_sequence_number = current_sequence_number + :sequenceDelta
      WHERE book_id = :bookId
        AND current_page_number > :pageNumber
    `,
    {
      bookId,
      pageDelta,
      pageNumber,
      sequenceDelta
    }
  );

  if (sequenceDelta !== 0) {
    await connection.execute(
      `
        UPDATE book_chapters
        SET page_number = page_number + :pageDelta,
            sequence_number = sequence_number - :temporaryOffset + :sequenceDelta
        WHERE book_id = :bookId
          AND page_number > :pageNumber
      `,
      {
        bookId,
        pageDelta,
        pageNumber,
        sequenceDelta,
        temporaryOffset
      }
    );

    return;
  }

  await connection.execute(
    `
      UPDATE book_chapters
      SET page_number = page_number + :pageDelta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      pageDelta,
      pageNumber
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

async function replaceBookPageParagraphs(
  connection: Awaited<ReturnType<typeof getConnection>>,
  options: {
    bookId: string;
    editedText: string;
    htmlContent: string | null;
    ocrStatus: string;
    page: BookPageRecord;
    pageNumber: number;
    paragraphs: string[];
    rawText: string;
    sourceImageRotation?: ImageRotation;
  }
): Promise<void> {
  const countResult = await connection.execute(
    `
      SELECT COUNT(*) AS "paragraphCount"
      FROM book_paragraphs
      WHERE book_id = :bookId
        AND page_number = :pageNumber
    `,
    {
      bookId: options.bookId,
      pageNumber: options.pageNumber
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
      bookId: options.bookId,
      pageNumber: options.pageNumber
    }
  );

  const currentParagraphCount = Number(((countResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
  const previousParagraphCount = Number(((previousCountResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
  const delta = options.paragraphs.length - currentParagraphCount;

  await invalidateBookAudioCache(connection, options.bookId);

  await connection.execute(
    `
      DELETE FROM book_paragraphs
      WHERE book_id = :bookId
        AND page_number = :pageNumber
    `,
    {
      bookId: options.bookId,
      pageNumber: options.pageNumber
    }
  );

  await shiftSubsequentSequenceNumbers(connection, options.bookId, options.pageNumber, delta);

  for (const [paragraphIndex, paragraphText] of options.paragraphs.entries()) {
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
        bookId: options.bookId,
        pageId: options.page.pageId,
        pageNumber: options.pageNumber,
        paragraphId: randomUUID(),
        paragraphNumber: paragraphIndex + 1,
        paragraphText,
        sequenceNumber: previousParagraphCount + paragraphIndex + 1
      }
    );
  }

  const pageUpdateAssignments = [
    "raw_text = :rawText",
    "html_content = :htmlContent",
    "edited_text = :editedText",
    "ocr_status = :ocrStatus"
  ];

  const pageUpdateBinds: Record<string, string | null | ImageRotation> = {
    editedText: options.editedText,
    htmlContent: options.htmlContent,
    ocrStatus: options.ocrStatus,
    pageId: options.page.pageId,
    rawText: options.rawText
  };

  if (options.sourceImageRotation !== undefined) {
    pageUpdateAssignments.push("source_image_rotation = :sourceImageRotation");
    pageUpdateBinds.sourceImageRotation = options.sourceImageRotation;
  }

  await connection.execute(
    `
      UPDATE book_pages
      SET ${pageUpdateAssignments.join(",\n          ")}
      WHERE page_id = :pageId
    `,
    pageUpdateBinds
  );

  await connection.execute(
    `
      UPDATE books
      SET total_paragraphs = total_paragraphs + :delta,
          status = 'READY'
      WHERE book_id = :bookId
    `,
    {
      bookId: options.bookId,
      delta
    }
  );
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
          html_content,
          edited_text,
          source_image_rotation,
          ocr_status
        ) VALUES (
          :pageId,
          :bookId,
          :pageNumber,
          :sourceFileId,
          :rawText,
          :htmlContent,
          :editedText,
          0,
          'READY'
        )
      `,
      {
        bookId,
        editedText: processedPage.editedText,
        htmlContent: processedPage.htmlContent,
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
  app.get("/import-images/progress/:progressId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    pruneImportImagesProgressStore();
    const params = z.object({ progressId: z.string().uuid() }).parse(request.params);
    const progress = importImagesProgressStore.get(params.progressId);

    if (!progress || progress.userId !== request.currentUser.userId) {
      return reply.status(404).send({ message: "Progreso no encontrado." });
    }

    return reply.send({
      progress: {
        bookId: progress.bookId,
        completedFiles: progress.completedFiles,
        currentFileIndex: progress.currentFileIndex,
        currentFileName: progress.currentFileName,
        errorMessage: progress.errorMessage,
        stage: progress.stage,
        totalFiles: progress.totalFiles,
        waitMessage: progress.waitMessage,
        waitSecondsRemaining: progress.waitUntil ? Math.max(Math.ceil((progress.waitUntil - Date.now()) / 1000), 0) : null
      }
    });
  });

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
            synopsis AS "synopsis",
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

  app.put("/:bookId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = updateBookSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const existingBook = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!existingBook) {
        return reply.status(404).send({ message: "Book not found." });
      }

      await connection.execute(
        `
          UPDATE books
          SET title = :title,
              author_name = :authorName,
              synopsis = :synopsis
          WHERE book_id = :bookId
            AND owner_user_id = :ownerUserId
        `,
        {
          authorName: payload.authorName ?? null,
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId,
          synopsis: payload.synopsis ?? null,
          title: payload.title
        },
        {
          autoCommit: true
        }
      );

      return reply.send({
        book: {
          ...existingBook,
          authorName: payload.authorName ?? null,
          synopsis: payload.synopsis ?? null,
          title: payload.title
        }
      });
    } finally {
      await connection.close();
    }
  });

  app.delete("/:bookId", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const existingBook = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!existingBook) {
        return reply.status(404).send({ message: "Book not found." });
      }

      await connection.execute(
        `
          DELETE FROM books
          WHERE book_id = :bookId
            AND owner_user_id = :ownerUserId
        `,
        {
          bookId: params.bookId,
          ownerUserId: request.currentUser.userId
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
              html_content,
              edited_text,
              ocr_status
            ) VALUES (
              :pageId,
              :bookId,
              :pageNumber,
              :rawText,
              :htmlContent,
              :editedText,
              'SKIPPED'
            )
          `,
          {
            bookId,
            editedText: page.paragraphs.join("\n\n"),
            htmlContent: page.htmlContent ?? null,
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
      ocrMode: multipartForm.fields.ocrMode,
      synopsis: multipartForm.fields.synopsis,
      title: multipartForm.fields.title
    });
    const imageFiles = ensureImageFiles(multipartForm.files);
    const processedPages = await ocrImageFiles(imageFiles, payload.ocrMode);
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

    const currentUser = request.currentUser;

    const params = importImagesParamsSchema.parse(request.params);
    const query = importImagesQuerySchema.parse(request.query);
    const multipartForm = await collectMultipartForm(request);
    const payload = importImagesFieldsSchema.parse({
      ocrMode: multipartForm.fields.ocrMode
    });
    const imageFiles = ensureImageFiles(multipartForm.files);
    const connection = await getConnection();
    let progressId = query.progressId;

    try {
      const existingBook = await findOwnedBook(connection, params.bookId, currentUser.userId);
      if (!existingBook) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (existingBook.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "Solo puedes añadir imágenes a libros creados desde imágenes." });
      }

      if (progressId) {
        setImportImagesProgress(progressId, {
          bookId: existingBook.bookId,
          completedFiles: 0,
          currentFileIndex: imageFiles.length > 0 ? 0 : null,
          currentFileName: imageFiles[0]?.fileName ?? null,
          errorMessage: null,
          stage: "ocr",
          totalFiles: imageFiles.length,
          waitMessage: null,
          waitUntil: null,
          updatedAt: Date.now(),
          userId: currentUser.userId
        });
      }

      const processedPages = await ocrImageFiles(
        imageFiles,
        payload.ocrMode,
        (progress) => {
          if (!progressId) {
            return;
          }

          setImportImagesProgress(progressId, {
            bookId: existingBook.bookId,
            completedFiles: progress.completedFiles,
            currentFileIndex: progress.completedFiles >= progress.totalFiles ? null : progress.currentFileIndex,
            currentFileName: progress.completedFiles >= progress.totalFiles ? null : progress.currentFileName,
            errorMessage: null,
            stage: "ocr",
            totalFiles: progress.totalFiles,
            waitMessage: null,
            waitUntil: null,
            updatedAt: Date.now(),
            userId: currentUser.userId
          });
        },
        (progress) => {
          if (!progressId) {
            return;
          }

          setImportImagesProgress(progressId, {
            bookId: existingBook.bookId,
            completedFiles: progress.completedFiles,
            currentFileIndex: progress.currentFileIndex,
            currentFileName: progress.currentFileName,
            errorMessage: null,
            stage: "waiting",
            totalFiles: progress.totalFiles,
            waitMessage: progress.waitMessage,
            waitUntil: Date.now() + (progress.retryAfterSeconds * 1000),
            updatedAt: Date.now(),
            userId: currentUser.userId
          });
        }
      );

      const insertionAfterPage = query.afterPage ?? Number(existingBook.totalPages);
      if (insertionAfterPage > Number(existingBook.totalPages)) {
        return reply.status(422).send({ message: "La página de inserción no existe en este libro." });
      }

      const insertionStartPageNumber = insertionAfterPage + 1;
      const startingSequenceNumber = (await countParagraphsUpToPage(connection, existingBook.bookId, insertionAfterPage)) + 1;
      const addedParagraphs = processedPages.reduce((count, page) => count + page.paragraphs.length, 0);

      if (progressId) {
        setImportImagesProgress(progressId, {
          bookId: existingBook.bookId,
          completedFiles: processedPages.length,
          currentFileIndex: null,
          currentFileName: null,
          errorMessage: null,
          stage: "saving",
          totalFiles: imageFiles.length,
          waitMessage: null,
          waitUntil: null,
          updatedAt: Date.now(),
          userId: currentUser.userId
        });
      }

      try {
        await shiftSubsequentPageNumbers(connection, existingBook.bookId, insertionAfterPage, processedPages.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Error al desplazar numeros de pagina: ${message}`);
      }

      try {
        await shiftSubsequentSequenceNumbers(connection, existingBook.bookId, insertionAfterPage, addedParagraphs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Error al desplazar secuencias y anotaciones: ${message}`);
      }

      try {
        await shiftSubsequentRelatedReferences(
          connection,
          existingBook.bookId,
          insertionAfterPage,
          processedPages.length,
          addedParagraphs
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Error al reajustar referencias del lector: ${message}`);
      }

      let insertionSummary;
      try {
        insertionSummary = await insertProcessedImagePages(
          connection,
          existingBook.bookId,
          processedPages,
          insertionStartPageNumber,
          startingSequenceNumber
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Error al insertar las nuevas paginas: ${message}`);
      }

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

      if (progressId) {
        setImportImagesProgress(progressId, {
          bookId: existingBook.bookId,
          completedFiles: processedPages.length,
          currentFileIndex: null,
          currentFileName: null,
          errorMessage: null,
          stage: "completed",
          totalFiles: imageFiles.length,
          waitMessage: null,
          waitUntil: null,
          updatedAt: Date.now(),
          userId: currentUser.userId
        });
      }

      return reply.status(201).send({
        addedPages: insertionSummary.addedPages,
        addedParagraphs: insertionSummary.addedParagraphs,
        insertionStartPageNumber,
        book: updatedBook
      });
    } catch (error) {
      if (progressId) {
        setImportImagesProgress(progressId, {
          bookId: params.bookId,
          completedFiles: 0,
          currentFileIndex: null,
          currentFileName: null,
          errorMessage: error instanceof Error ? error.message : "No se pudieron añadir nuevas páginas.",
          stage: "failed",
          totalFiles: imageFiles.length,
          waitMessage: null,
          waitUntil: null,
          updatedAt: Date.now(),
          userId: currentUser.userId
        });
      }

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

      await shiftSubsequentSequenceNumbers(connection, params.bookId, params.pageNumber, -deletedParagraphCount);
      await shiftSubsequentPageNumbers(connection, params.bookId, params.pageNumber, -1);
      await shiftSubsequentRelatedReferences(connection, params.bookId, params.pageNumber, -1, -deletedParagraphCount);

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
          htmlContent: pageRecord.htmlContent,
          ocrStatus: pageRecord.ocrStatus,
          pageLabel: pageRecord.pageLabel,
          pageType: pageRecord.pageType,
          pageNumber: params.pageNumber,
          sourceFileId: pageRecord.sourceFileId,
          sourceImageRotation: pageRecord.sourceImageRotation,
          updatedAt: pageRecord.updatedAt,
          rawText: pageRecord.rawText,
          paragraphs
        }
      });
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/pages/:pageNumber/image-rotation", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const payload = updateImageRotationSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (book.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "La orientación manual solo está disponible para libros creados desde imágenes." });
      }

      const page = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!page) {
        return reply.status(404).send({ message: "Page not found." });
      }

      if (!page.sourceFileId) {
        return reply.status(409).send({ message: "Esta página no tiene imagen original para guardar su orientación." });
      }

      await connection.execute(
        `
          UPDATE book_pages
          SET source_image_rotation = :rotation
          WHERE page_id = :pageId
        `,
        {
          pageId: page.pageId,
          rotation: payload.rotation
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
        .header("Cache-Control", "private, no-cache")
        .send(image.contentBlob);
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/pages/:pageNumber/image", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const uploadedFile = await request.file();
    if (!uploadedFile) {
      return reply.status(400).send({ message: "Debes adjuntar una imagen editada para la página." });
    }

    const [imageFile] = ensureImageFiles([{
      buffer: await readUploadedFile(uploadedFile, { fileName: uploadedFile.filename, maxBytes: maximumUploadedImageBytes }),
      fieldName: uploadedFile.fieldname ?? "image",
      fileName: uploadedFile.filename,
      mimeType: uploadedFile.mimetype
    }]);

    if (!imageFile) {
      return reply.status(400).send({ message: "Debes adjuntar una imagen válida para la página." });
    }

    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (book.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "La edición de imagen solo está disponible para libros creados desde imágenes." });
      }

      const page = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!page) {
        return reply.status(404).send({ message: "Page not found." });
      }

      if (!page.sourceFileId) {
        return reply.status(409).send({ message: "Esta página no tiene imagen original para guardar una versión recortada." });
      }

      await connection.execute(
        `
          UPDATE book_files
          SET file_name = :fileName,
              mime_type = :mimeType,
              byte_size = :byteSize,
              checksum_sha256 = :checksumSha256,
              content_blob = :contentBlob
          WHERE book_id = :bookId
            AND file_id = :fileId
        `,
        {
          bookId: params.bookId,
          byteSize: imageFile.buffer.length,
          checksumSha256: computeChecksum(imageFile.buffer),
          contentBlob: imageFile.buffer,
          fileId: page.sourceFileId,
          fileName: imageFile.fileName,
          mimeType: imageFile.mimeType
        }
      );

      await connection.execute(
        `
          UPDATE book_pages
          SET source_image_rotation = 0
          WHERE page_id = :pageId
        `,
        {
          pageId: page.pageId
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

  app.put("/:bookId/pages/:pageNumber/ocr", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const payload = updateOcrPageSchema.parse(request.body);

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

      const pageEmbeddedImages = extractEmbeddedImageSources(page.htmlContent);
      const richPage = buildRichPageFromEditableText(payload.editedText, { embeddedImages: pageEmbeddedImages });
      const paragraphs = paragraphsFromEditedText(payload.editedText);

      if (paragraphs.length === 0) {
        return reply.status(422).send({ message: "El texto editado debe producir al menos un párrafo." });
      }

      await replaceBookPageParagraphs(connection, {
        bookId: params.bookId,
        editedText: payload.editedText,
        htmlContent: richPage.htmlContent,
        ocrStatus: "READY",
        page,
        pageNumber: params.pageNumber,
        paragraphs,
        rawText: richPage.rawText || (page.rawText ?? payload.editedText),
        ...(payload.sourceImageRotation !== undefined ? { sourceImageRotation: payload.sourceImageRotation } : {})
      });

      await connection.commit();

      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.post("/:bookId/pages/:pageNumber/rerun-ocr", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = pageParamsSchema.parse(request.params);
    const payload = rerunOcrPageSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      if (book.sourceType !== "IMAGES") {
        return reply.status(409).send({ message: "El OCR manual solo está disponible para libros creados desde imágenes." });
      }

      const page = await findBookPage(connection, params.bookId, params.pageNumber);
      if (!page) {
        return reply.status(404).send({ message: "Page not found." });
      }

      if (!page.sourceFileId) {
        return reply.status(409).send({ message: "Esta página no tiene imagen original para volver a reconocer el OCR." });
      }

      const sourceFileResult = await connection.execute(
        `
          SELECT
            file_name AS "fileName",
            mime_type AS "mimeType",
            content_blob AS "contentBlob"
          FROM book_files
          WHERE book_id = :bookId
            AND file_id = :fileId
        `,
        {
          bookId: params.bookId,
          fileId: page.sourceFileId
        },
        {
          fetchInfo: {
            contentBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [sourceFile] = (sourceFileResult.rows ?? []) as Array<{ contentBlob?: Buffer; fileName?: string | null; mimeType?: string }>;
      if (!sourceFile?.contentBlob || !sourceFile.mimeType) {
        return reply.status(404).send({ message: "Source image not found." });
      }

      const ocrResult = await runOcrOnImage(
        sourceFile.contentBlob,
        sourceFile.fileName ?? `page-${params.pageNumber}.png`,
        sourceFile.mimeType,
        payload.ocrMode,
        page.sourceImageRotation
      );

      await replaceBookPageParagraphs(connection, {
        bookId: params.bookId,
        editedText: ocrResult.editedText,
        htmlContent: ocrResult.htmlContent,
        ocrStatus: "READY",
        page,
        pageNumber: params.pageNumber,
        paragraphs: ocrResult.paragraphs,
        rawText: ocrResult.rawText
      });

      await connection.commit();

      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/sections/:chapterId/summary", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = sectionParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const section = await resolveBookSectionContext(connection, params.bookId, params.chapterId);
      if (!section) {
        return reply.status(404).send({ message: "Section not found." });
      }

      const storedSummary = await findStoredSectionSummary(connection, params.bookId, params.chapterId, request.currentUser.userId);
      const isStale = Boolean(storedSummary) && (
        storedSummary?.startSequenceNumber !== section.startSequenceNumber
        || storedSummary?.endSequenceNumber !== section.endSequenceNumber
        || storedSummary?.sectionTitle !== section.title
      );

      return reply.send({
        section,
        summary: storedSummary
          ? {
              createdAt: storedSummary.createdAt,
              isStale,
              summaryId: storedSummary.summaryId,
              summaryText: storedSummary.summaryText,
              updatedAt: storedSummary.updatedAt
            }
          : null
      });
    } finally {
      await connection.close();
    }
  });

  app.post("/:bookId/sections/:chapterId/summary", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = sectionParamsSchema.parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const section = await resolveBookSectionContext(connection, params.bookId, params.chapterId);
      if (!section) {
        return reply.status(404).send({ message: "Section not found." });
      }

      const paragraphsResult = await connection.execute(
        `
          SELECT
            paragraph_text AS "paragraphText"
          FROM book_paragraphs
          WHERE book_id = :bookId
            AND sequence_number BETWEEN :startSequenceNumber AND :endSequenceNumber
          ORDER BY sequence_number ASC
        `,
        {
          bookId: params.bookId,
          endSequenceNumber: section.endSequenceNumber,
          startSequenceNumber: section.startSequenceNumber
        }
      );

      const paragraphs = ((paragraphsResult.rows ?? []) as Array<{ paragraphText: string }>).map((row) => row.paragraphText).filter(Boolean);
      if (paragraphs.length === 0) {
        return reply.status(422).send({ message: "La sección no tiene texto suficiente para resumirse." });
      }

      const summaryText = await generateSectionSummary(section.title, paragraphs);
      const existingSummary = await findStoredSectionSummary(connection, params.bookId, params.chapterId, request.currentUser.userId);

      if (existingSummary) {
        await connection.execute(
          `
            UPDATE user_book_section_summaries
            SET
              section_title = :sectionTitle,
              start_page_number = :startPageNumber,
              end_page_number = :endPageNumber,
              start_paragraph_number = :startParagraphNumber,
              end_paragraph_number = :endParagraphNumber,
              start_sequence_number = :startSequenceNumber,
              end_sequence_number = :endSequenceNumber,
              summary_text = :summaryText
            WHERE summary_id = :summaryId
          `,
          {
            endPageNumber: section.endPageNumber,
            endParagraphNumber: section.endParagraphNumber,
            endSequenceNumber: section.endSequenceNumber,
            sectionTitle: section.title,
            startPageNumber: section.startPageNumber,
            startParagraphNumber: section.startParagraphNumber,
            startSequenceNumber: section.startSequenceNumber,
            summaryId: existingSummary.summaryId,
            summaryText
          }
        );
      } else {
        await connection.execute(
          `
            INSERT INTO user_book_section_summaries (
              summary_id,
              user_id,
              book_id,
              chapter_id,
              section_title,
              start_page_number,
              end_page_number,
              start_paragraph_number,
              end_paragraph_number,
              start_sequence_number,
              end_sequence_number,
              summary_text
            ) VALUES (
              :summaryId,
              :userId,
              :bookId,
              :chapterId,
              :sectionTitle,
              :startPageNumber,
              :endPageNumber,
              :startParagraphNumber,
              :endParagraphNumber,
              :startSequenceNumber,
              :endSequenceNumber,
              :summaryText
            )
          `,
          {
            bookId: params.bookId,
            chapterId: params.chapterId,
            endPageNumber: section.endPageNumber,
            endParagraphNumber: section.endParagraphNumber,
            endSequenceNumber: section.endSequenceNumber,
            sectionTitle: section.title,
            startPageNumber: section.startPageNumber,
            startParagraphNumber: section.startParagraphNumber,
            startSequenceNumber: section.startSequenceNumber,
            summaryId: randomUUID(),
            summaryText,
            userId: request.currentUser.userId
          }
        );
      }

      await connection.commit();

      const storedSummary = await findStoredSectionSummary(connection, params.bookId, params.chapterId, request.currentUser.userId);

      return reply.send({
        section,
        summary: storedSummary
          ? {
              createdAt: storedSummary.createdAt,
              isStale: false,
              summaryId: storedSummary.summaryId,
              summaryText: storedSummary.summaryText,
              updatedAt: storedSummary.updatedAt
            }
          : null
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/outline", { preHandler: authenticateRequest }, async (request, reply) => {
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

      const outline = await resolveBookOutline(connection, params.bookId);
      return reply.send({ outline });
    } finally {
      await connection.close();
    }
  });

  app.put("/:bookId/outline", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = bookParamsSchema.parse(request.params);
    const payload = updateOutlineSchema.parse(request.body);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      await replaceBookOutline(connection, params.bookId, payload.entries);
      await connection.commit();

      return reply.status(204).send();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/export/:format", { preHandler: authenticateRequest }, async (request, reply) => {
    if (!request.currentUser) {
      return reply.status(401).send({ message: "Unauthenticated request." });
    }

    const params = z.object({
      bookId: z.string().uuid(),
      format: z.enum(["epub", "pdf"])
    }).parse(request.params);
    const connection = await getConnection();

    try {
      const book = await findOwnedBook(connection, params.bookId, request.currentUser.userId);
      if (!book) {
        return reply.status(404).send({ message: "Book not found." });
      }

      const [pagesResult, paragraphsResult, outlineResult, coverResult] = await Promise.all([
        connection.execute(
          `
            SELECT
              page_number AS "pageNumber",
              page_label AS "pageLabel",
              html_content AS "htmlContent"
            FROM book_pages
            WHERE book_id = :bookId
            ORDER BY page_number ASC
          `,
          { bookId: params.bookId }
        ),
        connection.execute(
          `
            SELECT
              page_number AS "pageNumber",
              paragraph_text AS "paragraphText"
            FROM book_paragraphs
            WHERE book_id = :bookId
            ORDER BY sequence_number ASC
          `,
          { bookId: params.bookId }
        ),
        resolveBookOutline(connection, params.bookId),
        connection.execute(
          `
            SELECT
              file_name AS "fileName",
              mime_type AS "mimeType",
              content_blob AS "contentBlob"
            FROM book_files
            WHERE book_id = :bookId
              AND file_kind IN ('COVER_IMAGE', 'PAGE_IMAGE')
            ORDER BY CASE WHEN file_kind = 'COVER_IMAGE' THEN 0 ELSE 1 END, NVL(page_number, 0) ASC, created_at ASC
            FETCH FIRST 1 ROWS ONLY
          `,
          { bookId: params.bookId },
          {
            fetchInfo: {
              contentBlob: { type: oracledb.BUFFER }
            }
          }
        )
      ]);

      const paragraphsByPage = new Map<number, Array<{ paragraphText: string }>>();
      for (const row of (paragraphsResult.rows ?? []) as Array<{ pageNumber: number; paragraphText: string }>) {
        const bucket = paragraphsByPage.get(row.pageNumber) ?? [];
        bucket.push({ paragraphText: row.paragraphText });
        paragraphsByPage.set(row.pageNumber, bucket);
      }

      const pages = ((pagesResult.rows ?? []) as Array<{ htmlContent: string | null; pageLabel: string | null; pageNumber: number }>).map((row) => ({
        htmlContent: row.htmlContent,
        pageLabel: row.pageLabel,
        pageNumber: row.pageNumber,
        paragraphs: paragraphsByPage.get(row.pageNumber) ?? []
      }));

      const [coverAsset] = (coverResult.rows ?? []) as Array<{ contentBlob?: Buffer; fileName?: string | null; mimeType?: string }>;
      const exportPayload = {
        book: {
          authorName: book.authorName,
          synopsis: book.synopsis,
          title: book.title
        },
        coverAsset: coverAsset?.contentBlob && coverAsset.mimeType
          ? {
              buffer: coverAsset.contentBlob,
              fileName: coverAsset.fileName ?? `${book.title}-cover`,
              mimeType: coverAsset.mimeType
            }
          : null,
        outline: outlineResult,
        pages
      };
      const fileBuffer = params.format === "epub"
        ? await buildEpubExport(exportPayload)
        : await buildPdfExport(exportPayload);
      const fileName = buildDownloadFileName(book.title, params.format);

      return reply
        .header("Content-Type", params.format === "epub" ? "application/epub+zip" : "application/pdf")
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .send(fileBuffer);
    } finally {
      await connection.close();
    }
  });

  app.get("/:bookId/download-original", { preHandler: authenticateRequest }, async (request, reply) => {
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

      if (book.sourceType === "IMAGES") {
        return reply.status(409).send({ message: "Los libros creados desde imágenes deben exportarse como EPUB o PDF." });
      }

      const originalFileKind = book.sourceType === "PDF" ? "ORIGINAL_PDF" : "ORIGINAL_EPUB";
      const originalResult = await connection.execute(
        `
          SELECT
            file_name AS "fileName",
            mime_type AS "mimeType",
            content_blob AS "contentBlob"
          FROM book_files
          WHERE book_id = :bookId
            AND file_kind = :fileKind
          ORDER BY created_at ASC
          FETCH FIRST 1 ROWS ONLY
        `,
        {
          bookId: params.bookId,
          fileKind: originalFileKind
        },
        {
          fetchInfo: {
            contentBlob: { type: oracledb.BUFFER }
          }
        }
      );

      const [originalFile] = (originalResult.rows ?? []) as BookBinaryFileRecord[];
      if (!originalFile?.contentBlob) {
        return reply.status(404).send({ message: "No se encontró el archivo original de este libro." });
      }

      const extension = book.sourceType === "PDF" ? "pdf" : "epub";
      const fileName = originalFile.fileName?.trim() || buildDownloadFileName(book.title, extension);
      const mimeType = originalFile.mimeType?.trim() || (book.sourceType === "PDF" ? "application/pdf" : "application/epub+zip");

      return reply
        .header("Content-Type", mimeType)
        .header("Content-Disposition", `attachment; filename="${fileName}"`)
        .send(originalFile.contentBlob);
    } finally {
      await connection.close();
    }
  });
};