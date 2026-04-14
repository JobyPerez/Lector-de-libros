type TextAlignment = "center" | "left" | "right";

const headingPattern = /^(#{1,6})\s+(.+)$/u;
const imagePattern = /^!\[(.*?)\]\((.+?)\)$/u;
const alignmentPattern = /^::(left|center|right)::\s*([\s\S]+)$/u;
const embeddedImageSourcePattern = /^embedded-image-\d+$/u;

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

function parseAlignment(value: string): { alignment: TextAlignment | null; content: string } {
  const match = value.match(alignmentPattern);
  if (!match) {
    return { alignment: null, content: value };
  }

  const alignment = match[1] as TextAlignment;
  const content = match[2]?.trim() ?? "";
  return { alignment, content };
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

function extractEmbeddedImageSources(htmlContent: string | null | undefined): Map<string, string> {
  const embeddedImages = new Map<string, string>();
  if (!htmlContent || typeof DOMParser === "undefined") {
    return embeddedImages;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const images = document.querySelectorAll("figure.reader-rich-node img, .reader-rich-node img");
  let imageIndex = 1;

  for (const image of Array.from(images)) {
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
      html: `<figure class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}><img alt="${escapeHtml(altText)}" src="${escapeHtml(resolvedSource)}" />${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ""}</figure>`
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
      html: `<h${level} class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(headingText)}</h${level}>`
    };
  }

  const text = stripInlineMarkdown(normalizedContent);
  if (!text) {
    return null;
  }

  return {
    html: `<p class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent).replace(/\n+/gu, "<br />")}</p>`
  };
}

export function buildOcrPreviewHtml(editedText: string, persistedHtmlContent?: string | null): string | null {
  const paragraphCandidates = editedText
    .replace(/\r/g, "")
    .split(/\n/u)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const embeddedImages = extractEmbeddedImageSources(persistedHtmlContent);
  const blocks = paragraphCandidates
    .map((paragraph, index) => buildBlockFromParagraph(paragraph, index, embeddedImages))
    .filter((block): block is RichBlock => block !== null);

  if (blocks.length === 0) {
    return null;
  }

  return `<div class="epub-page-shell"><div class="epub-page-body ocr-page-body">${blocks.map((block) => block.html).join("")}</div></div>`;
}