import AdmZip from "adm-zip";
import { load } from "cheerio";

import type { ImportedDocument, ImportedPage } from "./book-import.js";

type ManifestItem = {
  href: string;
  mediaType: string;
};

const paragraphSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
const headingSelector = "h1, h2, h3, h4, h5, h6";
const structuralWrapperTags = new Set(["article", "div", "main", "section"]);
const maxChunkCharacters = 4200;
const maxChunkParagraphs = 14;

type ChunkUnit = {
  characters: number;
  hasRenderableContent: boolean;
  html: string;
  images: number;
  isHeading: boolean;
  paragraphs: number;
};

type ContentRoot = {
  wrapperChain: Array<{ attributes: Record<string, string>; tagName: string }>;
  units: ChunkUnit[];
};

const mimeTypeByExtension = new Map([
  [".avif", "image/avif"],
  [".css", "text/css"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"]
]);

function normalizeZipEntryName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

function decodeZipPathSegment(pathSegment: string): string {
  try {
    return decodeURIComponent(pathSegment);
  } catch {
    return pathSegment;
  }
}

function normalizeArchiveLookupPath(entryPath: string): string {
  return normalizeZipEntryName(entryPath)
    .split("/")
    .filter(Boolean)
    .map(decodeZipPathSegment)
    .join("/");
}

function findArchiveEntry(archive: AdmZip, entryPath: string) {
  const normalizedEntryPath = normalizeArchiveLookupPath(entryPath);

  return archive.getEntries().find((entry) => normalizeArchiveLookupPath(entry.entryName) === normalizedEntryPath);
}

function dirnamePath(filePath: string): string {
  const lastSeparatorIndex = filePath.lastIndexOf("/");
  if (lastSeparatorIndex === -1) {
    return "";
  }

  return filePath.slice(0, lastSeparatorIndex);
}

function resolveZipPath(baseDirectory: string, relativePath: string): string {
  const pathSegments = `${baseDirectory}/${relativePath}`
    .split("/")
    .filter(Boolean);

  const resolvedSegments: string[] = [];

  for (const segment of pathSegments) {
    if (segment === ".") {
      continue;
    }

    if (segment === "..") {
      resolvedSegments.pop();
      continue;
    }

    resolvedSegments.push(segment);
  }

  return resolvedSegments.join("/");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeHtmlAttribute(value)}"`)
    .join("");
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
}

function inferMimeTypeFromPath(filePath: string): string {
  const extensionIndex = filePath.lastIndexOf(".");
  if (extensionIndex === -1) {
    return "application/octet-stream";
  }

  return mimeTypeByExtension.get(filePath.slice(extensionIndex).toLowerCase()) ?? "application/octet-stream";
}

