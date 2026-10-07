import { load } from "cheerio";
import { normalizeParagraphMetadata, type ParagraphElementMetadata } from "./page-elements.js";
import { renderPageStyle, type PageStyle } from "./page-style.js";

type EmbeddedImageSourceMap = Map<string, string>;

type TextAlignment = "center" | "left" | "right";

type RichBlock = {
  readingBlockId?: string;
  readingRowId?: string;
  alignment: TextAlignment | null;
  editableText: string;
  html: string;
  includeInParagraphs: boolean;
  level: number | null;
  text: string;
};

export type RichPageBuildOptions = {
  paragraphStyles?: (PageStyle | undefined)[];
  paragraphImages?: ({ altText: string; caption: string } | undefined)[];
  paragraphMetadata?: ParagraphElementMetadata[];
  embeddedImages?: EmbeddedImageSourceMap;
  inferHeadings?: boolean;
  languageCode?: "es" | "it";
};

export type StructuredRichBlockInput =
  | {
    text: string;
    type: "paragraph";
  }
  | {
    level?: number;
    text: string;
    type: "heading";
  }
  | {
    altText?: string;
    source: string;
    type: "image";
  };

const headingPattern = /^(#{1,6})\s+(.+)$/u;
const imagePattern = /^!\[(.*?)\]\((.+?)\)$/u;
const alignmentPattern = /^::(left|center|right)::\s*([\s\S]+)$/u;
const readerLinkPattern = /\[([^\]]+)\]\(reader-page-(\d+)-paragraph-(\d+)\)/gu;
const headingKeywordPattern = /^(cap[ií]tulo|chapter|parte|section|pr[oó]logo|ep[ií]logo|prefacio|introducci[oó]n)\b/iu;
const embeddedImageSourcePattern = /^embedded-image-\d+$/u;
const readingBlockMarkerPattern = /^:::block ([a-zA-Z0-9_-]{1,80})(?: row=([a-zA-Z0-9_-]{1,80}))?$/u;

export function hasValidReadingBlockMarkers(editedText: string): boolean {
  const ids = new Set<string>();
  const rows = new Set<string>();
  let currentRow: string | undefined;
  return editedText.replace(/\r/g, "").split("\n").every((line) => {
    const trimmed = line.trim();
    if (!/^:::block(?:\s|$)/u.test(trimmed)) return true;
    const match = trimmed.match(readingBlockMarkerPattern);
    const id = match?.[1];
    if (!id || ids.has(id)) return false;
    const row = match?.[2];
    if (row !== currentRow && row && rows.has(row)) return false;
    if (row) rows.add(row);
    currentRow = row;
    ids.add(id);
    return true;
  });
}
const standaloneDatePattern = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u;
const signatureLikePattern = /^[A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\p{L}'’-]+|[A-ZÁÉÍÓÚÑ]\.)){1,4}$/u;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function normalizeWhitespace(value: string): string {
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

function parseAlignment(value: string): { alignment: TextAlignment | null; content: string } {
  const match = value.match(alignmentPattern);
  if (!match) {
    return { alignment: null, content: value };
  }

  const alignment = match[1] as TextAlignment;
  const content = match[2]?.trim() ?? "";
  return { alignment, content };
}

function prependAlignment(value: string, alignment: TextAlignment | null): string {
  if (!alignment) {
    return value;
  }

  return `::${alignment}:: ${value}`;
}

function buildAlignmentAttributes(alignment: TextAlignment | null): string {
  if (!alignment) {
    return "";
  }

  return ` data-text-align="${alignment}" style="text-align: ${alignment};"`;
}

function buildImageNarration(altText: string, languageCode: RichPageBuildOptions["languageCode"]): string {
  if (languageCode === "it") {
    return altText ? `Immagine. ${altText}` : "Immagine.";
  }

  return altText ? `Imagen. ${altText}` : "Imagen.";
}

function stripInlineMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(alignmentPattern, "$2")
      .replace(/^#{1,6}\s+/u, "")
      .replace(/!\[(.*?)\]\((.+?)\)/gu, "")
      .replace(readerLinkPattern, "$1")
      .replace(/\*\*(.+?)\*\*/gu, "$1")
      .replace(/__(.+?)__/gu, "$1")
      .replace(/\*(.+?)\*/gu, "$1")
      .replace(/_(.+?)_/gu, "$1")
  );
}

