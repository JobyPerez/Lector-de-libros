import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";

import type { MultipartFile } from "@fastify/multipart";
import { load } from "cheerio";
import type { FastifyPluginAsync } from "fastify";
import oracledb from "oracledb";
import { z } from "zod";

import { getConnection } from "../../config/database.js";
import { authenticateRequest } from "../auth/auth.routes.js";
import { buildEpubExport, buildPdfExport } from "./book-export.js";
import { deriveTitleFromFileName, inferSourceType, parseUploadedBook, sanitizeParagraphs, supportedBookSourceTypes, type SupportedBookSourceType } from "./book-import.js";
import { replaceBookOutline, resolveBookOutline, resolveBookOutlineWithSource, type BookOutlineEntry } from "./book-outline.js";
import { extractEpubCover } from "./epub-import.js";
import { isRateLimitOcrError, isSupportedImageUpload, runOcrOnImage, supportedImageOcrModes, supportedImageRotations, type ImageOcrMode, type ImageRotation } from "./image-ocr.js";
import { buildRichPageFromEditableText, extractEmbeddedImageSources, normalizeWhitespace } from "./rich-content.js";
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

type PageParagraphRecord = {
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

type StoredPageNoteRecord = {
  highlightId: string | null;
  noteId: string;
  noteText: string;
  pageNumber: number;
  paragraphId: string | null;
  paragraphNumber: number | null;
  sequenceNumber: number | null;
  userId: string;
};

type StoredPageBookmarkRecord = {
  bookmarkId: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
  userId: string;
};

type StoredPageHighlightRecord = {
  charEnd: number;
  charStart: number;
  color: "YELLOW" | "GREEN" | "BLUE" | "PINK";
  highlightId: string;
  highlightedText: string;
  pageNumber: number;
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
  userId: string;
};

type ReplacementParagraphRecord = {
  paragraphId: string;
  paragraphNumber: number;
  paragraphText: string;
  sequenceNumber: number;
};

type ResolvedReplacementParagraphSource = {
  paragraphId: string | null;
  paragraphNumber: number | null;
};

type HighlightTextRange = {
  charEnd: number;
  charStart: number;
};

type RestoredHighlightRecord = HighlightTextRange & {
  highlightId: string;
  paragraphId: string;
  paragraphNumber: number;
  sequenceNumber: number;
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

function parseDataUriImage(dataUri: string): { buffer: Buffer; mimeType: string } | null {
  const normalizedDataUri = dataUri.trim();
  const match = normalizedDataUri.match(/^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/iu);
  if (!match?.[1] || !match[2]) {
    return null;
  }

  try {
    return {
      buffer: Buffer.from(match[2].replace(/\s+/gu, ""), "base64"),
      mimeType: match[1].toLowerCase()
    };
  } catch {
    return null;
  }
}

function extractFirstEmbeddedImageFromHtml(htmlContent: string | null | undefined): BookBinaryFileRecord | null {
  if (!htmlContent) {
    return null;
  }

  const document = load(htmlContent);
  let resolvedImage: BookBinaryFileRecord | null = null;

  const resolveSource = (source: string | undefined) => {
    if (resolvedImage || !source) {
      return;
    }

    const parsedImage = parseDataUriImage(source);
    if (!parsedImage) {
      return;
    }

    resolvedImage = {
      contentBlob: parsedImage.buffer,
      fileName: null,
      mimeType: parsedImage.mimeType
    };
  };

  document("img[src]").each((_, node) => {
    resolveSource(document(node).attr("src"));
  });

  if (resolvedImage) {
    return resolvedImage;
  }

  document("image").each((_, node) => {
    resolveSource(document(node).attr("href") ?? document(node).attr("xlink:href"));
  });

  return resolvedImage;
}

async function findStoredCoverAsset(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string
): Promise<BookBinaryFileRecord | null> {
  const result = await connection.execute(
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
    {
      bookId
    },
    {
      fetchInfo: {
        contentBlob: { type: oracledb.BUFFER }
      }
    }
  );

  const [coverAsset] = (result.rows ?? []) as BookBinaryFileRecord[];
  return coverAsset?.contentBlob && coverAsset.mimeType ? coverAsset : null;
}

async function findStoredPageImageAsset(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber?: number
): Promise<BookBinaryFileRecord | null> {
  const result = await connection.execute(
    `
      SELECT
        file_name AS "fileName",
        mime_type AS "mimeType",
        content_blob AS "contentBlob"
      FROM book_files
      WHERE book_id = :bookId
        AND file_kind = 'PAGE_IMAGE'
        ${pageNumber ? "AND page_number = :pageNumber" : ""}
      ORDER BY NVL(page_number, 0) ASC, created_at ASC
      FETCH FIRST 1 ROWS ONLY
    `,
    {
      bookId,
      ...(pageNumber ? { pageNumber } : {})
    },
    {
      fetchInfo: {
        contentBlob: { type: oracledb.BUFFER }
      }
    }
  );

  const [pageImageAsset] = (result.rows ?? []) as BookBinaryFileRecord[];
  return pageImageAsset?.contentBlob && pageImageAsset.mimeType ? pageImageAsset : null;
}

async function findBookFileByKind(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  fileKind: string
): Promise<BookBinaryFileRecord | null> {
  const result = await connection.execute(
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
      bookId,
      fileKind
    },
    {
      fetchInfo: {
        contentBlob: { type: oracledb.BUFFER }
      }
    }
  );

  const [bookFile] = (result.rows ?? []) as BookBinaryFileRecord[];
  return bookFile?.contentBlob ? bookFile : null;
}

async function resolveBookCoverAsset(
  connection: Awaited<ReturnType<typeof getConnection>>,
  book: OwnedBookRecord
): Promise<BookBinaryFileRecord | null> {
  if (book.sourceType === "IMAGES") {
    const firstPageImage = await findStoredPageImageAsset(connection, book.bookId, 1)
      ?? await findStoredPageImageAsset(connection, book.bookId);
    if (firstPageImage) {
      return firstPageImage;
    }
  }

  const storedCover = await findStoredCoverAsset(connection, book.bookId);
  if (storedCover) {
    return storedCover;
  }

  if (book.sourceType === "EPUB") {
    const originalEpub = await findBookFileByKind(connection, book.bookId, "ORIGINAL_EPUB");
    if (originalEpub?.contentBlob) {
      const derivedCover = extractEpubCover(originalEpub.contentBlob);
      if (derivedCover) {
        return {
          contentBlob: derivedCover.buffer,
          fileName: derivedCover.fileName,
          mimeType: derivedCover.mimeType
        };
      }
    }
  }

  const pageResult = await connection.execute(
    `
      SELECT
        html_content AS "htmlContent"
      FROM book_pages
      WHERE book_id = :bookId
        AND html_content IS NOT NULL
      ORDER BY page_number ASC
      FETCH FIRST 8 ROWS ONLY
    `,
    {
      bookId: book.bookId
    }
  );

  const pageRows = (pageResult.rows ?? []) as Array<{ htmlContent?: string | null }>;
  for (const pageRow of pageRows) {
    const embeddedImage = extractFirstEmbeddedImageFromHtml(pageRow.htmlContent ?? null);
    if (embeddedImage?.contentBlob && embeddedImage.mimeType) {
      return embeddedImage;
    }
  }

  return null;
}

function paragraphsFromEditedText(editedText: string): string[] {
  return sanitizeParagraphs(buildRichPageFromEditableText(editedText).paragraphs);
}

async function listPageParagraphs(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number
): Promise<PageParagraphRecord[]> {
  const result = await connection.execute(
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
      bookId,
      pageNumber
    }
  );

  return (result.rows ?? []) as PageParagraphRecord[];
}

