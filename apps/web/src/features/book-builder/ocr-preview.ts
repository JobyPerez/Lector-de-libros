type TextAlignment = "center" | "left" | "right";

const headingPattern = /^(#{1,6})\s+(.+)$/u;
const imagePattern = /^!\[(.*?)\]\((.+?)\)$/u;
const alignmentPattern = /^::(left|center|right)::\s*([\s\S]+)$/u;
const embeddedImageSourcePattern = /^embedded-image-\d+$/u;
const readerLinkPattern = /\[([^\]]+)\]\(reader-page-(\d+)-paragraph-(\d+)\)/gu;
const editableImageSelector = "figure.reader-rich-node img, figure.reader-rich-node image, .reader-rich-node img, .reader-rich-node image, .epub-page-body img, .epub-page-body image";

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

function getEmbeddedImageSource(image: Element): string {
  return (image.getAttribute("src")
    ?? image.getAttribute("href")
    ?? image.getAttribute("xlink:href")
    ?? "").trim();
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

function extractEmbeddedImageSources(htmlContent: string | null | undefined): Map<string, string> {
  const embeddedImages = new Map<string, string>();
  if (!htmlContent || typeof DOMParser === "undefined") {
    return embeddedImages;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const images = document.querySelectorAll(editableImageSelector);
  let imageIndex = 1;

  for (const image of Array.from(images)) {
    const source = getEmbeddedImageSource(image);
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

  if (node.tagName.toLowerCase() === "a") {
    const element = node as Element;
    const pageNumber = Number.parseInt(element.getAttribute("data-lector-page") ?? "", 10);
    const paragraphNumber = Number.parseInt(element.getAttribute("data-lector-paragraph") ?? "", 10);
    const linkText = Array.from(node.childNodes).map(extractNodeEditableText).join("");
    if (Number.isInteger(pageNumber) && pageNumber > 0 && Number.isInteger(paragraphNumber) && paragraphNumber > 0) {
      return `[${linkText}](reader-page-${pageNumber}-paragraph-${paragraphNumber})`;
    }

    return linkText;
  }

  return Array.from(node.childNodes).map(extractNodeEditableText).join("");
}

function getDeclaredAlignment(element: Element | null): TextAlignment | null {
  const declaredAlignment = element?.getAttribute("data-text-align")?.trim()
    ?? element?.getAttribute("style")?.match(/text-align\s*:\s*(left|center|right)/iu)?.[1]?.toLowerCase();

  return declaredAlignment === "left" || declaredAlignment === "center" || declaredAlignment === "right"
    ? declaredAlignment
    : null;
}

function buildEditableTextBlock(node: Element, rawText = extractNodeEditableText(node)): string | null {
  const text = normalizeEditableText(rawText);
  if (!text) {
    return null;
  }

  const tagName = node.tagName.toLowerCase();
  const headingMatch = tagName.match(/^h([1-6])$/u);
  const headingPrefix = headingMatch ? `${"#".repeat(Number(headingMatch[1]))} ` : "";
  const alignment = getDeclaredAlignment(node.closest("[data-text-align], [style*='text-align']"));
  const alignedText = headingPrefix ? `${headingPrefix}${text}` : text;

  return alignment
    ? `::${alignment}:: ${alignedText}`
    : alignedText;
}

function buildEditableImageBlock(image: Element, imageIndexes: Map<Element, number>, fallbackAltText = ""): string | null {
  const imageIndex = imageIndexes.get(image);
  if (!imageIndex) {
    return null;
  }

  const altText = normalizeWhitespace(image.getAttribute("alt") ?? fallbackAltText);
  const imageMarker = `![${altText}](embedded-image-${imageIndex})`;
  const alignmentElement = image.closest("[data-text-align], [style*='text-align']");
  const declaredAlignment = getDeclaredAlignment(alignmentElement);

  return declaredAlignment
    ? `::${declaredAlignment}:: ${imageMarker}`
    : imageMarker;
}

function buildEditableBlocksFromElement(node: Element, imageIndexes: Map<Element, number>): string[] {
  const tagName = node.tagName.toLowerCase();
  if (tagName === "style" || tagName === "script") {
    return [];
  }

  if (tagName === "img" || tagName === "image") {
    const imageBlock = buildEditableImageBlock(node, imageIndexes);
    return imageBlock ? [imageBlock] : [];
  }

  if (tagName === "figure") {
    const caption = normalizeWhitespace(node.querySelector("figcaption")?.textContent ?? "");
    const imageBlocks = Array.from(node.querySelectorAll("img, image"))
      .map((image, index) => buildEditableImageBlock(image, imageIndexes, index === 0 ? caption : ""))
      .filter((block): block is string => Boolean(block));
    return imageBlocks.length > 0
      ? imageBlocks
      : [buildEditableTextBlock(node)].filter((block): block is string => Boolean(block));
  }

  const containsEditableStructure = Boolean(node.querySelector("img, image, figure, .reader-rich-node"));
  if (!containsEditableStructure) {
    const block = buildEditableTextBlock(node);
    return block ? [block] : [];
  }

  const blocks: string[] = [];
  let textBuffer = "";
  const flushText = () => {
    const block = buildEditableTextBlock(node, textBuffer);
    if (block) {
      blocks.push(block);
    }
    textBuffer = "";
  };

  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      textBuffer += child.textContent ?? "";
      continue;
    }

    if (!(child instanceof Element)) {
      continue;
    }

    const childTagName = child.tagName.toLowerCase();
    if (childTagName === "br") {
      textBuffer += "\n";
      continue;
    }

    const childContainsEditableStructure = child.matches("img, image, figure, .reader-rich-node")
      || Boolean(child.querySelector("img, image, figure, .reader-rich-node"));
    if (childContainsEditableStructure) {
      flushText();
      blocks.push(...buildEditableBlocksFromElement(child, imageIndexes));
      continue;
    }

    const childIsBlock = /^(address|article|aside|blockquote|div|h[1-6]|li|main|nav|ol|p|pre|section|table|ul)$/u.test(childTagName);
    if (childIsBlock) {
      flushText();
      const childBlock = buildEditableTextBlock(child);
      if (childBlock) {
        blocks.push(childBlock);
      }
      continue;
    }

    textBuffer += extractNodeEditableText(child);
  }

  flushText();
  return blocks;
}

export function buildEditableTextFromHtmlContent(htmlContent: string | null | undefined): string | null {
  if (!htmlContent || typeof DOMParser === "undefined") {
    return null;
  }

  const document = new DOMParser().parseFromString(htmlContent, "text/html");
  const body = document.querySelector(".epub-page-body") ?? document.body;
  const images = Array.from(document.querySelectorAll(editableImageSelector))
    .filter((image) => Boolean(getEmbeddedImageSource(image)));
  const imageIndexes = new Map(images.map((image, index) => [image, index + 1]));
  const blocks = Array.from(body.children).flatMap((node) => buildEditableBlocksFromElement(node, imageIndexes));

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