function stripInlineMarkdownPreservingLineBreaks(value: string): string {
  return normalizeWhitespacePreservingLineBreaks(
    value
      .replace(alignmentPattern, "$2")
      .replace(/^#{1,6}\s+/u, "")
      .replace(/!\[(.*?)\]\((.+?)\)/gu, "")
      .replace(readerLinkPattern, "$1")
      .replace(/\*\*(.+?)\*\*/gu, "$1")
      .replace(/__(.+?)__/gu, "$1")
      .replace(/\*(.+?)\*/gu, "$1")
      .replace(/_(.+?)_/gu, "$1")
  );
}

function renderInlineMarkdown(value: string): string {
  const escaped = escapeHtml(value);

  return escaped
    .replace(readerLinkPattern, '<a data-lector-page="$2" data-lector-paragraph="$3" href="?page=$2&amp;paragraph=$3">$1</a>')
    .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
    .replace(/__(.+?)__/gu, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/gu, "<em>$1</em>")
    .replace(/_(.+?)_/gu, "<em>$1</em>");
}

function countUppercaseRatio(value: string): number {
  const uppercaseLetters = value.replace(/[^A-ZÁÉÍÓÚÑ]/gu, "");
  const letterCount = value.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/gu, "").length;
  return letterCount > 0 ? uppercaseLetters.length / letterCount : 0;
}

