import type { ImportedDocument, ImportedPage } from "./book-import.js";
import { buildRichPageFromParagraphs } from "./rich-content.js";

type PdfTextItem = {
  height?: number;
  hasEOL?: boolean;
  str?: string;
  transform?: number[];
  width?: number;
};

type PositionedTextItem = {
  height: number;
  hasLineBreak: boolean;
  text: string;
  width: number;
  x: number;
  y: number;
};

type PdfLine = {
  gapFromPrevious: number;
  height: number;
  text: string;
  width: number;
  xEnd: number;
  xStart: number;
  y: number;
};

type PdfPageMetrics = {
  baseLeft: number;
  bodyLineWidth: number;
  dominantLineGap: number;
  headingGapThreshold: number;
  indentThreshold: number;
  paragraphBreakGap: number;
  typicalLineHeight: number;
};

const sameLineTolerance = 2;
const minimumFallbackParagraphGap = 14;
const headingKeywordPattern = /^(cap[ií]tulo|chapter|parte|section|pr[oó]logo|ep[ií]logo|prefacio|introducci[oó]n)\b/iu;
const standaloneDatePattern = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u;
const signatureLikePattern = /^[A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\p{L}'’-]+|[A-ZÁÉÍÓÚÑ]\.)){1,4}$/u;

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function computePercentile(values: number[], percentile: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  const clampedPercentile = Math.min(1, Math.max(0, percentile));
  const position = (sortedValues.length - 1) * clampedPercentile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sortedValues[lowerIndex] ?? 0;
  }

  const lowerValue = sortedValues[lowerIndex] ?? 0;
  const upperValue = sortedValues[upperIndex] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (position - lowerIndex);
}

function computeMedian(values: number[]): number {
  return computePercentile(values, 0.5);
}

function countUppercaseRatio(value: string): number {
  const uppercaseLetters = value.replace(/[^A-ZÁÉÍÓÚÑ]/gu, "");
  const totalLetters = value.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/gu, "").length;
  return totalLetters > 0 ? uppercaseLetters.length / totalLetters : 0;
}

