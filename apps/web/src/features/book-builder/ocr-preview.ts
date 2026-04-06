const headingPattern = /^(#{1,6})\s+(.+)$/u;
const imagePattern = /^!\[(.*?)\]\((.+?)\)$/u;
const headingKeywordPattern = /^(cap[ií]tulo|chapter|parte|section|pr[oó]logo|ep[ií]logo|prefacio|introducci[oó]n)\b/iu;
const embeddedImageSourcePattern = /^embedded-image-\d+$/u;
const standaloneDatePattern = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/u;
const signatureLikePattern = /^[A-ZÁÉÍÓÚÑ][\p{L}'’-]+(?:\s+(?:[A-ZÁÉÍÓÚÑ][\p{L}'’-]+|[A-ZÁÉÍÓÚÑ]\.)){1,4}$/u;

type RichBlock = {
  html: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function stripInlineMarkdown(value: string): string {
  return normalizeWhitespace(
    value
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

function extractEmbeddedImageSources(htmlContent: string | null | undefined): Map<string, string> {
  const embeddedImages = new Map<string, string>();
  if (!htmlContent || typeof DOMParser === "undefined") {
    return embeddedImages;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const images = document.querySelectorAll("figure.reader-rich-node img, .reader-rich-node img");
  let imageIndex = 1;

  for (const image of images) {
    const source = image.getAttribute("src")?.trim();
    if (!source) {
      continue;
    }

    embeddedImages.set(`embedded-image-${imageIndex}`, source);
    imageIndex += 1;
  }

  return embeddedImages;
}

function resolveImageSource(source: string, embeddedImages: Map<string, string>): string {
  const normalizedSource = source.trim();
  if (!normalizedSource) {
    return "";
  }

  if (embeddedImageSourcePattern.test(normalizedSource)) {
    return embeddedImages.get(normalizedSource) ?? "";
  }

  return normalizedSource;
}

function buildBlockFromParagraph(paragraph: string, index: number, embeddedImages: Map<string, string>): RichBlock | null {
  const normalizedParagraph = paragraph.replace(/\r/g, "").trim();
  if (!normalizedParagraph) {
    return null;
  }

  const imageMatch = normalizedParagraph.match(imagePattern);
  if (imageMatch) {
    const altText = normalizeWhitespace(imageMatch[1] ?? "");
    const sourceToken = (imageMatch[2] ?? "").trim();
    const resolvedSource = resolveImageSource(sourceToken, embeddedImages);
    if (!resolvedSource) {
      return null;
    }

    return {
      html: `<figure class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"><img alt="${escapeHtml(altText)}" src="${escapeHtml(resolvedSource)}" />${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ""}</figure>`
    };
  }

  const headingMatch = normalizedParagraph.match(headingPattern);
  if (headingMatch) {
    const level = Math.min(6, headingMatch[1]?.length ?? 1);
    const headingText = headingMatch[2] ?? "";
    const text = stripInlineMarkdown(headingText);
    if (!text) {
      return null;
    }

    return {
      html: `<h${level} class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0">${renderInlineMarkdown(headingText)}</h${level}>`
    };
  }

  const text = stripInlineMarkdown(normalizedParagraph);
  if (!text) {
    return null;
  }

  const inferredLevel = looksLikeHeading(text, index);
  if (inferredLevel) {
    return {
      html: `<h${inferredLevel} class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0">${renderInlineMarkdown(normalizedParagraph)}</h${inferredLevel}>`
    };
  }

  return {
    html: `<p class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0">${renderInlineMarkdown(normalizedParagraph).replace(/\n+/gu, "<br />")}</p>`
  };
}

export function buildOcrPreviewHtml(editedText: string, persistedHtmlContent?: string | null): string | null {
  const paragraphCandidates = editedText
    .replace(/\r/g, "")
    .split(/\n{2,}/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const embeddedImages = extractEmbeddedImageSources(persistedHtmlContent);
  const blocks = paragraphCandidates
    .map((paragraph, index) => buildBlockFromParagraph(paragraph, index, embeddedImages))
    .filter((block): block is RichBlock => block !== null);

  if (blocks.length === 0) {
    return null;
  }

  return `<div class="epub-page-shell"><div class="epub-page-body">${blocks.map((block) => block.html).join("")}</div></div>`;
}