function createDataUri(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

function isUnsafeAssetReference(reference: string): boolean {
  const normalizedReference = reference.trim();

  return normalizedReference.length === 0
    || normalizedReference.startsWith("#")
    || /^data:/iu.test(normalizedReference)
    || /^javascript:/iu.test(normalizedReference)
    || /^https?:/iu.test(normalizedReference)
    || /^mailto:/iu.test(normalizedReference)
    || /^tel:/iu.test(normalizedReference);
}

function isEmbeddedDataReference(reference: string): boolean {
  return /^data:/iu.test(reference.trim());
}

function isRemoteAssetReference(reference: string): boolean {
  const normalizedReference = reference.trim();

  return /^javascript:/iu.test(normalizedReference)
    || /^https?:/iu.test(normalizedReference)
    || /^mailto:/iu.test(normalizedReference)
    || /^tel:/iu.test(normalizedReference);
}

function resolveAssetDataUri(archive: AdmZip, entryPath: string, mediaType?: string): string | null {
  const assetEntry = findArchiveEntry(archive, entryPath);
  if (!assetEntry) {
    return null;
  }

  return createDataUri(assetEntry.getData(), mediaType ?? inferMimeTypeFromPath(entryPath));
}

function rewriteCssBodySelectors(cssText: string): string {
  return cssText
    .replace(/(^|[^\w-])body(?=[\s.#:[{>+~]|$)/giu, "$1.epub-page-body")
    .replace(/(^|[^\w-])html(?=[\s.#:[{>+~]|$)/giu, "$1.epub-page-shell");
}

function rewriteCssAssetUrls(cssText: string, baseDirectory: string, archive: AdmZip): string {
  return cssText.replace(/url\(([^)]+)\)/giu, (fullMatch, rawReference: string) => {
    const cleanedReference = stripQuotes(rawReference.trim());
    if (isEmbeddedDataReference(cleanedReference) || cleanedReference.startsWith("#")) {
      return fullMatch;
    }

    if (isRemoteAssetReference(cleanedReference)) {
      return "url()";
    }

    if (isUnsafeAssetReference(cleanedReference)) {
      return fullMatch;
    }

    const resolvedEntryPath = resolveZipPath(baseDirectory, cleanedReference);
    const dataUri = resolveAssetDataUri(archive, resolvedEntryPath);

    return dataUri ? `url(${dataUri})` : fullMatch;
  });
}

function inlineLinkedStyles(document: ReturnType<typeof load>, documentDirectory: string, archive: AdmZip): string[] {
  const inlineStyles: string[] = [];

  document("style").each((_, node) => {
    const cssText = document(node).html() ?? "";
    if (!cssText.trim()) {
      document(node).remove();
      return;
    }

    inlineStyles.push(rewriteCssBodySelectors(rewriteCssAssetUrls(cssText, documentDirectory, archive)));
    document(node).remove();
  });

  document("link").each((_, node) => {
    const element = document(node);
    const relationship = element.attr("rel")?.toLowerCase() ?? "";
    if (!relationship.includes("stylesheet")) {
      return;
    }

    const href = element.attr("href");
    if (!href || isUnsafeAssetReference(href)) {
      element.remove();
      return;
    }

    const stylesheetPath = resolveZipPath(documentDirectory, href);
    const stylesheetEntry = findArchiveEntry(archive, stylesheetPath);
    if (stylesheetEntry) {
      const cssText = stylesheetEntry.getData().toString("utf-8");
      inlineStyles.push(rewriteCssBodySelectors(rewriteCssAssetUrls(cssText, dirnamePath(stylesheetPath), archive)));
    }

    element.remove();
  });

  return inlineStyles;
}

function inlineBinaryAssets(document: ReturnType<typeof load>, documentDirectory: string, archive: AdmZip): void {
  document("img[src]").each((_, node) => {
    const element = document(node);
    const source = element.attr("src");
    if (!source) {
      return;
    }

    if (isEmbeddedDataReference(source)) {
      return;
    }

    if (isRemoteAssetReference(source)) {
      element.removeAttr("src");
      return;
    }

    if (isUnsafeAssetReference(source)) {
      return;
    }

    const resolvedEntryPath = resolveZipPath(documentDirectory, source);
    const dataUri = resolveAssetDataUri(archive, resolvedEntryPath);
    if (dataUri) {
      element.attr("src", dataUri);
    }
  });

  document("image").each((_, node) => {
    const element = document(node);
    const source = element.attr("href") ?? element.attr("xlink:href");
    if (!source) {
      return;
    }

    if (isEmbeddedDataReference(source)) {
      return;
    }

    if (isRemoteAssetReference(source)) {
      element.removeAttr("href");
      element.removeAttr("xlink:href");
      return;
    }

    if (isUnsafeAssetReference(source)) {
      return;
    }

    const resolvedEntryPath = resolveZipPath(documentDirectory, source);
    const dataUri = resolveAssetDataUri(archive, resolvedEntryPath);
    if (!dataUri) {
      return;
    }

    if (element.attr("href")) {
      element.attr("href", dataUri);
    }

    if (element.attr("xlink:href")) {
      element.attr("xlink:href", dataUri);
    }
  });
}

function sanitizeDocumentMarkup(document: ReturnType<typeof load>): void {
  document("script, noscript, iframe, object, embed, form, input, button, textarea, select, base").remove();

  document("*").each((_, node) => {
    const element = document(node);
    const attributes = ((node as { attribs?: Record<string, string> }).attribs) ?? {};

    for (const [attributeName, attributeValue] of Object.entries(attributes)) {
      if (/^on/iu.test(attributeName)) {
        element.removeAttr(attributeName);
        continue;
      }

      if ((attributeName === "href" || attributeName === "src" || attributeName === "xlink:href")
        && /^javascript:/iu.test(String(attributeValue).trim())) {
        element.removeAttr(attributeName);
      }
    }
  });
}

function createChunkUnit(document: ReturnType<typeof load>, node: Parameters<ReturnType<typeof load>["html"]>[0]): ChunkUnit | null {
  const element = document(node);
  const html = document.html(node) ?? "";
  const textContent = normalizeWhitespace(element.text());
  const images = element.is("img, svg, image") ? 1 : element.find("img, svg, image").length;
  const paragraphCount = element.is(paragraphSelector) ? 1 : element.find(paragraphSelector).length;
  const isHeading = element.is(headingSelector);
  const hasRenderableContent = html.trim().length > 0 && (textContent.length > 0 || images > 0 || /<(img|svg|table|hr|figure)\b/iu.test(html));

  if (!hasRenderableContent) {
    return null;
  }

  return {
    characters: textContent.length,
    hasRenderableContent,
    html,
    images,
    isHeading,
    paragraphs: paragraphCount
  };
}

function resolveContentRoot(document: ReturnType<typeof load>) {
  let currentRoot: any = document("body").first();
  const wrapperChain: Array<{ attributes: Record<string, string>; tagName: string }> = [];

  while (true) {
    const meaningfulChildren = currentRoot.contents().toArray().filter((node: any) => {
      const nodeText = normalizeWhitespace(document(node).text());
      if (node.type === "text") {
        return nodeText.length > 0;
      }

      return true;
    });

    if (meaningfulChildren.length !== 1) {
      break;
    }

    const onlyChild = meaningfulChildren[0];
    if (!onlyChild) {
      break;
    }

    if (onlyChild.type !== "tag") {
      break;
    }

    const onlyChildElement = document(onlyChild);
    const rawTagName = (onlyChild as { name?: string; tagName?: string }).tagName
      ?? (onlyChild as { name?: string; tagName?: string }).name;
    const tagName = rawTagName?.toLowerCase() ?? "";
    if (!structuralWrapperTags.has(tagName)) {
      break;
    }

    wrapperChain.push({
      attributes: { ...(((onlyChild as { attribs?: Record<string, string> }).attribs) ?? {}) },
      tagName
    });
    currentRoot = onlyChildElement;
  }

  const units = currentRoot.contents()
    .toArray()
    .map((node: any) => createChunkUnit(document, node))
    .filter((unit: ChunkUnit | null): unit is ChunkUnit => unit !== null);

  return {
    wrapperChain,
    units
  } satisfies ContentRoot;
}

function wrapChunkHtml(units: ChunkUnit[], wrapperChain: ContentRoot["wrapperChain"]): string {
  let wrappedHtml = units.map((unit) => unit.html).join("");

  for (let index = wrapperChain.length - 1; index >= 0; index -= 1) {
    const wrapper = wrapperChain[index];
    if (!wrapper) {
      continue;
    }

    wrappedHtml = `<${wrapper.tagName}${renderAttributes(wrapper.attributes)}>${wrappedHtml}</${wrapper.tagName}>`;
  }

  return wrappedHtml;
}

function splitIntoChunks(units: ChunkUnit[]): ChunkUnit[][] {
  if (units.length === 0) {
    return [];
  }

  const chunks: ChunkUnit[][] = [];
  let currentChunk: ChunkUnit[] = [];
  let currentCharacters = 0;
  let currentParagraphs = 0;

  for (const unit of units) {
    const wouldExceedCharacters = currentChunk.length > 0 && currentCharacters + unit.characters > maxChunkCharacters;
    const wouldExceedParagraphs = currentChunk.length > 0 && currentParagraphs + unit.paragraphs > maxChunkParagraphs;
    const shouldBreakBeforeHeading = currentChunk.length > 0 && unit.isHeading && currentParagraphs >= Math.max(4, Math.floor(maxChunkParagraphs / 2));

    if (wouldExceedCharacters || wouldExceedParagraphs || shouldBreakBeforeHeading) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCharacters = 0;
      currentParagraphs = 0;
    }

    currentChunk.push(unit);
    currentCharacters += unit.characters;
    currentParagraphs += unit.paragraphs;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function annotateParagraphNodes(document: ReturnType<typeof load>): string[] {
  const paragraphs: string[] = [];

  document("body")
    .find(paragraphSelector)
    .filter((_, node) => document(node).parents(paragraphSelector).length === 0)
    .each((_, node) => {
      const element = document(node);
      const paragraphText = normalizeWhitespace(element.text());
      if (!paragraphText) {
        return;
      }

      paragraphs.push(paragraphText);

      const currentClassName = element.attr("class");
      const classNames = new Set((currentClassName ?? "").split(/\s+/u).filter(Boolean));
      classNames.add("reader-rich-node");

      element.attr("class", Array.from(classNames).join(" "));
      element.attr("data-paragraph-number", String(paragraphs.length));
      element.attr("role", "button");
      element.attr("tabindex", "0");
    });

  return paragraphs;
}

function buildRichPageMarkup(document: ReturnType<typeof load>, inlineStyles: string[]): string | null {
  const bodyElement = document("body").first();
  const bodyHtml = bodyElement.html()?.trim() ?? "";

  if (!bodyHtml) {
    return null;
  }

  const bodyClassName = ["epub-page-body", bodyElement.attr("class")].filter(Boolean).join(" ");
  const bodyStyle = bodyElement.attr("style")?.trim();
  const styleMarkup = inlineStyles.length > 0
    ? `<style>${inlineStyles.join("\n")}</style>`
    : "";
  const bodyStyleAttribute = bodyStyle ? ` style="${escapeHtmlAttribute(bodyStyle)}"` : "";

  return `${styleMarkup}<div class="epub-page-shell"><div class="${escapeHtmlAttribute(bodyClassName)}"${bodyStyleAttribute}>${bodyHtml}</div></div>`;
}

function createPagesFromDocument(document: ReturnType<typeof load>, inlineStyles: string[]): Array<Pick<ImportedPage, "htmlContent" | "paragraphs" | "rawText">> {
  const bodyElement = document("body").first();
  const bodyClassName = bodyElement.attr("class");
  const bodyStyle = bodyElement.attr("style");
  const { units, wrapperChain } = resolveContentRoot(document);

  if (units.length === 0) {
    const rawText = normalizeWhitespace(bodyElement.text());
    const htmlContent = buildRichPageMarkup(document, inlineStyles);

    return [{
      htmlContent,
      paragraphs: fallbackParagraphsFromText(rawText),
      rawText
    }];
  }

  return splitIntoChunks(units).map((chunkUnits) => {
    const chunkDocument = load("<html><body></body></html>", {
      xmlMode: false
    });

    if (bodyClassName) {
      chunkDocument("body").attr("class", bodyClassName);
    }

    if (bodyStyle) {
      chunkDocument("body").attr("style", bodyStyle);
    }

    chunkDocument("body").html(wrapChunkHtml(chunkUnits, wrapperChain));

    const paragraphs = annotateParagraphNodes(chunkDocument);
    const rawText = normalizeWhitespace(chunkDocument("body").text());
    const htmlContent = buildRichPageMarkup(chunkDocument, inlineStyles);

    return {
      htmlContent,
      paragraphs: paragraphs.length > 0 ? paragraphs : fallbackParagraphsFromText(rawText),
      rawText
    };
  });
}

function fallbackParagraphsFromText(text: string): string[] {
  return text
    .split(/\n{2,}/u)
    .map(normalizeWhitespace)
    .filter(Boolean);
}

export async function parseEpubBuffer(fileBuffer: Buffer): Promise<ImportedDocument> {
  const archive = new AdmZip(fileBuffer);
  const containerEntry = findArchiveEntry(archive, "META-INF/container.xml");

  if (!containerEntry) {
    throw Object.assign(new Error("El EPUB no contiene META-INF/container.xml."), {
      statusCode: 422
    });
  }

  const containerDocument = load(containerEntry.getData().toString("utf-8"), {
    xmlMode: true
  });
  const rootFilePath = containerDocument("rootfile").attr("full-path");

  if (!rootFilePath) {
    throw Object.assign(new Error("El EPUB no declara el documento OPF principal."), {
      statusCode: 422
    });
  }

  const opfEntry = findArchiveEntry(archive, rootFilePath);
  if (!opfEntry) {
    throw Object.assign(new Error("No se ha encontrado el archivo OPF del EPUB."), {
      statusCode: 422
    });
  }

  const opfDirectory = dirnamePath(rootFilePath);
  const opfDocument = load(opfEntry.getData().toString("utf-8"), {
    xmlMode: true
  });
  const manifest = new Map<string, ManifestItem>();

  opfDocument("manifest > item").each((_, element) => {
    const item = opfDocument(element);
    const id = item.attr("id");
    const href = item.attr("href");
    const mediaType = item.attr("media-type");

    if (id && href && mediaType) {
      manifest.set(id, { href, mediaType });
    }
  });

  const pages: ImportedPage[] = [];

  opfDocument("spine > itemref").each((_, element) => {
    const itemReference = opfDocument(element);
    const idReference = itemReference.attr("idref");
    if (!idReference) {
      return;
    }

    const manifestItem = manifest.get(idReference);
    if (!manifestItem || !/html|xhtml/u.test(manifestItem.mediaType)) {
      return;
    }

    const entryPath = resolveZipPath(opfDirectory, manifestItem.href);
    const contentEntry = findArchiveEntry(archive, entryPath);
    if (!contentEntry) {
      return;
    }

    const document = load(contentEntry.getData().toString("utf-8"), {
      xmlMode: false
    });
    const documentDirectory = dirnamePath(entryPath);

    document("br").replaceWith("\n");

    const inlineStyles = inlineLinkedStyles(document, documentDirectory, archive);
    inlineBinaryAssets(document, documentDirectory, archive);
    sanitizeDocumentMarkup(document);

    const chunkedPages = createPagesFromDocument(document, inlineStyles);

    for (const chunkedPage of chunkedPages) {
      pages.push({
        htmlContent: chunkedPage.htmlContent ?? null,
        pageNumber: pages.length + 1,
        paragraphs: chunkedPage.paragraphs,
        rawText: chunkedPage.rawText
      });
    }
  });

  return {
    pages,
    totalPages: pages.length,
    totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
  };
}