async function listPageNotes(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number
): Promise<StoredPageNoteRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        note_id AS "noteId",
        user_id AS "userId",
        page_number AS "pageNumber",
        paragraph_id AS "paragraphId",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        highlight_id AS "highlightId",
        note_text AS "noteText"
      FROM user_notes
      WHERE book_id = :bookId
        AND page_number = :pageNumber
      ORDER BY created_at ASC
    `,
    {
      bookId,
      pageNumber
    }
  );

  return (result.rows ?? []) as StoredPageNoteRecord[];
}

async function listPageBookmarks(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number
): Promise<StoredPageBookmarkRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        bookmark_id AS "bookmarkId",
        user_id AS "userId",
        page_number AS "pageNumber",
        paragraph_id AS "paragraphId",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber"
      FROM user_bookmarks
      WHERE book_id = :bookId
        AND page_number = :pageNumber
      ORDER BY created_at ASC
    `,
    {
      bookId,
      pageNumber
    }
  );

  return (result.rows ?? []) as StoredPageBookmarkRecord[];
}

async function listPageHighlights(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number
): Promise<StoredPageHighlightRecord[]> {
  const result = await connection.execute(
    `
      SELECT
        h.highlight_id AS "highlightId",
        h.user_id AS "userId",
        h.page_number AS "pageNumber",
        h.paragraph_id AS "paragraphId",
        h.paragraph_number AS "paragraphNumber",
        h.sequence_number AS "sequenceNumber",
        h.color AS "color",
        h.char_start AS "charStart",
        h.char_end AS "charEnd",
        h.highlighted_text AS "highlightedText",
        bp.paragraph_text AS "paragraphText"
      FROM user_highlights h
      JOIN book_paragraphs bp
        ON bp.paragraph_id = h.paragraph_id
      WHERE h.book_id = :bookId
        AND h.page_number = :pageNumber
      ORDER BY h.paragraph_number ASC, h.char_start ASC, h.created_at ASC
    `,
    {
      bookId,
      pageNumber
    }
  );

  return (result.rows ?? []) as StoredPageHighlightRecord[];
}

