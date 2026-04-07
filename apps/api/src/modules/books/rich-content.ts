import { load } from "cheerio";

type EmbeddedImageSourceMap = Map<string, string>;

type TextAlignment = "center" | "left" | "right";

type RichBlock = {
  alignment: TextAlignment | null;
  editableText: string;
  html: string;
  includeInParagraphs: boolean;
  level: number | null;
  text: string;
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
const headingKeywordPattern = /^(cap[ií]tulo|chapter|parte|section|pr[oó]logo|ep[ií]logo|prefacio|introducci[oó]n)\b/iu;
const embeddedImageSourcePattern = /^embedded-image-\d+$/u;
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

function stripInlineMarkdown(value: string): string {
  return normalizeWhitespace(
    value
      .replace(alignmentPattern, "$2")
      .replace(/^#{1,6}\s+/u, "")
      .replace(/!\[(.*?)\]\((.+?)\)/gu, "")
      .replace(/\*\*(.+?)\*\*/gu, "$1")
      .replace(/__(.+?)__/gu, "$1")
      .replace(/\*(.+?)\*/gu, "$1")
      .replace(/_(.+?)_/gu, "$1")
  );
}

function renderInlineMarkdown(value: string): string {
  const escaped = escapeHtml(value);

  return escaped
    .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
    .replace(/__(.+?)__/gu, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/gu, "<em>$1</em>")
    .replace(/_(.+?)_/gu, "<em>$1</em>");
}

function looksLikeHeading(text: string, index: number): number | null {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return null;
  }

  if (standaloneDatePattern.test(normalized) || signatureLikePattern.test(normalized)) {
    return null;
  }

  if (headingKeywordPattern.test(normalized)) {
    return index === 0 ? 1 : 2;
  }

  if (/[.!?:;]$/u.test(normalized)) {
    return null;
  }

  const words = normalized.split(/\s+/u);
  if (words.length > 14 || normalized.length > 110) {
    return null;
  }

  const uppercaseLetters = normalized.replace(/[^A-ZÁÉÍÓÚÑ]/gu, "");
  const letterCount = normalized.replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ]/gu, "").length;
  const uppercaseRatio = letterCount > 0 ? uppercaseLetters.length / letterCount : 0;
  if (uppercaseRatio >= 0.6) {
    return index === 0 ? 1 : 2;
  }

  const titleCaseWordCount = words.filter((word) => /^[A-ZÁÉÍÓÚÑ][\p{Ll}\d'’-]*$/u.test(word)).length;
  if (titleCaseWordCount >= Math.max(2, words.length - 1) && words.length <= 9) {
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

function buildBlockFromParagraph(paragraph: string, index: number, embeddedImages?: EmbeddedImageSourceMap): RichBlock | null {
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
    const resolvedSource = resolveImageSource(sourceToken, embeddedImages);
    if (!resolvedSource) {
      return null;
    }

    return {
      alignment,
      editableText: prependAlignment(`![${altText}](${sourceToken})`, alignment),
      html: `<figure class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}><img alt="${escapeHtml(altText)}" src="${escapeHtml(resolvedSource)}" />${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ""}</figure>`,
      includeInParagraphs: false,
      level: null,
      text: ""
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
      html: `<h${level} class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(headingText)}</h${level}>`,
      includeInParagraphs: true,
      level,
      text
    };
  }

  const text = stripInlineMarkdown(normalizedContent);
  if (!text) {
    return null;
  }

  const inferredLevel = looksLikeHeading(text, index);
  if (inferredLevel) {
    return {
      alignment,
      editableText: prependAlignment(`${"#".repeat(inferredLevel)} ${normalizedContent}`, alignment),
      html: `<h${inferredLevel} class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent)}</h${inferredLevel}>`,
      includeInParagraphs: true,
      level: inferredLevel,
      text
    };
  }

  return {
    alignment,
    editableText: prependAlignment(normalizedContent, alignment),
    html: `<p class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent).replace(/\n+/gu, "<br />")}</p>`,
    includeInParagraphs: true,
    level: null,
    text
  };
}

function wrapRichPageHtml(blocks: RichBlock[]): string | null {
  if (blocks.length === 0) {
    return null;
  }

  return `<div class="epub-page-shell"><div class="epub-page-body ocr-page-body">${blocks.map((block) => block.html).join("")}</div></div>`;
}

function finalizeRichBlocks(blocks: RichBlock[]) {
  const textBlocks = blocks.filter((block) => block.includeInParagraphs && block.text.length > 0);

  return {
    editedText: blocks.map((block) => block.editableText).filter(Boolean).join("\n\n"),
    htmlContent: wrapRichPageHtml(blocks),
    paragraphs: textBlocks.map((block) => block.text),
    rawText: textBlocks.map((block) => block.text).join("\n\n")
  };
}

export function extractEmbeddedImageSources(htmlContent: string | null | undefined): EmbeddedImageSourceMap {
  const embeddedImages: EmbeddedImageSourceMap = new Map();
  if (!htmlContent) {
    return embeddedImages;
  }

  const document = load(htmlContent);
  let imageIndex = 1;

  document("figure.reader-rich-node img, .reader-rich-node img").each((_, node) => {
    const source = document(node).attr("src")?.trim();
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
  options?: { embeddedImages?: EmbeddedImageSourceMap }
): { editedText: string; htmlContent: string | null; paragraphs: string[]; rawText: string } {
  const blocks = paragraphs
    .map((paragraph, index) => buildBlockFromParagraph(paragraph, index, options?.embeddedImages))
    .filter((block): block is RichBlock => block !== null);

  return finalizeRichBlocks(blocks);
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

  return buildRichPageFromParagraphs(paragraphCandidates);
}

export function buildRichPageFromEditableText(
  editedText: string,
  options?: { embeddedImages?: EmbeddedImageSourceMap }
): { editedText: string; htmlContent: string | null; paragraphs: string[]; rawText: string } {
  const paragraphCandidates = editedText
    .replace(/\r/g, "")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  return buildRichPageFromParagraphs(paragraphCandidates, options);
}