function countTitleCaseWords(words: string[]): number {
  return words.filter((word) => /^[A-ZÁÉÍÓÚÑ][\p{Ll}\d'’-]*$/u.test(word)).length;
}

function looksLikeHeading(text: string, index: number): number | null {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return null;
  }

  if (standaloneDatePattern.test(normalized) || signatureLikePattern.test(normalized)) {
    return null;
  }

  const words = normalized.split(/\s+/u);

  if (headingKeywordPattern.test(normalized)) {
    return words.length <= 12 && normalized.length <= 90 ? (index === 0 ? 1 : 2) : null;
  }

  if (/[.!?:;]$/u.test(normalized)) {
    return null;
  }

  if (words.length > 12 || normalized.length > 80) {
    return null;
  }

  if (countUppercaseRatio(normalized) >= 0.75 && words.length <= 8) {
    return index === 0 ? 1 : 2;
  }

  const titleCaseWordCount = countTitleCaseWords(words);
  const hasDisallowedPunctuation = /[,()[\]{}"“”/\\]/u.test(normalized);
  if (!hasDisallowedPunctuation && words.length <= 6 && normalized.length <= 60 && titleCaseWordCount >= Math.max(2, words.length - 1)) {
    return index === 0 ? 1 : 2;
  }

  return null;
}

function resolveImageSource(source: string, embeddedImages?: EmbeddedImageSourceMap): string {
  const normalizedSource = source.trim();
  if (!normalizedSource) {
    return "";
  }

  if (embeddedImageSourcePattern.test(normalizedSource)) {
    return embeddedImages?.get(normalizedSource) ?? "";
  }

  return normalizedSource;
}

function splitEditableTextIntoBlocks(editedText: string) {
  return editedText
    .replace(/\r/g, "")
    .split(/\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

function buildBlockFromParagraph(paragraph: string, options?: RichPageBuildOptions, indexForHeading?: number): RichBlock | null {
  const normalizedParagraph = paragraph.replace(/\r/g, "").trim();
  if (!normalizedParagraph) {
    return null;
  }

  const { alignment, content } = parseAlignment(normalizedParagraph);
  const normalizedContent = content.trim();
  if (!normalizedContent) {
    return null;
  }

  const imageMatch = normalizedContent.match(imagePattern);
  if (imageMatch) {
    const altText = normalizeWhitespace(imageMatch[1] ?? "");
    const sourceToken = (imageMatch[2] ?? "").trim();
    const resolvedSource = resolveImageSource(sourceToken, options?.embeddedImages);
    if (!resolvedSource) {
      return null;
    }

    const narration = buildImageNarration(altText, options?.languageCode);

    return {
      alignment,
      editableText: prependAlignment(`![${altText}](${resolvedSource})`, alignment),
      html: `<figure class="reader-rich-node" role="button" tabindex="0" data-reader-text="${escapeHtml(narration)}"${buildAlignmentAttributes(alignment)}><img alt="${escapeHtml(altText)}" src="${escapeHtml(resolvedSource)}" />${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ""}</figure>`,
      includeInParagraphs: true,
      level: null,
      text: narration
    };
  }

  const headingMatch = normalizedContent.match(headingPattern);
  if (headingMatch) {
    const level = Math.min(6, headingMatch[1]?.length ?? 1);
    const headingText = headingMatch[2] ?? "";
    const text = stripInlineMarkdown(headingText);
    if (!text) {
      return null;
    }

    return {
      alignment,
      editableText: prependAlignment(`${"#".repeat(level)} ${headingText}`, alignment),
      html: `<h${level} class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(headingText)}</h${level}>`,
      includeInParagraphs: true,
      level,
      text
    };
  }

  const text = stripInlineMarkdownPreservingLineBreaks(normalizedContent);
  if (!text) {
    return null;
  }

  const inferredLevel = options?.inferHeadings === false ? null : looksLikeHeading(text, indexForHeading ?? 0);
  if (inferredLevel) {
    return {
      alignment,
      editableText: prependAlignment(`${"#".repeat(inferredLevel)} ${normalizedContent}`, alignment),
      html: `<h${inferredLevel} class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent)}</h${inferredLevel}>`,
      includeInParagraphs: true,
      level: inferredLevel,
      text
    };
  }

  return {
    alignment,
    editableText: prependAlignment(normalizedContent, alignment),
    html: `<p class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent).replace(/\n+/gu, "<br />")}</p>`,
    includeInParagraphs: true,
    level: null,
    text
  };
}

function wrapRichPageHtml(blocks: RichBlock[]): string | null {
  if (!blocks.some((block) => block.includeInParagraphs)) {
    return null;
  }

  const groups: Array<{ id: string; row?: string; html: string }> = [];
  const explicitIds = new Set(blocks.map((block) => block.readingBlockId));
  let implicitId = "page";
  for (let suffix = 1; explicitIds.has(implicitId); suffix += 1) implicitId = `page-${suffix}`;
  for (const block of blocks) {
    if (block.readingBlockId !== undefined) {
      groups.push({ id: block.readingBlockId, ...(block.readingRowId ? { row: block.readingRowId } : {}), html: "" });
      continue;
    }
    if (groups.length === 0) groups.push({ id: implicitId, html: "" });
    groups[groups.length - 1]!.html += block.html;
  }
  let html = "";
  let currentRow: string | undefined;
  for (const [index, group] of groups.entries()) {
    if (group.row !== currentRow) {
      if (currentRow) html += "</div>";
      if (group.row) html += `<div class="reader-reading-row" data-reading-row-id="${escapeHtml(group.row)}">`;
      currentRow = group.row;
    }
    html += `<section class="reader-reading-block" data-reading-block-id="${escapeHtml(group.id)}" data-reading-block-number="${index + 1}"${group.row ? ` data-reading-row-id="${escapeHtml(group.row)}"` : ""}>${group.html}</section>`;
  }
  if (currentRow) html += "</div>";
  return `<div class="epub-page-shell"><div class="epub-page-body ocr-page-body">${html}</div></div>`;
}

function finalizeRichBlocks(blocks: RichBlock[]) {
  let paragraphCounter = 1;
  const finalizedBlocks = blocks.map((block) => {
    if (!block.includeInParagraphs || block.text.length === 0) {
      return block;
    }
    const htmlWithParagraphNumber = block.html.replace('class="reader-rich-node"', `class="reader-rich-node" data-paragraph-number="${paragraphCounter}"`);
    paragraphCounter += 1;
    return { ...block, html: htmlWithParagraphNumber };
  });

  const textBlocks = finalizedBlocks.filter((block) => block.includeInParagraphs && block.text.length > 0);

  return {
    editedText: finalizedBlocks.map((block) => block.editableText).filter(Boolean).join("\n"),
    htmlContent: wrapRichPageHtml(finalizedBlocks),
    paragraphs: textBlocks.map((block) => block.text),
    rawText: textBlocks.map((block) => block.text).join("\n")
  };
}

export function extractEmbeddedImageSources(htmlContent: string | null | undefined): EmbeddedImageSourceMap {
  const embeddedImages: EmbeddedImageSourceMap = new Map();
  if (!htmlContent) {
    return embeddedImages;
  }

  const document = load(htmlContent);
  let imageIndex = 1;

  document("figure.reader-rich-node img, figure.reader-rich-node image, .reader-rich-node img, .reader-rich-node image, .epub-page-body img, .epub-page-body image").each((_, node) => {
    const element = document(node);
    const source = (element.attr("src") ?? element.attr("href") ?? element.attr("xlink:href"))?.trim();
    if (!source) {
      return;
    }

    embeddedImages.set(`embedded-image-${imageIndex}`, source);
    imageIndex += 1;
  });

  return embeddedImages;
}

export function buildRichPageFromParagraphs(
  paragraphs: string[],
  options?: RichPageBuildOptions
): { editedText: string; htmlContent: string | null; paragraphs: string[]; rawText: string; paragraphMetadata?: ParagraphElementMetadata[] } {
  if (!hasValidReadingBlockMarkers(paragraphs.join("\n"))) {
    throw new Error("Invalid or duplicate reading block marker.");
  }
  const blocks: RichBlock[] = [];
  let paragraphIndex = 0;
  for (const paragraph of paragraphs) {
    const marker = paragraph.trim().match(readingBlockMarkerPattern);
    const id = marker?.[1];
    if (id) {
      const row = marker?.[2];
      blocks.push({ readingBlockId: id, ...(row ? { readingRowId: row } : {}), alignment: null, editableText: `:::block ${id}${row ? ` row=${row}` : ""}`, html: "", includeInParagraphs: false, level: null, text: "" });
      continue;
    }
    const block = buildBlockFromParagraph(paragraph, options, paragraphIndex);
    if (block) {
      const style = options?.paragraphStyles?.[paragraphIndex];
      const imageText = options?.paragraphImages?.[paragraphIndex];
      if (style || imageText) {
        const html = load(block.html, {}, false);
        const node = html(".reader-rich-node");
        if (style) {
          node.attr("style", `${node.attr("style") ?? ""};${renderPageStyle(style)}`);
          if (style.alignment) node.attr("data-text-align", style.alignment);
          if (style.fontScale !== undefined) node.attr("data-font-scale", String(style.fontScale));
        }
        if (imageText && node.is("figure")) {
          node.find("img").attr("alt", imageText.altText);
          node.find("figcaption").remove();
          if (imageText.caption) node.append(html("<figcaption></figcaption>").text(imageText.caption));
          block.text = buildImageNarration([imageText.altText, imageText.caption].filter(Boolean).join(" "), options?.languageCode);
          node.attr("data-reader-text", block.text).attr("data-image-alt-separated", "true");
        }
        block.html = html.html();
      }
      blocks.push(block);
      paragraphIndex += 1;
    }
  }

  const page = finalizeRichBlocks(blocks);
  return options?.paragraphMetadata === undefined ? page : {
    ...page,
    paragraphMetadata: normalizeParagraphMetadata(options.paragraphMetadata, page.paragraphs.length)
  };
}

export function buildRichPageFromStructuredBlocks(
  blocks: StructuredRichBlockInput[]
): { editedText: string; htmlContent: string | null; paragraphs: string[]; rawText: string } {
  const paragraphCandidates = blocks.map((block) => {
    if (block.type === "image") {
      const altText = normalizeWhitespace(block.altText ?? "");
      return `![${altText}](${block.source})`;
    }

    if (block.type === "heading") {
      const headingLevel = Math.min(6, Math.max(1, block.level ?? 1));
      return `${"#".repeat(headingLevel)} ${block.text.trim()}`;
    }

    return block.text.trim();
  });

  return buildRichPageFromParagraphs(paragraphCandidates, { inferHeadings: false });
}

export function buildRichPageFromEditableText(
  editedText: string,
  options?: RichPageBuildOptions
): { editedText: string; htmlContent: string | null; paragraphs: string[]; rawText: string; paragraphMetadata?: ParagraphElementMetadata[] } {
  return buildRichPageFromParagraphs(splitEditableTextIntoBlocks(editedText), {
    ...options,
    inferHeadings: false
  });
}