function normalizeParagraphForMatch(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function computeParagraphSimilarity(left: PageParagraphRecord, right: ReplacementParagraphRecord): number {
  const leftText = normalizeParagraphForMatch(left.paragraphText);
  const rightText = normalizeParagraphForMatch(right.paragraphText);

  if (!leftText || !rightText) {
    return 0;
  }

  if (leftText === rightText) {
    return 6;
  }

  const leftWords = new Set(leftText.split(/\s+/u).filter(Boolean));
  const rightWords = new Set(rightText.split(/\s+/u).filter(Boolean));
  let overlappingWordCount = 0;

  for (const word of leftWords) {
    if (rightWords.has(word)) {
      overlappingWordCount += 1;
    }
  }

  const wordOverlap = overlappingWordCount / Math.max(leftWords.size, rightWords.size, 1);
  const lengthRatio = Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length, 1);
  const containsRatio = leftText.includes(rightText) || rightText.includes(leftText)
    ? Math.min(leftText.length, rightText.length) / Math.max(leftText.length, rightText.length, 1)
    : 0;
  const paragraphDistance = Math.abs(left.paragraphNumber - right.paragraphNumber);
  const positionBonus = Math.max(0, 1 - paragraphDistance / 3) * 0.35;

  return wordOverlap * 2.4 + containsRatio * 1.4 + lengthRatio * 0.35 + positionBonus;
}

