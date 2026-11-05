import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { BookImportProgressCallback, ImportedDocument, ImportedOutlineEntry, ImportedPage } from "./book-import.js";
import { buildRichPageFromParagraphs } from "./rich-content.js";
import { extractPdfImages, pdfImageGeometries } from "./pdf-images.js";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { annotatePageElementHtml, type Geometry, type PageElementRole } from "./page-elements.js";
import { sanitizeParagraphs } from "./book-import.js";
import { pdfAssetOptions } from "./pdf-options.js";

type PositionedTextItem = {
  geometry?: Geometry;
  height: number;
  hasLineBreak: boolean;
  text: string;
  width: number;
  x: number;
  y: number;
};

type PdfLine = {
  items?: PositionedTextItem[];
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

type PdfOutlineItem = {
  dest?: unknown;
  items?: PdfOutlineItem[];
  title?: string;
};

type PdfOutlineDocument = {
  getDestination: (destinationId: string) => Promise<unknown>;
  getOutline: () => Promise<PdfOutlineItem[] | null>;
  getPageIndex: (reference: never) => Promise<number>;
};

const sameLineTolerance = 2;

// Preserve the detected column-by-column text order. Images are anchored to
// nearby text in their own horizontal region, not appended after every column.
export function orderPdfImages<T extends { geometry?: Geometry | null | undefined; image: boolean }>(entries: T[]): T[] {
  const result = entries.filter((entry) => !entry.image || !entry.geometry);
  const images = entries.filter((entry) => entry.image && entry.geometry)
    .sort((a, b) => a.geometry!.bbox.top - b.geometry!.bbox.top || a.geometry!.bbox.left - b.geometry!.bbox.left);
  for (const image of images) {
    const box = image.geometry!.bbox;
    const overlaps = (entry: T) => {
      const other = entry.geometry?.bbox;
      return other && Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left) > Math.min(box.width, other.width) * 0.3;
    };
    let index = result.findIndex((entry) => overlaps(entry) && entry.geometry!.bbox.top >= box.top + box.height - 0.005);
    if (index < 0) {
      let previous = -1;
      for (let i = result.length - 1; i >= 0; i--) {
        if (overlaps(result[i]!) && result[i]!.geometry!.bbox.top + result[i]!.geometry!.bbox.height <= box.top + 0.005) { previous = i; break; }
      }
      index = previous < 0 ? result.length : previous + 1;
    }
    result.splice(index, 0, image);
  }
  return result;
}
const minimumFallbackParagraphGap = 14;
const headingKeywordPattern = /^(cap[ií]tulo|capitolo|chapter|parte|section|sezione|pr[oó]logo|ep[ií]logo|prefacio|prefazione|introducci[oó]n|introduzione)\b/iu;
const standaloneDatePattern = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u;
const signatureLikePattern = /^\p{Lu}[\p{L}'’-]+(?:\s+(?:\p{Lu}[\p{L}'’-]+|\p{Lu}\.)){1,4}$/u;
const pageNumberPattern = /^(?:-?\s*\d+\s*-?|P[aá]gina\s*\d+|P[aá]g\.\s*\d+|\d+\s*\/\s*\d+)$/iu;

export function isPdfPageNumberLine(text: string): boolean {
  return pageNumberPattern.test(text.trim());
}

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
  const uppercaseLetters = value.match(/\p{Lu}/gu)?.length ?? 0;
  const totalLetters = value.match(/\p{L}/gu)?.length ?? 0;
  return totalLetters > 0 ? uppercaseLetters / totalLetters : 0;
}

