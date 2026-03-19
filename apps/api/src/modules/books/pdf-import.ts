import type { ImportedDocument, ImportedPage } from "./book-import.js";

type PdfTextItem = {
  str?: string;
  transform?: number[];
};

type PositionedTextItem = {
  text: string;
  x: number;
  y: number;
};

type PdfLine = {
  gapFromPrevious: number;
  text: string;
  y: number;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function buildLines(items: PositionedTextItem[]): PdfLine[] {
  const sortedItems = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > 2) {
      return right.y - left.y;
    }

    return left.x - right.x;
  });

  const groupedLines: Array<{ parts: PositionedTextItem[]; y: number }> = [];

  for (const item of sortedItems) {
    const lastLine = groupedLines[groupedLines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - item.y) > 2) {
      groupedLines.push({ parts: [item], y: item.y });
      continue;
    }

    lastLine.parts.push(item);
  }

  let previousY: number | null = null;

  return groupedLines
    .map((line) => {
      const sortedLineParts = [...line.parts].sort((left, right) => left.x - right.x);
      const lineText = normalizeWhitespace(sortedLineParts.map((part) => part.text).join(" "));
      const gapFromPrevious = previousY === null ? 0 : Math.abs(previousY - line.y);
      previousY = line.y;

      return {
        gapFromPrevious,
        text: lineText,
        y: line.y
      };
    })
    .filter((line) => line.text.length > 0);
}

function linesToParagraphs(lines: PdfLine[]): string[] {
  const paragraphs: string[] = [];
  let currentParagraph: string[] = [];

  for (const line of lines) {
    if (line.gapFromPrevious > 12 && currentParagraph.length > 0) {
      paragraphs.push(currentParagraph.join(" "));
      currentParagraph = [];
    }

    currentParagraph.push(line.text);
  }

  if (currentParagraph.length > 0) {
    paragraphs.push(currentParagraph.join(" "));
  }

  return paragraphs.map(normalizeWhitespace).filter(Boolean);
}

export async function parsePdfBuffer(fileBuffer: Buffer): Promise<ImportedDocument> {
  const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfDocument = await pdfModule.getDocument(new Uint8Array(fileBuffer)).promise;

  const pages: ImportedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const textItems = (textContent.items as PdfTextItem[])
      .map((item) => ({
        text: normalizeWhitespace(item.str ?? ""),
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0
      }))
      .filter((item) => item.text.length > 0);

    const lines = buildLines(textItems);
    const paragraphs = linesToParagraphs(lines);

    pages.push({
      pageNumber,
      paragraphs,
      rawText: lines.map((line) => line.text).join("\n")
    });
  }

  return {
    pages,
    totalPages: pages.length,
    totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
  };
}