function matchReplacementParagraphs(
  existingParagraphs: PageParagraphRecord[],
  replacementParagraphs: ReplacementParagraphRecord[]
): Map<string, ReplacementParagraphRecord> {
  const matchThreshold = 2.35;
  const fallbackThreshold = 1.45;
  const scoreMatrix = Array.from({ length: existingParagraphs.length + 1 }, () => Array<number>(replacementParagraphs.length + 1).fill(0));
  const actionMatrix = Array.from({ length: existingParagraphs.length + 1 }, () => Array<"match" | "skip-existing" | "skip-replacement">(replacementParagraphs.length + 1).fill("skip-existing"));

  for (let existingIndex = 1; existingIndex <= existingParagraphs.length; existingIndex += 1) {
    for (let replacementIndex = 1; replacementIndex <= replacementParagraphs.length; replacementIndex += 1) {
      const previousScoreRow = scoreMatrix[existingIndex - 1];
      const currentScoreRow = scoreMatrix[existingIndex];
      const currentActionRow = actionMatrix[existingIndex];
      const existingParagraph = existingParagraphs[existingIndex - 1];
      const replacementParagraph = replacementParagraphs[replacementIndex - 1];

      if (!previousScoreRow || !currentScoreRow || !currentActionRow || !existingParagraph || !replacementParagraph) {
        continue;
      }

      const skipExistingScore = previousScoreRow[replacementIndex] ?? 0;
      const skipReplacementScore = currentScoreRow[replacementIndex - 1] ?? 0;
      const similarityScore = computeParagraphSimilarity(
        existingParagraph,
        replacementParagraph
      );
      const matchScore = similarityScore >= matchThreshold
        ? (previousScoreRow[replacementIndex - 1] ?? 0) + similarityScore
        : Number.NEGATIVE_INFINITY;

      if (matchScore >= skipExistingScore && matchScore >= skipReplacementScore) {
        currentScoreRow[replacementIndex] = matchScore;
        currentActionRow[replacementIndex] = "match";
      } else if (skipReplacementScore > skipExistingScore) {
        currentScoreRow[replacementIndex] = skipReplacementScore;
        currentActionRow[replacementIndex] = "skip-replacement";
      } else {
        currentScoreRow[replacementIndex] = skipExistingScore;
        currentActionRow[replacementIndex] = "skip-existing";
      }
    }
  }

  const matches = new Map<string, ReplacementParagraphRecord>();
  const usedReplacementIds = new Set<string>();
  let existingIndex = existingParagraphs.length;
  let replacementIndex = replacementParagraphs.length;

  while (existingIndex > 0 && replacementIndex > 0) {
    const action = actionMatrix[existingIndex]?.[replacementIndex] ?? "skip-existing";
    const existingParagraph = existingParagraphs[existingIndex - 1];
    const replacementParagraph = replacementParagraphs[replacementIndex - 1];

    if (action === "match" && existingParagraph && replacementParagraph) {
      matches.set(existingParagraph.paragraphId, replacementParagraph);
      usedReplacementIds.add(replacementParagraph.paragraphId);
      existingIndex -= 1;
      replacementIndex -= 1;
      continue;
    }

    if (action === "skip-replacement") {
      replacementIndex -= 1;
      continue;
    }

    existingIndex -= 1;
  }

  for (const existingParagraph of existingParagraphs) {
    if (matches.has(existingParagraph.paragraphId)) {
      continue;
    }

    const fallbackParagraph = replacementParagraphs[existingParagraph.paragraphNumber - 1];
    if (!fallbackParagraph || usedReplacementIds.has(fallbackParagraph.paragraphId)) {
      continue;
    }

    if (computeParagraphSimilarity(existingParagraph, fallbackParagraph) < fallbackThreshold) {
      continue;
    }

    matches.set(existingParagraph.paragraphId, fallbackParagraph);
    usedReplacementIds.add(fallbackParagraph.paragraphId);
  }

  return matches;
}

function resolveReplacementParagraph(
  record: ResolvedReplacementParagraphSource,
  paragraphMatches: Map<string, ReplacementParagraphRecord>,
  replacementParagraphs: ReplacementParagraphRecord[]
): ReplacementParagraphRecord | null {
  if (record.paragraphId) {
    const matchedParagraph = paragraphMatches.get(record.paragraphId);
    if (matchedParagraph) {
      return matchedParagraph;
    }
  }

  if (record.paragraphNumber && record.paragraphNumber >= 1 && record.paragraphNumber <= replacementParagraphs.length) {
    return replacementParagraphs[record.paragraphNumber - 1] ?? null;
  }

  return null;
}