function countTitleCaseWords(words: string[]): number {
  return words.filter((word) => /^\p{Lu}[\p{Ll}\d'’-]*$/u.test(word)).length;
}

function endsWithSentencePunctuation(value: string): boolean {
  return /[.!?:;]$/u.test(value);
}

function startsWithLowercaseLetter(value: string): boolean {
  return /^\p{Ll}/u.test(value);
}

function isStandaloneQuotedLine(value: string): boolean {
  const normalized = normalizeWhitespace(value);
  return /^["“][^"”]{1,120}["”]$/u.test(normalized);
}

function startsNewDialogue(value: string): boolean {
  return /^—\S/u.test(normalizeWhitespace(value));
}

function startsNewSentenceLike(value: string): boolean {
  return /^["“¿¡\p{Lu}]/u.test(normalizeWhitespace(value));
}

function shouldPreserveLineBreak(previousLine: PdfLine, currentLine: PdfLine, bodyLineWidth: number): boolean {
  const previousText = normalizeWhitespace(previousLine.text);
  const currentText = normalizeWhitespace(currentLine.text);

  if (startsNewDialogue(currentText) || isStandaloneQuotedLine(previousText) || isStandaloneQuotedLine(currentText)) {
    return true;
  }

  const previousLineIsShort = bodyLineWidth > 0 && previousLine.width <= bodyLineWidth * 0.58;
  return previousLineIsShort && endsWithSentencePunctuation(previousText) && startsNewSentenceLike(currentText);
}

export function isPdfHeadingLikeText(text: string, allowTitleCase = true): boolean {
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
  let previousLine: PdfLine | null = null;
  const bodyLineWidth = Math.max(computePercentile(lines.map((line) => line.width).filter((width) => width > 0), 0.85), 1);

  for (const line of lines) {
    const normalizedLine = normalizeWhitespace(line.text);
    if (!normalizedLine) {
      continue;
    }

    if (!mergedText) {
      mergedText = normalizedLine;
      previousLine = line;
      continue;
    }

    const previousText = previousLine ? normalizeWhitespace(previousLine.text) : mergedText.split("\n").at(-1) ?? mergedText;

    if (/[\p{L}\p{N}]-$/u.test(previousText) && startsWithLowercaseLetter(normalizedLine)) {
      mergedText = `${mergedText.slice(0, -1)}${normalizedLine}`;
      previousLine = line;
      continue;
    }

    const separator = previousLine && shouldPreserveLineBreak(previousLine, line, bodyLineWidth) ? "\n" : " ";
    mergedText = `${mergedText}${separator}${normalizedLine}`;
    previousLine = line;
  }

  return normalizeWhitespacePreservingLineBreaks(mergedText);
}

function joinLinesPreservingLineBreaks(lines: PdfLine[]): string {
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

    mergedText = `${mergedText}\n${normalizedLine}`;
  }

  return mergedText.trim();
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
  if (!isPdfHeadingLikeText(normalizedText, true)) {
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

  if (isPdfHeadingLikeText(normalizedText, true)) {
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

function isVerseLikeParagraph(lines: PdfLine[], metrics: PdfPageMetrics): boolean {
  if (lines.length < 3) {
    return false;
  }

  const normalizedLines = lines.map((line) => normalizeWhitespace(line.text)).filter(Boolean);
  const lineCharacterCounts = normalizedLines.map((line) => line.length);
  const averageLineCharacters = lineCharacterCounts.reduce((sum, count) => sum + count, 0) / Math.max(lineCharacterCounts.length, 1);
  const shortCharacterLineCount = lineCharacterCounts.filter((count) => count <= 42).length;
  const mediumCharacterLineCount = lineCharacterCounts.filter((count) => count <= 54).length;
  const widthRatios = lines.map((line) => (metrics.bodyLineWidth > 0 ? line.width / metrics.bodyLineWidth : 1));
  const shortLineCount = widthRatios.filter((ratio) => ratio <= 0.78).length;
  const nearFullLineCount = widthRatios.filter((ratio) => ratio >= 0.9).length;
  const averageRatio = widthRatios.reduce((sum, ratio) => sum + ratio, 0) / Math.max(widthRatios.length, 1);
  const variableWidthTransitions = widthRatios.slice(0, -1).filter((ratio, index) => {
    const nextRatio = widthRatios[index + 1] ?? ratio;
    return Math.abs(nextRatio - ratio) >= 0.16;
  }).length;
  const nonTerminalLineCount = normalizedLines
    .slice(0, -1)
    .filter((line) => !endsWithSentencePunctuation(line)).length;
  const wrappedProseLineCount = lines
    .slice(0, -1)
    .filter((line, index) => (widthRatios[index] ?? 0) >= 0.72 && !endsWithSentencePunctuation(normalizedLines[index] ?? ""))
    .length;

  if (
    startsNewDialogue(normalizedLines[0] ?? "")
    && normalizedLines.slice(1).every((line) => !startsNewDialogue(line))
    && nonTerminalLineCount >= 2
  ) {
    return false;
  }

  if (wrappedProseLineCount >= lines.length - 1 && endsWithSentencePunctuation(normalizedLines[normalizedLines.length - 1] ?? "")) {
    return false;
  }

  if (nearFullLineCount >= Math.max(2, lines.length - 1) && shortLineCount <= 1) {
    return false;
  }

  if (
    averageLineCharacters <= 42
    && mediumCharacterLineCount >= Math.max(3, normalizedLines.length - 1)
    && nonTerminalLineCount >= Math.max(2, normalizedLines.length - 2)
  ) {
    return true;
  }

  if (
    shortCharacterLineCount >= Math.max(2, Math.ceil(normalizedLines.length * 0.6))
    && nonTerminalLineCount >= Math.max(2, normalizedLines.length - 2)
  ) {
    return true;
  }

  if (shortLineCount >= Math.max(2, Math.ceil(lines.length * 0.5)) && nearFullLineCount <= Math.floor(lines.length / 2)) {
    return true;
  }

  return averageRatio <= 0.84
    && variableWidthTransitions >= Math.max(2, Math.floor(lines.length / 2))
    && nonTerminalLineCount >= Math.max(2, lines.length - 2);
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
      let rawLineText = "";
      let previousPartEnd: number | null = null;

      for (const part of sortedLineParts) {
        const estimatedPartWidth = Math.max(part.width, Math.max(part.height * 0.45, 4) * Math.max(part.text.length, 1));
        const gapFromPreviousPart = previousPartEnd === null ? 0 : part.x - previousPartEnd;
        const visualSpaceThreshold = Math.max(part.height * 0.2, 1.5);

        if (rawLineText && gapFromPreviousPart > visualSpaceThreshold) {
          rawLineText += " ";
        }

        rawLineText += part.text;
        previousPartEnd = part.x + estimatedPartWidth;
      }

      const lineText = normalizeWhitespace(rawLineText);
      const xStart = Math.min(...sortedLineParts.map((part) => part.x));
      const xEnd = Math.max(...sortedLineParts.map((part) => part.x + Math.max(part.width, Math.max(part.height * 0.45, 4) * Math.max(part.text.length, 1))));
      const lineHeight = Math.max(computeMedian(sortedLineParts.map((part) => part.height).filter((height) => height > 0)), 0);
      const gapFromPrevious = previousY === null ? 0 : Math.abs(previousY - line.y);
      previousY = line.y;

      return {
        items: sortedLineParts,
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

// Find a recurring *empty* vertical gutter, not just text at similar baselines.
// Full-width headings separate column bands so they stay above the text they head.
function buildReadingRegions(items: PositionedTextItem[]): PositionedTextItem[][] {
  if (items.length === 0) return [];
  const height = Math.max(6, computeMedian(items.map((item) => item.height)));
  const minimumGap = height * 1.2;
  const rows: PositionedTextItem[][] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const row = rows.at(-1);
    if (!row || Math.abs(row[0]!.y - item.y) > sameLineTolerance) rows.push([item]);
    else row.push(item);
  }
  const left = Math.min(...items.map((item) => item.x));
  const right = Math.max(...items.map((item) => item.x + item.width));
  const gaps: { left: number; right: number; row: number }[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    row.sort((a, b) => a.x - b.x);
    let end = row[0]!.x + row[0]!.width;
    for (let index = 1; index < row.length; index++) {
      const item = row[index]!;
      if (item.x - end >= minimumGap
        && end > left + (right - left) * 0.2 && item.x < right - (right - left) * 0.2
        && row.slice(0, index).map((part) => part.text).join("").length >= 10
        && row.slice(index).map((part) => part.text).join("").length >= 10) {
        gaps.push({ left: end, right: item.x, row: rowIndex });
      }
      end = Math.max(end, item.x + item.width);
    }
  }
  let gutter: number | undefined;
  let support = 0;
  for (const gap of gaps) {
    const candidate = (gap.left + gap.right) / 2;
    const count = new Set(gaps.filter((other) => other.left <= candidate && other.right >= candidate).map((other) => other.row)).size;
    if (count > support) {
      support = count;
      gutter = candidate;
    }
  }
  // Different font sizes (e.g. sidebars) need not share any baselines. A
  // recurring right-column start is also a candidate, provided almost no body
  // text crosses its gutter. Single-column indentation must not qualify.
  if (support < Math.max(3, rows.length * 0.12)) {
    const body = items.filter((item) => item.text.length >= 10 && item.width >= height * 5);
    let best = 0;
    for (const item of body) {
      const candidate = item.x - minimumGap / 2;
      if (candidate < left + (right - left) * 0.25 || candidate > right - (right - left) * 0.25) continue;
      const before = body.filter((part) => part.x + part.width <= candidate);
      const after = body.filter((part) => part.x >= candidate + minimumGap / 2);
      const crossing = body.filter((part) => part.x < candidate && part.x + part.width > candidate);
      const count = Math.min(before.length, after.length);
      if (count >= 3 && count >= body.length * 0.2 && crossing.length <= Math.max(1, body.length * 0.08) && count > best) {
        best = count;
        gutter = candidate;
        support = rows.length;
      }
    }
  }
  if (gutter === undefined || support < Math.max(3, rows.length * 0.12)) return [items];
  const split = gutter;
  const regions: PositionedTextItem[][] = [];
  let leftColumn: PositionedTextItem[] = [];
  let rightColumn: PositionedTextItem[] = [];
  const flush = () => {
    if (leftColumn.length) regions.push(leftColumn);
    if (rightColumn.length) regions.push(rightColumn);
    leftColumn = [];
    rightColumn = [];
  };
  for (const row of rows) {
    if (row.some((item) => item.x < split && item.x + item.width > split)) {
      flush();
      regions.push(row);
    } else {
      leftColumn.push(...row.filter((item) => item.x < split));
      rightColumn.push(...row.filter((item) => item.x >= split));
    }
  }
  flush();
  return regions;
}

function linesToParagraphs(lines: PdfLine[], onParagraph?: (text: string, lines: PdfLine[]) => void): string[] {
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

    const text = isVerseLikeParagraph(currentParagraphLines, metrics)
        ? joinLinesPreservingLineBreaks(currentParagraphLines)
        : joinLines(currentParagraphLines);
    paragraphs.push(text);
    onParagraph?.(text, currentParagraphLines);
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
        onParagraph?.(headingParagraph.text, lines.slice(lineIndex, headingParagraph.endIndex + 1));
      }
      lineIndex = headingParagraph.endIndex;
      continue;
    }

    const previousLine = currentParagraphLines[currentParagraphLines.length - 1];
    if (previousLine && shouldStartNewParagraph(previousLine, line, metrics)) {
      flushParagraph();
    }

    // Keep native editable blocks reasonably sized without assigning every
    // split of a long paragraph the same page-wide bounding box.
    if (currentParagraphLines.length && currentParagraphLines.reduce((length, item) => length + item.text.length + 1, 0) + line.text.length > 850) flushParagraph();

    currentParagraphLines.push(line);
  }

  flushParagraph();

  return paragraphs
    .map((paragraph) => paragraph.replace(/\u00a0/g, " ").trim())
    .filter((paragraph) => normalizeWhitespace(paragraph).length > 0);
}

export type PdfDetectedBlock = { text: string; geometry: Geometry; role: PageElementRole; headingLevel?: number };

function unionGeometry(boxes: Geometry[]): Geometry {
  const left = Math.max(0, Math.min(...boxes.map((box) => box.bbox.left)));
  const top = Math.max(0, Math.min(...boxes.map((box) => box.bbox.top)));
  return { bbox: { left, top,
    width: Math.max(0.000001, Math.min(1, Math.max(...boxes.map((box) => box.bbox.left + box.bbox.width))) - left),
    height: Math.max(0.000001, Math.min(1, Math.max(...boxes.map((box) => box.bbox.top + box.bbox.height))) - top) } };
}

/** Native PDF analysis: no OCR/provider call, all coordinates use the rendered viewport. */
export async function analyzePdfPage(page: PDFPageProxy, repeatedMargins: ReadonlySet<string> = new Set()): Promise<PdfDetectedBlock[]> {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items: PositionedTextItem[] = content.items.flatMap((value) => {
    if (!("str" in value) || !normalizeWhitespace(value.str)) return [];
    const height = Math.max(Math.abs(value.height), Math.hypot(value.transform[2] ?? 0, value.transform[3] ?? 0), 1);
    const x = value.transform[4] ?? 0;
    const y = value.transform[5] ?? 0;
    const rectangle = viewport.convertToViewportRectangle([x, y - height * 0.2, x + Math.abs(value.width), y + height * 0.8]);
    const left = Math.max(0, Math.min(1, Math.min(rectangle[0]!, rectangle[2]!) / viewport.width));
    const top = Math.max(0, Math.min(1, Math.min(rectangle[1]!, rectangle[3]!) / viewport.height));
    const right = Math.max(left, Math.min(1, Math.max(rectangle[0]!, rectangle[2]!) / viewport.width));
    const bottom = Math.max(top, Math.min(1, Math.max(rectangle[1]!, rectangle[3]!) / viewport.height));
    if (right <= left || bottom <= top) return [];
    return [{ hasLineBreak: value.hasEOL, text: normalizeWhitespace(value.str), height, width: (right - left) * viewport.width,
      x: left * viewport.width, y: viewport.height * (1 - top) - height * 0.8,
      geometry: { bbox: { left, top, width: right - left, height: bottom - top } } }];
  });
  const bodyHeight = Math.max(6, computeMedian(items.filter((item) => item.text.length > 15).map((item) => item.height)) || computeMedian(items.map((item) => item.height)));
  const blocks: PdfDetectedBlock[] = [];
  const add = (text: string, lines: PdfLine[], forcedRole?: PageElementRole) => {
    const source = lines.flatMap((line) => line.items ?? []);
    const boxes = source.flatMap((item) => item.geometry ? [item.geometry] : []);
    if (!boxes.length) return;
    const geometry = unionGeometry(boxes);
    const height = computeMedian(source.map((item) => item.height));
    const short = text.length < 200;
    const margin = geometry.bbox.top < 0.2 || geometry.bbox.top + geometry.bbox.height > 0.8;
    const repeated = repeatedMargins.has(normalizePdfMargin(text));
    const role = forcedRole ?? (isPdfPageNumberLine(text) && margin ? "pageNumber"
      : short && margin && (repeated || height <= bodyHeight * 0.9 && (geometry.bbox.top < 0.055 || geometry.bbox.top > 0.93)) ? (geometry.bbox.top < 0.5 ? "header" : "footer")
      : text.length < 180 && (height >= bodyHeight * 1.12 || headingKeywordPattern.test(text)) ? "heading" : "body");
    const headingLevel = role === "heading" ? (height >= bodyHeight * 1.65 || headingKeywordPattern.test(text) ? 1 : height >= bodyHeight * 1.35 ? 2 : 3) : undefined;
    for (const part of sanitizeParagraphs([text])) blocks.push({ text: part, geometry, role, ...(headingLevel ? { headingLevel } : {}) });
  };
  // Margins are classified separately, never merged into a body paragraph or column.
  const folios = items.filter((item) => item.geometry && isPdfPageNumberLine(item.text) && (item.geometry.bbox.top < 0.07 || item.geometry.bbox.top > 0.91));
  const marginItems = items.filter((item) => item.geometry && item.text.length < 180
    && (item.geometry.bbox.top < 0.07 || item.geometry.bbox.top > 0.91)
    && (item.height <= bodyHeight * 0.9 || repeatedMargins.has(normalizePdfMargin(item.text)) || folios.some((folio) => Math.abs(folio.y - item.y) <= sameLineTolerance)));
  const marginSet = new Set(marginItems);
  const headers = marginItems.filter((item) => item.geometry!.bbox.top < 0.5);
  const footers = marginItems.filter((item) => item.geometry!.bbox.top >= 0.5);
  for (const line of buildLines(headers)) add(line.text, [line], isPdfPageNumberLine(line.text) ? "pageNumber" : "header");
  for (const region of buildReadingRegions(items.filter((item) => !marginSet.has(item)))) {
    const lines = buildLines(region);
    let body: PdfLine[] = [];
    const flushBody = () => { linesToParagraphs(body, add); body = []; };
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line.height >= bodyHeight * 1.12 && line.text.length < 180) {
        flushBody();
        const heading = [line];
        while (lines[index + 1] && lines[index + 1]!.height >= bodyHeight * 1.12
          && lines[index + 1]!.gapFromPrevious < line.height * 1.7 && heading.map((item) => item.text).join(" ").length + lines[index + 1]!.text.length < 180) heading.push(lines[++index]!);
        add(joinLines(heading), heading, "heading");
      } else body.push(line);
    }
    flushBody();
  }
  for (const line of buildLines(footers)) add(line.text, [line], isPdfPageNumberLine(line.text) ? "pageNumber" : "footer");
  return blocks;
}

export function normalizePdfMargin(text: string): string {
  return normalizeWhitespace(text).toLocaleLowerCase("es").replace(/\d+/gu, "#");
}

function normalizeOutlineTitle(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase("es");
}

function resolveOutlineParagraphNumber(title: string, page: ImportedPage | undefined): number {
  if (!page || page.paragraphs.length === 0) {
    return 1;
  }

  const normalizedTitle = normalizeOutlineTitle(title);
  if (!normalizedTitle) {
    return 1;
  }

  const normalizedParagraphs = page.paragraphs.map((paragraph) => normalizeOutlineTitle(paragraph.replace(/\n+/gu, " ")));
  const exactMatchIndex = normalizedParagraphs.findIndex((paragraph) => paragraph === normalizedTitle);
  if (exactMatchIndex >= 0) {
    return exactMatchIndex + 1;
  }

  const prefixMatchIndex = normalizedParagraphs.findIndex((paragraph) => paragraph.startsWith(normalizedTitle));
  if (prefixMatchIndex >= 0) {
    return prefixMatchIndex + 1;
  }

  const inclusiveMatchIndex = normalizedParagraphs.findIndex((paragraph) => {
    return normalizedTitle.length >= 6
      && (paragraph.includes(normalizedTitle) || normalizedTitle.includes(paragraph));
  });
  if (inclusiveMatchIndex >= 0) {
    return inclusiveMatchIndex + 1;
  }

  return 1;
}

async function resolvePdfOutlinePageNumber(pdfDocument: PdfOutlineDocument, destination: unknown): Promise<number | null> {
  if (!destination) {
    return null;
  }

  const explicitDestination = Array.isArray(destination)
    ? destination
    : typeof destination === "string"
      ? await pdfDocument.getDestination(destination)
      : null;

  if (!Array.isArray(explicitDestination) || explicitDestination.length === 0) {
    return null;
  }

  const target = explicitDestination[0];
  if (typeof target === "number" && Number.isInteger(target)) {
    return target + 1;
  }

  if (!target || typeof target !== "object") {
    return null;
  }

  try {
    return (await pdfDocument.getPageIndex(target as never)) + 1;
  } catch {
    return null;
  }
}

async function collectPdfOutlineEntries(
  pdfDocument: PdfOutlineDocument,
  outlineItems: PdfOutlineItem[],
  pages: ImportedPage[],
  level = 1,
  entries: ImportedOutlineEntry[] = [],
  seenKeys: Set<string> = new Set()
): Promise<ImportedOutlineEntry[]> {
  for (const outlineItem of outlineItems) {
    const normalizedTitle = normalizeWhitespace(outlineItem.title ?? "");
    if (normalizedTitle) {
      const pageNumber = await resolvePdfOutlinePageNumber(pdfDocument, outlineItem.dest);
      if (pageNumber && pageNumber >= 1) {
        const page = pages.find((currentPage) => currentPage.pageNumber === pageNumber);
        const paragraphNumber = resolveOutlineParagraphNumber(normalizedTitle, page);
        const dedupeKey = `${pageNumber}:${paragraphNumber}:${normalizedTitle.toLocaleLowerCase("es")}`;

        if (!seenKeys.has(dedupeKey)) {
          seenKeys.add(dedupeKey);
          entries.push({
            level: Math.max(1, Math.min(6, level)),
            pageNumber,
            paragraphNumber,
            title: normalizedTitle
          });
        }
      }
    }

    if (Array.isArray(outlineItem.items) && outlineItem.items.length > 0) {
      await collectPdfOutlineEntries(pdfDocument, outlineItem.items, pages, level + 1, entries, seenKeys);
    }
  }

  return entries;
}

async function extractPdfOutlineEntries(
  pdfDocument: PdfOutlineDocument,
  pages: ImportedPage[]
): Promise<ImportedOutlineEntry[]> {
  try {
    const outline = await pdfDocument.getOutline();
    if (!outline || outline.length === 0) {
      return [];
    }

    return collectPdfOutlineEntries(pdfDocument, outline as PdfOutlineItem[], pages);
  } catch {
    return [];
  }
}

export async function parsePdfBuffer(fileBuffer: Buffer, onProgress?: BookImportProgressCallback): Promise<ImportedDocument> {
  onProgress?.({ completedUnits: null, message: "Abriendo el PDF...", progress: 0, totalUnits: null, unit: null });
  const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdfDocument = await pdfModule.getDocument({ data: new Uint8Array(fileBuffer), ...pdfAssetOptions }).promise.catch((error: unknown) => {
    if (error instanceof Error && error.name === "InvalidPDFException") {
      throw Object.assign(new Error("No se puede abrir el PDF: su estructura no es válida o el archivo está incompleto. Comprueba que se abre correctamente y vuelve a descargarlo o expórtalo de nuevo como PDF."), {
        statusCode: 422
      });
    }
    throw error;
  });

  let temporaryDirectory: string | undefined;
  const cleanup = async (): Promise<void> => {
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  };

  try {
    let hasExtractableText = false;
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent();
      hasExtractableText = content.items.some((item) => "str" in item && normalizeWhitespace(item.str).length > 0);
      page.cleanup();
      onProgress?.({
        completedUnits: pageNumber,
        message: `Analizando texto de la página ${pageNumber} de ${pdfDocument.numPages}`,
        progress: pageNumber / pdfDocument.numPages * 0.2,
        totalUnits: pdfDocument.numPages,
        unit: "pages"
      });
      if (hasExtractableText) break;
    }

    if (!hasExtractableText) {
      if (pdfDocument.numPages > 1000) {
        throw Object.assign(new Error("El PDF supera el límite de 1000 páginas para convertirlo a imágenes."), {
          statusCode: 422
        });
      }
      temporaryDirectory = await mkdtemp(join(tmpdir(), "lector-pdf-"));
      const pageImages: NonNullable<ImportedDocument["pageImages"]> = [];
      let totalBytes = 0;
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const originalViewport = page.getViewport({ scale: 1 });
        // Aim for 200 dpi, bounding both the surface area and either dimension.
        const scale = Math.min(
          200 / 72,
          4096 / originalViewport.width,
          4096 / originalViewport.height,
          Math.sqrt(8_000_000 / (originalViewport.width * originalViewport.height))
        );
        const viewport = page.getViewport({ scale });
        // Round down so the canvas never exceeds the pixel or dimension limits.
        const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
        try {
          await page.render({
            canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
            viewport,
            background: "white"
          }).promise;
          const buffer = await canvas.encode("jpeg", 95);
          totalBytes += buffer.length;
          if (totalBytes > 1024 * 1024 * 1024) {
            throw Object.assign(
              new Error("Las imágenes del PDF superan el límite de almacenamiento total de 1 GiB. Divide el PDF en libros más pequeños."),
              { statusCode: 422 }
            );
          }
          const fileName = `pagina-${pageNumber}.jpg`;
          const filePath = join(temporaryDirectory, fileName);
          await writeFile(filePath, buffer);
          pageImages.push({ filePath, fileName, mimeType: "image/jpeg" });
        } finally {
          canvas.width = 1;
          canvas.height = 1;
          page.cleanup();
          // No render is active here; release shared and worker caches for the next page.
          await pdfDocument.cleanup();
        }
        onProgress?.({
          completedUnits: pageNumber,
          message: `PDF sin texto: convirtiendo página ${pageNumber} de ${pdfDocument.numPages} a imagen (OCR pendiente)`,
          progress: 0.2 + pageNumber / pdfDocument.numPages * 0.74,
          totalUnits: pdfDocument.numPages,
          unit: "pages"
        });
      }
      return {
        cleanup,
        pageImages,
        pages: pageImages.map((_, index) => ({
          pageNumber: index + 1,
          paragraphs: [],
          rawText: ""
        })),
        totalPages: pageImages.length,
        totalParagraphs: 0
      };
    }

    const pages: ImportedPage[] = [];

    const marginPages = new Map<string, Set<number>>();
    for (let number = 1; number <= pdfDocument.numPages; number++) {
      const page = await pdfDocument.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) if ("str" in item && item.str.trim().length > 2 && item.str.length < 180) {
        const [, top] = viewport.convertToViewportPoint(item.transform[4]!, item.transform[5]!);
        if (top! / viewport.height < 0.12 || top! / viewport.height > 0.88) {
          const key = normalizePdfMargin(item.str);
          const numbers = marginPages.get(key) ?? new Set<number>();
          numbers.add(number);
          marginPages.set(key, numbers);
        }
      }
      page.cleanup();
    }
    const repeatedMargins = new Set([...marginPages].filter(([, numbers]) => numbers.size >= 3).map(([key]) => key));

    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const page = await pdfDocument.getPage(pageNumber);
      const blocks = await analyzePdfPage(page, repeatedMargins);
      const imageBoxes = await pdfImageGeometries(page, pdfModule.OPS);
      const indices: number[] = [];
      const images = await extractPdfImages(page, pdfModule.OPS, pageNumber, (index) => indices.push(index));
      let paragraphs = blocks.map((block) => block.headingLevel ? `${"#".repeat(block.headingLevel)} ${block.text}` : block.text);
      const paragraphMetadata: NonNullable<ImportedPage["paragraphMetadata"]> = blocks.map((block) => ({
        role: block.role, geometry: block.geometry, readAloud: !["header", "footer", "pageNumber"].includes(block.role),
        includeInToc: block.role === "heading"
      }));
      for (const [index, image] of images.entries()) {
        const geometry = imageBoxes.get(indices[index]!);
        paragraphs.push(image);
        paragraphMetadata.push({ role: "image", readAloud: false, geometry: geometry ?? null });
        if (geometry) for (const [blockIndex, block] of blocks.entries()) {
          const box = block.geometry.bbox;
          const bottom = geometry.bbox.top + geometry.bbox.height;
          if (block.role === "body" && block.text.length < 220 && box.top >= bottom && box.top - bottom < 0.035
            && box.left < geometry.bbox.left + geometry.bbox.width && box.left + box.width > geometry.bbox.left
            && (/^(?:fig(?:ura)?\.?|foto(?:grafía)?|imagen|fuente)\b/iu.test(block.text) || box.height < 0.035)) {
            paragraphMetadata[blockIndex]!.role = "imageCaption";
          }
        }
      }
      const ordered = orderPdfImages(paragraphs.map((text, index) => ({ text, metadata: paragraphMetadata[index]!,
        geometry: paragraphMetadata[index]!.geometry, image: paragraphMetadata[index]!.role === "image" })));
      paragraphs = ordered.map((entry) => entry.text);
      paragraphMetadata.splice(0, paragraphMetadata.length, ...ordered.map((entry) => entry.metadata));
      const richContent = buildRichPageFromParagraphs(paragraphs, { paragraphMetadata, inferHeadings: false });

      pages.push({
        editedText: paragraphs.join("\n\n") || richContent.editedText,
        htmlContent: annotatePageElementHtml(richContent.htmlContent, paragraphMetadata.map((metadata, index) => ({ ...metadata, paragraphNumber: index + 1 }))),
        pageNumber,
        sourcePdfPageNumber: pageNumber,
        paragraphMetadata,
        paragraphs: richContent.paragraphs,
        rawText: paragraphs.join("\n\n")
      });

      page.cleanup();
      await pdfDocument.cleanup();

      onProgress?.({
        completedUnits: pageNumber,
        message: `Procesando página ${pageNumber} de ${pdfDocument.numPages}`,
        progress: 0.2 + pageNumber / pdfDocument.numPages * 0.74,
        totalUnits: pdfDocument.numPages,
        unit: "pages"
      });
    }

    onProgress?.({
      completedUnits: pdfDocument.numPages,
      message: "Construyendo el índice del PDF...",
      progress: 0.95,
      totalUnits: pdfDocument.numPages,
      unit: "pages"
    });
    const outlineEntries = await extractPdfOutlineEntries(pdfDocument, pages);

    return {
      ...(outlineEntries.length > 0 ? { outlineEntries } : {}),
      pages,
      totalPages: pages.length,
      totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
    };
  } catch (error) {
    await cleanup();
    throw error;
  } finally {
    try {
      await pdfDocument.destroy();
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
}
