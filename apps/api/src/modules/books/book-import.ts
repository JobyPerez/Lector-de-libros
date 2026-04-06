import { extname } from "node:path";

import { parseEpubBuffer } from "./epub-import.js";
import { parsePdfBuffer } from "./pdf-import.js";

export const supportedBookSourceTypes = ["PDF", "EPUB"] as const;

export type SupportedBookSourceType = (typeof supportedBookSourceTypes)[number];

export type ImportedPage = {
  htmlContent?: string | null;
  pageNumber: number;
  paragraphs: string[];
  rawText: string;
};

export type ImportedDocument = {
  pages: ImportedPage[];
  totalPages: number;
  totalParagraphs: number;
};

const sentenceBoundaryExpression = /(?<=[.!?;:])\s+/u;

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function splitLongParagraph(paragraph: string, maxCharacters = 900): string[] {
  const normalizedParagraph = normalizeWhitespace(paragraph);
  if (!normalizedParagraph) {
    return [];
  }

  if (normalizedParagraph.length <= maxCharacters) {
    return [normalizedParagraph];
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
    .map(normalizeWhitespace)
    .filter(Boolean);
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

  const normalizedPages = importedDocument.pages
    .map((page) => ({
      htmlContent: page.htmlContent?.trim() || null,
      paragraphs: sanitizeParagraphs(page.paragraphs),
      rawText: page.rawText.trim()
    }))
    .filter((page) => Boolean(page.htmlContent) || page.paragraphs.length > 0 || page.rawText.length > 0)
    .map((page, index) => ({
      htmlContent: page.htmlContent,
      pageNumber: index + 1,
      paragraphs: page.paragraphs,
      rawText: page.rawText
    }));

  const totalParagraphs = normalizedPages.reduce((paragraphCount, page) => paragraphCount + page.paragraphs.length, 0);
  const hasRenderableContent = normalizedPages.some((page) => Boolean(page.htmlContent) || page.rawText.length > 0);

  if (normalizedPages.length === 0 || !hasRenderableContent) {
    throw Object.assign(new Error("No se ha podido extraer texto legible del archivo. Si es un PDF escaneado, el flujo OCR se implementará en el siguiente corte."), {
      statusCode: 422
    });
  }

  return {
    pages: normalizedPages,
    totalPages: normalizedPages.length,
    totalParagraphs
  };
}