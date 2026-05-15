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

function normalizeEditableText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
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
  const images = document.querySelectorAll("figure.reader-rich-node img, .reader-rich-node img, .epub-page-body img");
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

function extractNodeEditableText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!(node instanceof Element)) {
    return "";
  }

  if (node.tagName.toLowerCase() === "br") {
    return "\n";
  }

  return Array.from(node.childNodes).map(extractNodeEditableText).join("");
}

function getRootRichNodes(document: Document): Element[] {
  return Array.from(document.querySelectorAll(".reader-rich-node"))
    .filter((node) => !node.parentElement?.closest(".reader-rich-node"));
}

function getEditableSourceNodes(document: Document): Element[] {
  const richNodes = getRootRichNodes(document);
  if (richNodes.length > 1) {
    return richNodes;
  }

  const body = document.querySelector(".epub-page-body") ?? document.body;
  return Array.from(body.children).filter((node) => node.tagName.toLowerCase() !== "style");
}

function buildEditableBlockFromRichNode(node: Element, imageIndexes: Map<Element, number>): string | null {
  const image = node.matches("img") ? node : node.querySelector("img");
  if (image) {
    const imageIndex = imageIndexes.get(image);
    if (imageIndex) {
      const altText = normalizeWhitespace(image.getAttribute("alt") ?? "");
      return `![${altText}](embedded-image-${imageIndex})`;
    }
  }

  const text = normalizeEditableText(extractNodeEditableText(node));
  if (!text) {
    return null;
  }

  const tagName = node.tagName.toLowerCase();
  const headingMatch = tagName.match(/^h([1-6])$/u);
  const headingPrefix = headingMatch ? `${"#".repeat(Number(headingMatch[1]))} ` : "";
  const alignment = node.getAttribute("data-text-align")?.trim();
  const alignedText = headingPrefix ? `${headingPrefix}${text}` : text;

  return alignment === "left" || alignment === "center" || alignment === "right"
    ? `::${alignment}:: ${alignedText}`
    : alignedText;
}

export function buildEditableTextFromHtmlContent(htmlContent: string | null | undefined): string | null {
  if (!htmlContent || typeof DOMParser === "undefined") {
    return null;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const images = Array.from(document.querySelectorAll("figure.reader-rich-node img, .reader-rich-node img, .epub-page-body img"));
  const imageIndexes = new Map(images.map((image, index) => [image, index + 1]));
  const blocks = getEditableSourceNodes(document)
    .map((node) => buildEditableBlockFromRichNode(node, imageIndexes))
    .filter((block): block is string => Boolean(block));

  if (blocks.length === 0) {
    return null;
  }

  return blocks.join("\n");
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

function buildBlockFromParagraph(paragraph: string, embeddedImages: Map<string, string>): { html: string; isText: boolean } | null {
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
      html: `<figure class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}><img alt="${escapeHtml(altText)}" src="${escapeHtml(resolvedSource)}" />${altText ? `<figcaption>${escapeHtml(altText)}</figcaption>` : ""}</figure>`,
      isText: false
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
      html: `<h${level} class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(headingText)}</h${level}>`,
      isText: true
    };
  }

  const text = stripInlineMarkdown(normalizedContent);
  if (!text) {
    return null;
  }

  return {
    html: `<p class="reader-rich-node" role="button" tabindex="0"${buildAlignmentAttributes(alignment)}>${renderInlineMarkdown(normalizedContent).replace(/\n+/gu, "<br />")}</p>`,
    isText: true
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
    .map((paragraph) => buildBlockFromParagraph(paragraph, embeddedImages))
    .filter((block): block is { html: string; isText: boolean } => block !== null);

  if (blocks.length === 0) {
    return null;
  }

  let paragraphCounter = 1;
  const finalizedBlocks = blocks.map((block) => {
    if (!block.isText) {
      return block;
    }
    const htmlWithParagraphNumber = block.html.replace('class="reader-rich-node"', `class="reader-rich-node" data-paragraph-number="${paragraphCounter}"`);
    paragraphCounter += 1;
    return { ...block, html: htmlWithParagraphNumber };
  });

  return `<div class="epub-page-shell"><div class="epub-page-body ocr-page-body">${finalizedBlocks.map((block) => block.html).join("")}</div></div>`;
}