function countTitleCaseWords(words: string[]): number {
  return words.filter((word) => /^[A-ZÁÉÍÓÚÑ][\p{Ll}\d'’-]*$/u.test(word)).length;
}

function endsWithSentencePunctuation(value: string): boolean {
  return /[.!?:;]$/u.test(value);
}

function startsWithLowercaseLetter(value: string): boolean {
  return /^\p{Ll}/u.test(value);
}

function isHeadingLikeText(text: string, allowTitleCase = true): boolean {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return false;
  }

  if (standaloneDatePattern.test(normalized) || signatureLikePattern.test(normalized) || endsWithSentencePunctuation(normalized)) {
    return false;
  }

  const words = normalized.split(/\s+/u);
  if (words.length > 10 || normalized.length > 80) {
    return false;
  }

  if (headingKeywordPattern.test(normalized)) {
    return true;
  }

  if (countUppercaseRatio(normalized) >= 0.75 && words.length <= 8) {
    return true;
  }

  if (!allowTitleCase) {
    return false;
  }

  return words.length <= 6
    && normalized.length <= 60
    && countTitleCaseWords(words) >= Math.max(2, words.length - 1);
}

function joinLines(lines: PdfLine[]): string {
  let mergedText = "";

  for (const line of lines) {
    const normalizedLine = normalizeWhitespace(line.text);
    if (!normalizedLine) {
      continue;
    }

    if (!mergedText) {
      mergedText = normalizedLine;
      continue;
    }

    if (/[\p{L}\p{N}]-$/u.test(mergedText) && startsWithLowercaseLetter(normalizedLine)) {
      mergedText = `${mergedText.slice(0, -1)}${normalizedLine}`;
      continue;
    }

    mergedText = `${mergedText} ${normalizedLine}`;
  }

  return normalizeWhitespace(mergedText);
}

function buildPageMetrics(lines: PdfLine[]): PdfPageMetrics {
  const positiveGaps = lines.map((line) => line.gapFromPrevious).filter((gap) => gap > 0);
  const dominantLineGap = Math.max(computeMedian(positiveGaps), 6);
  const lineHeights = lines.map((line) => line.height).filter((height) => height > 0);
  const typicalLineHeight = Math.max(computeMedian(lineHeights), dominantLineGap * 0.85, 8);
  const lineWidths = lines.map((line) => line.width).filter((width) => width > 0);
  const bodyLineWidth = Math.max(computePercentile(lineWidths, 0.85), computeMedian(lineWidths), 1);
  const baselineCandidates = lines.filter((line) => line.width >= bodyLineWidth * 0.7);
  const baseLeft = baselineCandidates.length > 0
    ? computeMedian(baselineCandidates.map((line) => line.xStart))
    : computeMedian(lines.map((line) => line.xStart));

  return {
    baseLeft,
    bodyLineWidth,
    dominantLineGap,
    headingGapThreshold: Math.max(dominantLineGap * 1.1, dominantLineGap + typicalLineHeight * 0.15, 10),
    indentThreshold: Math.max(typicalLineHeight * 0.75, 8),
    paragraphBreakGap: Math.max(dominantLineGap * 1.65, dominantLineGap + typicalLineHeight * 0.4, minimumFallbackParagraphGap),
    typicalLineHeight
  };
}

function isStandaloneHeadingLine(lines: PdfLine[], lineIndex: number, metrics: PdfPageMetrics): boolean {
  const line = lines[lineIndex];
  if (!line) {
    return false;
  }

  const normalizedText = normalizeWhitespace(line.text);
  if (!isHeadingLikeText(normalizedText, true)) {
    return false;
  }

  const widthRatio = metrics.bodyLineWidth > 0 ? line.width / metrics.bodyLineWidth : 1;
  const gapBelow = lines[lineIndex + 1]?.gapFromPrevious ?? 0;
  const hasVisualSeparation = line.gapFromPrevious >= metrics.headingGapThreshold || gapBelow >= metrics.headingGapThreshold;
  const isTopOfPage = lineIndex === 0;
  const isShortVisualLine = widthRatio <= 0.82;

  if (headingKeywordPattern.test(normalizedText)) {
    return isTopOfPage || isShortVisualLine || hasVisualSeparation;
  }

  if (countUppercaseRatio(normalizedText) >= 0.75) {
    return isTopOfPage || isShortVisualLine || hasVisualSeparation;
  }

  return isShortVisualLine && (isTopOfPage || hasVisualSeparation);
}

function canExtendHeadingCluster(lines: PdfLine[], lineIndex: number, metrics: PdfPageMetrics, seedText: string): boolean {
  const line = lines[lineIndex];
  if (!line) {
    return false;
  }

  const normalizedText = normalizeWhitespace(line.text);
  if (!normalizedText || endsWithSentencePunctuation(normalizedText)) {
    return false;
  }

  const words = normalizedText.split(/\s+/u);
  if (words.length > 8 || normalizedText.length > 60) {
    return false;
  }

  const widthRatio = metrics.bodyLineWidth > 0 ? line.width / metrics.bodyLineWidth : 1;
  if (widthRatio > 0.82) {
    return false;
  }

  if (isHeadingLikeText(normalizedText, true)) {
    return true;
  }

  return headingKeywordPattern.test(seedText);
}

function collectHeadingParagraph(lines: PdfLine[], startIndex: number, metrics: PdfPageMetrics): { endIndex: number; text: string } {
  const startLine = lines[startIndex];
  if (!startLine) {
    return {
      endIndex: startIndex,
      text: ""
    };
  }

  const headingLines: PdfLine[] = [startLine];
  let endIndex = startIndex;
  const seedText = normalizeWhitespace(startLine.text);

  while (endIndex + 1 < lines.length) {
    const candidateLine = lines[endIndex + 1];
    if (!candidateLine || candidateLine.gapFromPrevious > metrics.paragraphBreakGap) {
      break;
    }

    if (!canExtendHeadingCluster(lines, endIndex + 1, metrics, seedText)) {
      break;
    }

    const nextHeadingCandidate = joinLines([...headingLines, candidateLine]);
    if (nextHeadingCandidate.length > 120) {
      break;
    }

    headingLines.push(candidateLine);
    endIndex += 1;
  }

  return {
    endIndex,
    text: joinLines(headingLines)
  };
}

function shouldStartNewParagraph(previousLine: PdfLine, currentLine: PdfLine, metrics: PdfPageMetrics): boolean {
  if (currentLine.gapFromPrevious >= metrics.paragraphBreakGap) {
    return true;
  }

  const indentOffset = currentLine.xStart - metrics.baseLeft;
  if (indentOffset >= metrics.indentThreshold && previousLine.width >= metrics.bodyLineWidth * 0.65) {
    return true;
  }

  if (endsWithSentencePunctuation(previousLine.text) && indentOffset >= metrics.indentThreshold * 0.5) {
    return true;
  }

  return false;
}

function buildLines(items: PositionedTextItem[]): PdfLine[] {
  const sortedItems = [...items].sort((left, right) => {
    if (Math.abs(left.y - right.y) > sameLineTolerance) {
      return right.y - left.y;
    }

    return left.x - right.x;
  });

  const groupedLines: Array<{ parts: PositionedTextItem[]; y: number }> = [];

  for (const item of sortedItems) {
    const lastLine = groupedLines[groupedLines.length - 1];
    if (!lastLine || Math.abs(lastLine.y - item.y) > sameLineTolerance) {
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
      const xStart = Math.min(...sortedLineParts.map((part) => part.x));
      const xEnd = Math.max(...sortedLineParts.map((part) => part.x + Math.max(part.width, Math.max(part.height * 0.45, 4) * Math.max(part.text.length, 1))));
      const lineHeight = Math.max(computeMedian(sortedLineParts.map((part) => part.height).filter((height) => height > 0)), 0);
      const gapFromPrevious = previousY === null ? 0 : Math.abs(previousY - line.y);
      previousY = line.y;

      return {
        gapFromPrevious,
        height: lineHeight,
        text: lineText,
        width: Math.max(xEnd - xStart, lineText.length * Math.max(lineHeight * 0.35, 3)),
        xEnd,
        xStart,
        y: line.y
      };
    })
    .filter((line) => line.text.length > 0);
}

function linesToParagraphs(lines: PdfLine[]): string[] {
  if (lines.length === 0) {
    return [];
  }

  const metrics = buildPageMetrics(lines);
  const paragraphs: string[] = [];

  let currentParagraphLines: PdfLine[] = [];

  const flushParagraph = () => {
    if (currentParagraphLines.length === 0) {
      return;
    }

    paragraphs.push(joinLines(currentParagraphLines));
    currentParagraphLines = [];
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) {
      continue;
    }

    if (isStandaloneHeadingLine(lines, lineIndex, metrics)) {
      flushParagraph();
      const headingParagraph = collectHeadingParagraph(lines, lineIndex, metrics);
      if (headingParagraph.text) {
        paragraphs.push(headingParagraph.text);
      }
      lineIndex = headingParagraph.endIndex;
      continue;
    }

    const previousLine = currentParagraphLines[currentParagraphLines.length - 1];
    if (previousLine && shouldStartNewParagraph(previousLine, line, metrics)) {
      flushParagraph();
    }

    currentParagraphLines.push(line);
  }

  flushParagraph();

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
        hasLineBreak: Boolean(item.hasEOL),
        height: Math.max(Math.abs(item.height ?? 0), Math.abs(item.transform?.[3] ?? 0), 0),
        text: normalizeWhitespace(item.str ?? ""),
        width: Math.abs(item.width ?? 0),
        x: item.transform?.[4] ?? 0,
        y: item.transform?.[5] ?? 0
      }))
      .filter((item) => item.text.length > 0);

    const lines = buildLines(textItems);
    const paragraphs = linesToParagraphs(lines);
    const richContent = buildRichPageFromParagraphs(paragraphs);

    pages.push({
      htmlContent: richContent.htmlContent,
      pageNumber,
      paragraphs: richContent.paragraphs,
      rawText: richContent.rawText || lines.map((line) => line.text).join("\n")
    });
  }

  return {
    pages,
    totalPages: pages.length,
    totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
  };
}