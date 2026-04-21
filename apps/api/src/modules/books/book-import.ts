import { extname } from "node:path";

import { parseEpubBuffer } from "./epub-import.js";
import { parsePdfBuffer } from "./pdf-import.js";

export const supportedBookSourceTypes = ["PDF", "EPUB"] as const;

export type SupportedBookSourceType = (typeof supportedBookSourceTypes)[number];

export type ImportedPage = {
  editedText?: string | null;
  htmlContent?: string | null;
  pageNumber: number;
  paragraphs: string[];
  rawText: string;
};

export type ImportedBinaryAsset = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
};

export type ImportedOutlineEntry = {
  level: number;
  pageNumber: number;
  paragraphNumber: number;
  title: string;
};

export type ImportedDocument = {
  coverImage?: ImportedBinaryAsset | null;
  outlineEntries?: ImportedOutlineEntry[];
  pages: ImportedPage[];
  totalPages: number;
  totalParagraphs: number;
};

const sentenceBoundaryExpression = /(?<=[.!?;:])\s+/u;

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeWhitespacePreservingLineBreaks(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .split(/\n/u)
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n")
    .trim();
}

function splitLongParagraph(paragraph: string, maxCharacters = 900): string[] {
  const normalizedParagraph = normalizeWhitespacePreservingLineBreaks(paragraph);
  if (!normalizedParagraph) {
    return [];
  }

  if (/^!\[.*?\]\(data:image\/.*?;base64,[a-zA-Z0-9+/=]+\)$/iu.test(normalizedParagraph)) {
    return [normalizedParagraph];
  }

  if (normalizedParagraph.length <= maxCharacters) {
    return [normalizedParagraph];
  }

  if (normalizedParagraph.includes("\n")) {
    const lines = normalizedParagraph.split(/\n/u).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      return [];
    }

    const chunks: string[] = [];
    let currentChunk = "";

    for (const line of lines) {
      const candidate = currentChunk ? `${currentChunk}\n${line}` : line;
      if (candidate.length <= maxCharacters) {
        currentChunk = candidate;
        continue;
      }

      if (currentChunk) {
        chunks.push(currentChunk);
      }

      currentChunk = line;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  const sentences = normalizedParagraph.split(sentenceBoundaryExpression).map(normalizeWhitespace).filter(Boolean);
  if (sentences.length === 0) {
    return [normalizedParagraph.slice(0, maxCharacters), ...splitLongParagraph(normalizedParagraph.slice(maxCharacters), maxCharacters)];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const sentence of sentences) {
    const candidate = currentChunk ? `${currentChunk} ${sentence}` : sentence;
    if (candidate.length <= maxCharacters) {
      currentChunk = candidate;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = "";
    }

    if (sentence.length <= maxCharacters) {
      currentChunk = sentence;
      continue;
    }

    const words = sentence.split(/\s+/u);
    let currentWordChunk = "";
    for (const word of words) {
      const candidateWordChunk = currentWordChunk ? `${currentWordChunk} ${word}` : word;
      if (candidateWordChunk.length <= maxCharacters) {
        currentWordChunk = candidateWordChunk;
      } else {
        if (currentWordChunk) {
          chunks.push(currentWordChunk);
        }
        currentWordChunk = word;
      }
    }

    if (currentWordChunk) {
      currentChunk = currentWordChunk;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function sanitizeParagraphs(paragraphs: string[]): string[] {
  return paragraphs
    .flatMap((paragraph) => splitLongParagraph(paragraph))
    .map(normalizeWhitespacePreservingLineBreaks)
    .filter((paragraph) => normalizeWhitespace(paragraph).length > 0);
}

export function inferSourceType(fileName: string, mimeType: string): SupportedBookSourceType | null {
  const extension = extname(fileName).toLowerCase();

  if (mimeType === "application/pdf" || extension === ".pdf") {
    return "PDF";
  }

  if (mimeType === "application/epub+zip" || extension === ".epub") {
    return "EPUB";
  }

  return null;
}

export function deriveTitleFromFileName(fileName: string): string {
  const extension = extname(fileName);
  const baseName = extension ? fileName.slice(0, -extension.length) : fileName;
  return baseName.replace(/[_-]+/g, " ").trim();
}

export async function parseUploadedBook(sourceType: SupportedBookSourceType, fileBuffer: Buffer): Promise<ImportedDocument> {
  const importedDocument = sourceType === "PDF"
    ? await parsePdfBuffer(fileBuffer)
    : await parseEpubBuffer(fileBuffer);

  const pageNumberMap = new Map<number, number>();

  const normalizedPages = importedDocument.pages
    .map((page) => ({
      originalPageNumber: page.pageNumber,
      editedText: page.editedText?.trim() || null,
      htmlContent: page.htmlContent?.trim() || null,
      paragraphs: sanitizeParagraphs(page.paragraphs),
      rawText: page.rawText.trim()
    }))
    .filter((page) => Boolean(page.htmlContent) || page.paragraphs.length > 0 || page.rawText.length > 0)
    .map((page, index) => ({
      editedText: page.editedText,
      htmlContent: page.htmlContent,
      pageNumber: (() => {
        const normalizedPageNumber = index + 1;
        pageNumberMap.set(page.originalPageNumber, normalizedPageNumber);
        return normalizedPageNumber;
      })(),
      paragraphs: page.paragraphs,
      rawText: page.rawText
    }));

  const outlineEntries = (importedDocument.outlineEntries ?? []).reduce<ImportedOutlineEntry[]>((entries, entry) => {
    const mappedPageNumber = pageNumberMap.get(entry.pageNumber);
    const normalizedTitle = normalizeWhitespace(entry.title);

    if (!mappedPageNumber || !normalizedTitle) {
      return entries;
    }

    const normalizedEntry = {
      level: Math.min(6, Math.max(1, Math.trunc(entry.level) || 1)),
      pageNumber: mappedPageNumber,
      paragraphNumber: Math.max(1, Math.trunc(entry.paragraphNumber) || 1),
      title: normalizedTitle
    } satisfies ImportedOutlineEntry;

    const entryKey = `${normalizedEntry.pageNumber}:${normalizedEntry.paragraphNumber}:${normalizedEntry.title}`;
    if (entries.some((currentEntry) => `${currentEntry.pageNumber}:${currentEntry.paragraphNumber}:${currentEntry.title}` === entryKey)) {
      return entries;
    }

    entries.push(normalizedEntry);
    return entries;
  }, []);

  const totalParagraphs = normalizedPages.reduce((paragraphCount, page) => paragraphCount + page.paragraphs.length, 0);
  const hasRenderableContent = normalizedPages.some((page) => Boolean(page.htmlContent) || page.rawText.length > 0);

  if (normalizedPages.length === 0 || !hasRenderableContent) {
    throw Object.assign(new Error("No se ha podido extraer texto legible del archivo. Si es un PDF escaneado, el flujo OCR se implementará en el siguiente corte."), {
      statusCode: 422
    });
  }

  return {
    coverImage: importedDocument.coverImage ?? null,
    ...(outlineEntries.length > 0 ? { outlineEntries } : {}),
    pages: normalizedPages,
    totalPages: normalizedPages.length,
    totalParagraphs
  };
}