async function shiftSubsequentAnnotationSequenceNumbers(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  pageNumber: number,
  delta: number
): Promise<void> {
  if (delta === 0) {
    return;
  }

  await connection.execute(
    `
      UPDATE user_bookmarks
      SET sequence_number = sequence_number + :delta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      delta,
      pageNumber
    }
  );

  await connection.execute(
    `
      UPDATE user_highlights
      SET sequence_number = sequence_number + :delta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
    `,
    {
      bookId,
      delta,
      pageNumber
    }
  );

  await connection.execute(
    `
      UPDATE user_notes
      SET sequence_number = sequence_number + :delta
      WHERE book_id = :bookId
        AND page_number > :pageNumber
        AND sequence_number IS NOT NULL
    `,
    {
      bookId,
      delta,
      pageNumber
    }
  );
}

function findAllHighlightRanges(paragraphText: string, highlightedText: string, caseInsensitive = false): HighlightTextRange[] {
  const haystack = caseInsensitive ? paragraphText.toLocaleLowerCase("es") : paragraphText;
  const needle = caseInsensitive ? highlightedText.toLocaleLowerCase("es") : highlightedText;
  const ranges: HighlightTextRange[] = [];

  if (!needle) {
    return ranges;
  }

  let searchStart = 0;
  while (searchStart <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, searchStart);
    if (matchIndex === -1) {
      break;
    }

    ranges.push({
      charEnd: matchIndex + highlightedText.length,
      charStart: matchIndex
    });
    searchStart = matchIndex + Math.max(highlightedText.length, 1);
  }

  return ranges;
}

function rangesOverlap(left: HighlightTextRange, right: HighlightTextRange): boolean {
  return left.charStart < right.charEnd && right.charStart < left.charEnd;
}

function findReplacementHighlightRange(
  highlight: StoredPageHighlightRecord,
  replacementParagraph: ReplacementParagraphRecord,
  usedRanges: HighlightTextRange[]
): HighlightTextRange | null {
  const highlightedText = highlight.highlightedText.trim();
  if (!highlightedText) {
    return null;
  }

  const expectedStart = Math.round(
    (highlight.charStart / Math.max(highlight.paragraphText.length, 1)) * Math.max(replacementParagraph.paragraphText.length, 1)
  );
  const candidateRanges = [
    ...findAllHighlightRanges(replacementParagraph.paragraphText, highlightedText, false),
    ...findAllHighlightRanges(replacementParagraph.paragraphText, highlightedText, true)
  ].filter((candidate, index, allCandidates) => {
    return allCandidates.findIndex((otherCandidate) => otherCandidate.charStart === candidate.charStart && otherCandidate.charEnd === candidate.charEnd) === index;
  }).filter((candidate) => usedRanges.every((usedRange) => !rangesOverlap(candidate, usedRange)));

  if (candidateRanges.length === 0) {
    return null;
  }

  return candidateRanges.sort((left, right) => {
    const leftDistance = Math.abs(left.charStart - expectedStart);
    const rightDistance = Math.abs(right.charStart - expectedStart);
    return leftDistance - rightDistance || left.charStart - right.charStart;
  })[0] ?? null;
}

async function restorePageBookmarks(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  bookmarks: StoredPageBookmarkRecord[],
  paragraphMatches: Map<string, ReplacementParagraphRecord>,
  replacementParagraphs: ReplacementParagraphRecord[]
): Promise<void> {
  for (const bookmark of bookmarks) {
    const replacementParagraph = resolveReplacementParagraph(bookmark, paragraphMatches, replacementParagraphs);
    if (!replacementParagraph) {
      continue;
    }

    await connection.execute(
      `
        INSERT INTO user_bookmarks (
          bookmark_id,
          user_id,
          book_id,
          paragraph_id,
          page_number,
          paragraph_number,
          sequence_number,
          created_at
        ) VALUES (
          :bookmarkId,
          :userId,
          :bookId,
          :paragraphId,
          :pageNumber,
          :paragraphNumber,
          :sequenceNumber,
          SYSTIMESTAMP
        )
      `,
      {
        bookId,
        bookmarkId: bookmark.bookmarkId,
        pageNumber: bookmark.pageNumber,
        paragraphId: replacementParagraph.paragraphId,
        paragraphNumber: replacementParagraph.paragraphNumber,
        sequenceNumber: replacementParagraph.sequenceNumber,
        userId: bookmark.userId
      }
    );
  }
}

async function restorePageHighlights(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  highlights: StoredPageHighlightRecord[],
  paragraphMatches: Map<string, ReplacementParagraphRecord>,
  replacementParagraphs: ReplacementParagraphRecord[]
): Promise<Map<string, RestoredHighlightRecord>> {
  const restoredHighlights = new Map<string, RestoredHighlightRecord>();
  const usedRangesByParagraphId = new Map<string, HighlightTextRange[]>();

  for (const highlight of highlights) {
    const replacementParagraph = resolveReplacementParagraph(highlight, paragraphMatches, replacementParagraphs);
    if (!replacementParagraph) {
      continue;
    }

    const usedRanges = usedRangesByParagraphId.get(replacementParagraph.paragraphId) ?? [];
    const replacementRange = findReplacementHighlightRange(highlight, replacementParagraph, usedRanges);
    if (!replacementRange) {
      continue;
    }

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
        bookId,
        charEnd: replacementRange.charEnd,
        charStart: replacementRange.charStart,
        color: highlight.color,
        highlightId: highlight.highlightId,
        highlightedText: highlight.highlightedText,
        pageNumber: highlight.pageNumber,
        paragraphId: replacementParagraph.paragraphId,
        paragraphNumber: replacementParagraph.paragraphNumber,
        sequenceNumber: replacementParagraph.sequenceNumber,
        userId: highlight.userId
      }
    );

    usedRanges.push(replacementRange);
    usedRangesByParagraphId.set(replacementParagraph.paragraphId, usedRanges);
    restoredHighlights.set(highlight.highlightId, {
      ...replacementRange,
      highlightId: highlight.highlightId,
      paragraphId: replacementParagraph.paragraphId,
      paragraphNumber: replacementParagraph.paragraphNumber,
      sequenceNumber: replacementParagraph.sequenceNumber
    });
  }

  return restoredHighlights;
}

async function restorePageNotes(
  connection: Awaited<ReturnType<typeof getConnection>>,
  bookId: string,
  notes: StoredPageNoteRecord[],
  paragraphMatches: Map<string, ReplacementParagraphRecord>,
  replacementParagraphs: ReplacementParagraphRecord[],
  restoredHighlights: Map<string, RestoredHighlightRecord>
): Promise<void> {
  for (const note of notes) {
    const restoredHighlight = note.highlightId ? restoredHighlights.get(note.highlightId) ?? null : null;
    const replacementParagraph = restoredHighlight
      ? {
          paragraphId: restoredHighlight.paragraphId,
          paragraphNumber: restoredHighlight.paragraphNumber,
          paragraphText: "",
          sequenceNumber: restoredHighlight.sequenceNumber
        }
      : resolveReplacementParagraph(note, paragraphMatches, replacementParagraphs);

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
        bookId,
        highlightId: restoredHighlight?.highlightId ?? null,
        noteId: note.noteId,
        noteText: note.noteText,
        pageNumber: note.pageNumber,
        paragraphId: replacementParagraph?.paragraphId ?? null,
        paragraphNumber: replacementParagraph?.paragraphNumber ?? null,
        sequenceNumber: replacementParagraph?.sequenceNumber ?? null,
        userId: note.userId
      }
    );
  }
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
  const existingParagraphs = await listPageParagraphs(connection, options.bookId, options.pageNumber);
  const pageBookmarks = await listPageBookmarks(connection, options.bookId, options.pageNumber);
  const pageHighlights = await listPageHighlights(connection, options.bookId, options.pageNumber);
  const pageNotes = await listPageNotes(connection, options.bookId, options.pageNumber);
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

  const currentParagraphCount = existingParagraphs.length;
  const previousParagraphCount = Number(((previousCountResult.rows ?? []) as Array<{ paragraphCount: number }>)[0]?.paragraphCount ?? 0);
  const replacementParagraphs = options.paragraphs.map((paragraphText, paragraphIndex) => ({
    paragraphId: randomUUID(),
    paragraphNumber: paragraphIndex + 1,
    paragraphText,
    sequenceNumber: previousParagraphCount + paragraphIndex + 1
  })) satisfies ReplacementParagraphRecord[];
  const paragraphMatches = matchReplacementParagraphs(existingParagraphs, replacementParagraphs);
  const delta = replacementParagraphs.length - currentParagraphCount;

  await invalidateBookAudioCache(connection, options.bookId);

  await connection.execute(
    `
      DELETE FROM user_notes
      WHERE book_id = :bookId
        AND page_number = :pageNumber
    `,
    {
      bookId: options.bookId,
      pageNumber: options.pageNumber
    }
  );

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
  await shiftSubsequentAnnotationSequenceNumbers(connection, options.bookId, options.pageNumber, delta);

  for (const replacementParagraph of replacementParagraphs) {
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
        paragraphId: replacementParagraph.paragraphId,
        paragraphNumber: replacementParagraph.paragraphNumber,
        paragraphText: replacementParagraph.paragraphText,
        sequenceNumber: replacementParagraph.sequenceNumber
      }
    );
  }

  if (pageBookmarks.length > 0) {
    await restorePageBookmarks(connection, options.bookId, pageBookmarks, paragraphMatches, replacementParagraphs);
  }

  const restoredHighlights = pageHighlights.length > 0
    ? await restorePageHighlights(connection, options.bookId, pageHighlights, paragraphMatches, replacementParagraphs)
    : new Map<string, RestoredHighlightRecord>();

  if (pageNotes.length > 0) {
    await restorePageNotes(connection, options.bookId, pageNotes, paragraphMatches, replacementParagraphs, restoredHighlights);
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
  const coverCountResult = await connection.execute(
    `
      SELECT COUNT(*) AS "coverCount"
      FROM book_files
      WHERE book_id = :bookId
        AND file_kind = 'COVER_IMAGE'
    `,
    {
      bookId
    }
  );
  const coverCount = Number(((coverCountResult.rows ?? [])[0] as { coverCount?: number } | undefined)?.coverCount ?? 0);

  if (coverCount === 0 && processedPages[0]) {
    const coverPage = processedPages[0];

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
          'COVER_IMAGE',
          :fileName,
          :mimeType,
          :byteSize,
          :checksumSha256,
          :contentBlob
        )
      `,
      {
        bookId,
        byteSize: coverPage.buffer.length,
        checksumSha256: computeChecksum(coverPage.buffer),
        contentBlob: coverPage.buffer,
        fileId: randomUUID(),
        fileName: coverPage.fileName,
        mimeType: coverPage.mimeType
      }
    );
  }

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

      if (importedDocument.coverImage) {
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
              'COVER_IMAGE',
              :fileName,
              :mimeType,
              :byteSize,
              :checksumSha256,
              :contentBlob
            )
          `,
          {
            bookId,
            byteSize: importedDocument.coverImage.buffer.length,
            checksumSha256: computeChecksum(importedDocument.coverImage.buffer),
            contentBlob: importedDocument.coverImage.buffer,
            fileId: randomUUID(),
            fileName: importedDocument.coverImage.fileName,
            mimeType: importedDocument.coverImage.mimeType
          }
        );
      }

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

      if (importedDocument.outlineEntries && importedDocument.outlineEntries.length > 0) {
        await replaceBookOutline(connection, bookId, importedDocument.outlineEntries, "EPUB_TOC");
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

      await connection.execute(
        `
          UPDATE books
          SET status = status
          WHERE book_id = :bookId
        `,
        {
          bookId: params.bookId
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

      const resolvedOutline = await resolveBookOutlineWithSource(connection, params.bookId);
      return reply.send({ outline: resolvedOutline.outline, outlineSource: resolvedOutline.source });
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

  app.get("/:bookId/cover", { preHandler: authenticateRequest }, async (request, reply) => {
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

      const coverAsset = await resolveBookCoverAsset(connection, book);
      if (!coverAsset?.contentBlob || !coverAsset.mimeType) {
        return reply.status(404).send({ message: "Cover image not found." });
      }

      return reply
        .header("Content-Type", coverAsset.mimeType)
        .header("Cache-Control", "private, no-cache")
        .send(coverAsset.contentBlob);
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
      const originalFile = await findBookFileByKind(connection, params.bookId, originalFileKind);
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