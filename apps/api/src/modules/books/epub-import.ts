import AdmZip from "adm-zip";
import { load } from "cheerio";

import type { ImportedBinaryAsset, ImportedDocument, ImportedOutlineEntry, ImportedPage } from "./book-import.js";

type ManifestItem = {
  href: string;
  mediaType: string;
  properties: Set<string>;
};

type ParsedEpubArchive = {
  archive: AdmZip;
  manifest: Map<string, ManifestItem>;
  opfDirectory: string;
  opfDocument: ReturnType<typeof load>;
  spineItemIds: string[];
};

type TocReferenceEntry = {
  entryPath: string;
  fragment: string | null;
  level: number;
  title: string;
};

type PageAnchorTarget = {
  pageNumber: number;
  paragraphNumber: number;
};

type PageAnchorLookup = {
  entryTargets: Map<string, PageAnchorTarget>;
  fragmentTargets: Map<string, PageAnchorTarget>;
};

type PreparedSpineDocument = {
  document: ReturnType<typeof load>;
  entryPath: string;
  inlineStyles: string[];
};

const paragraphSelector = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
const headingSelector = "h1, h2, h3, h4, h5, h6";
const structuralWrapperTags = new Set([
  "article", "aside", "blockquote", "dd", "div", "dl", "dt", "li", "main", "nav", "ol", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"
]);
const maxChunkCharacters = 4200;
const maxChunkParagraphs = 14;
const maxParagraphCharacters = 900;
const chunkMarkerAttribute = "data-lector-import-chunk";
const extraParagraphAttribute = "data-lector-import-extra-paragraph";
const temporaryTextWrapperAttribute = "data-lector-import-text";
const temporaryPositionAttribute = "data-lector-import-position";
const tocNormalizedHeadingAttribute = "data-lector-toc-normalized";

type ChunkUnit = {
  characters: number;
  hasRenderableContent: boolean;
  html: string;
  images: number;
  isHeading: boolean;
  markerId: string;
  paragraphs: number;
};

type ChunkCollectionState = {
  lastMarkerId: string | null;
  pendingAnchorNodes: Array<Parameters<ReturnType<typeof load>["html"]>[0]>;
  value: number;
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

function basenamePath(filePath: string): string {
  const lastSeparatorIndex = filePath.lastIndexOf("/");
  if (lastSeparatorIndex === -1) {
    return filePath;
  }

  return filePath.slice(lastSeparatorIndex + 1);
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

function normalizeHeadingComparison(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

function headingLevel(node: Parameters<ReturnType<typeof load>["html"]>[0]): number | null {
  const tagName = ((node as { name?: string; tagName?: string }).tagName
    ?? (node as { name?: string; tagName?: string }).name
    ?? "").toLowerCase();
  const level = /^h[1-6]$/u.test(tagName) ? Number.parseInt(tagName.slice(1), 10) : NaN;
  return Number.isInteger(level) ? level : null;
}

function setHeadingLevel(node: Parameters<ReturnType<typeof load>["html"]>[0], level: number): void {
  const tagName = `h${Math.min(6, Math.max(1, level))}`;
  (node as { name?: string }).name = tagName;
  (node as { tagName?: string }).tagName = tagName;
}

function findDocumentFragmentNode(
  document: ReturnType<typeof load>,
  fragment: string | null
): Parameters<ReturnType<typeof load>["html"]>[0] | null {
  if (!fragment) {
    return null;
  }

  const normalizedFragment = normalizeFragmentIdentifier(fragment);
  return document("[id], [xml\\:id], a[name]").toArray().find((node) => {
    const element = document(node);
    const identifier = element.attr("id") ?? element.attr("xml:id") ?? element.attr("name") ?? "";
    return normalizeFragmentIdentifier(identifier) === normalizedFragment;
  }) ?? null;
}

function normalizeDocumentHeadingsFromToc(
  preparedDocument: PreparedSpineDocument,
  tocEntries: TocReferenceEntry[]
): number[] {
  const { document, entryPath } = preparedDocument;
  const normalizedEntryPath = normalizeArchiveLookupPath(entryPath);
  const matchingEntries = tocEntries.filter((entry) => normalizeArchiveLookupPath(entry.entryPath) === normalizedEntryPath);
  const offsets: number[] = [];

  for (const entry of matchingEntries) {
    const headings = document(headingSelector).toArray();
    if (headings.length === 0) {
      continue;
    }

    const fragmentNode = findDocumentFragmentNode(document, entry.fragment);
    const allBodyNodes = document("body *").toArray();
    const fragmentNodeIndex = fragmentNode ? allBodyNodes.indexOf(fragmentNode as (typeof allBodyNodes)[number]) : -1;
    const headingFragmentNode = fragmentNode && headingLevel(fragmentNode)
      ? fragmentNode as (typeof headings)[number]
      : null;
    const candidate = headingFragmentNode
      ? headingFragmentNode
      : headings.find((heading) => fragmentNodeIndex < 0 || allBodyNodes.indexOf(heading) >= fragmentNodeIndex) ?? headings[0];
    if (!candidate) {
      continue;
    }

    const candidateIndex = headings.indexOf(candidate);
    const nextHeading = headings[candidateIndex + 1];
    const candidateElement = document(candidate);
    const candidateTitle = normalizeHeadingComparison(candidateElement.text());
    const nextTitle = nextHeading ? normalizeHeadingComparison(document(nextHeading).text()) : "";
    const officialTitle = normalizeHeadingComparison(entry.title);
    const combinedTitle = normalizeHeadingComparison(`${candidateElement.text()} ${nextHeading ? document(nextHeading).text() : ""}`);
    const candidateMatches = officialTitle === candidateTitle
      || officialTitle.startsWith(`${candidateTitle} `)
      || (candidateTitle.length >= 3 && officialTitle.includes(candidateTitle));
    const combinedMatches = Boolean(nextHeading)
      && headingLevel(nextHeading) === headingLevel(candidate)
      && officialTitle === combinedTitle;

    if (!candidateMatches && !combinedMatches && officialTitle !== nextTitle) {
      continue;
    }

    const originalLevel = headingLevel(candidate);
    if (!originalLevel) {
      continue;
    }

    candidateElement.text(entry.title);
    candidateElement.attr(tocNormalizedHeadingAttribute, "true");
    setHeadingLevel(candidate, entry.level);
    offsets.push(entry.level - originalLevel);

    if (combinedMatches && nextHeading) {
      document(nextHeading).remove();
    }
  }

  return offsets;
}

function applyHeadingLevelOffset(document: ReturnType<typeof load>, offset: number): void {
  document(headingSelector).each((_, node) => {
    const element = document(node);
    const level = headingLevel(node);
    if (level && !element.is(`[${tocNormalizedHeadingAttribute}]`)) {
      setHeadingLevel(node, level + offset);
    }
    element.removeAttr(tocNormalizedHeadingAttribute);
  });
}

function parsePositiveInteger(value: string | undefined): number | null {
  const parsedValue = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsedValue) && parsedValue > 0 ? parsedValue : null;
}

function normalizeFragmentIdentifier(value: string): string {
  return decodeZipPathSegment(value).trim();
}

function buildFragmentLookupKeys(entryPath: string, fragment: string): string[] {
  const normalizedEntryPath = normalizeArchiveLookupPath(entryPath);
  const normalizedFragment = normalizeFragmentIdentifier(fragment);
  if (!normalizedFragment) {
    return [];
  }

  const exactKey = `${normalizedEntryPath}#${normalizedFragment}`;
  const lowerCaseKey = `${normalizedEntryPath}#${normalizedFragment.toLowerCase()}`;

  return exactKey === lowerCaseKey ? [exactKey] : [exactKey, lowerCaseKey];
}

function resolveInternalReference(baseEntryPath: string, reference: string): { entryPath: string; fragment: string | null } | null {
  const normalizedReference = reference.trim();
  if (!normalizedReference || isRemoteAssetReference(normalizedReference) || /^data:/iu.test(normalizedReference) || /^javascript:/iu.test(normalizedReference)) {
    return null;
  }

  const fragmentIndex = normalizedReference.indexOf("#");
  const rawPath = fragmentIndex >= 0 ? normalizedReference.slice(0, fragmentIndex) : normalizedReference;
  const rawFragment = fragmentIndex >= 0 ? normalizedReference.slice(fragmentIndex + 1) : "";
  const entryPath = rawPath
    ? resolveZipPath(dirnamePath(baseEntryPath), rawPath)
    : baseEntryPath;
  const normalizedFragment = rawFragment ? normalizeFragmentIdentifier(rawFragment) : null;

  return {
    entryPath: normalizeArchiveLookupPath(entryPath),
    fragment: normalizedFragment || null
  };
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

type MutableDomNode = {
  attribs?: Record<string, string>;
  children?: MutableDomNode[];
  data?: string;
  type?: string;
};

function walkDom(node: MutableDomNode, visitor: (currentNode: MutableDomNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) {
    walkDom(child, visitor);
  }
}

function buildTextRanges(text: string, maxCharacters: number): Array<{ end: number; start: number }> {
  const ranges: Array<{ end: number; start: number }> = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + maxCharacters);
    if (end < text.length) {
      const minimumBoundary = start + Math.floor(maxCharacters / 2);
      for (let index = end; index > minimumBoundary; index -= 1) {
        if (/\s/u.test(text[index - 1] ?? "")) {
          end = index;
          break;
        }
      }
    }

    ranges.push({ end, start });
    start = end;
  }

  return ranges;
}

function splitParagraphMarkup(html: string, maxCharacters: number): string[] {
  const sourceDocument = load(`<html><body>${html}</body></html>`, { xmlMode: false });
  const sourceRoot = sourceDocument("body").children().first();
  const sourceNode = sourceRoot.get(0) as MutableDomNode | undefined;
  if (!sourceNode) {
    return [html];
  }

  let sourceOffset = 0;
  const markPositions = (node: MutableDomNode): void => {
    if (node.type === "text") {
      sourceOffset += node.data?.length ?? 0;
      return;
    }

    if (node.type === "tag" && node.attribs) {
      const hasIdentity = Boolean(node.attribs.id || node.attribs.name || node.attribs["xml:id"]);
      const isPositionedAsset = ["image", "img", "svg"].includes((node as { name?: string }).name ?? "");
      if (hasIdentity || isPositionedAsset) {
        node.attribs[temporaryPositionAttribute] = String(sourceOffset);
      }
    }

    for (const child of node.children ?? []) {
      markPositions(child);
    }
  };
  markPositions(sourceNode);

  const markedHtml = sourceDocument.html(sourceNode as Parameters<ReturnType<typeof load>["html"]>[0]) ?? html;
  const rawText = sourceRoot.text();
  const ranges = buildTextRanges(rawText, maxCharacters);

  return ranges.map((range, rangeIndex) => {
    const fragmentDocument = load(`<html><body>${markedHtml}</body></html>`, { xmlMode: false });
    const fragmentRoot = fragmentDocument("body").children().first();
    const fragmentNode = fragmentRoot.get(0) as MutableDomNode | undefined;
    let fragmentOffset = 0;

    if (fragmentNode) {
      walkDom(fragmentNode, (currentNode) => {
        if (currentNode.type !== "text") {
          return;
        }

        const text = currentNode.data ?? "";
        const nodeStart = fragmentOffset;
        const nodeEnd = nodeStart + text.length;
        const overlapStart = Math.max(range.start, nodeStart);
        const overlapEnd = Math.min(range.end, nodeEnd);
        currentNode.data = overlapStart < overlapEnd
          ? text.slice(overlapStart - nodeStart, overlapEnd - nodeStart)
          : "";
        fragmentOffset = nodeEnd;
      });
    }

    fragmentRoot.find(`[${temporaryPositionAttribute}]`).addBack(`[${temporaryPositionAttribute}]`).each((_, positionedNode) => {
      const positionedElement = fragmentDocument(positionedNode);
      const position = Number.parseInt(positionedElement.attr(temporaryPositionAttribute) ?? "", 10);
      const belongsToRange = position >= range.start
        && (position < range.end || (rangeIndex === ranges.length - 1 && position === range.end));

      if (!belongsToRange) {
        if (positionedElement.is("img, svg, image")) {
          positionedElement.remove();
          return;
        }
        positionedElement.removeAttr("id").removeAttr("name").removeAttr("xml:id");
      }

      positionedElement.removeAttr(temporaryPositionAttribute);
    });

    return fragmentDocument.html(fragmentRoot.get(0)) ?? "";
  }).filter((fragment) => normalizeWhitespace(load(fragment).text()).length > 0 || /<(img|svg|image)\b/iu.test(fragment));
}

function splitOversizedParagraphNodes(document: ReturnType<typeof load>): void {
  document("body")
    .find(paragraphSelector)
    .filter((_, node) => document(node).find(paragraphSelector).length === 0)
    .each((_, node) => {
      const element = document(node);
      const paragraphText = normalizeWhitespace(element.text());
      if (paragraphText.length <= maxParagraphCharacters) {
        return;
      }

      const replacementMarkup = splitParagraphMarkup(document.html(node) ?? "", maxParagraphCharacters).join("");

      element.replaceWith(replacementMarkup);
    });
}

function createChunkUnit(
  document: ReturnType<typeof load>,
  node: Parameters<ReturnType<typeof load>["html"]>[0],
  markerId: string
): ChunkUnit | null {
  const element = document(node);
  const html = document.html(node) ?? "";
  const textContent = normalizeWhitespace(element.text());
  const images = element.is("img, svg, image") ? 1 : element.find("img, svg, image").length;
  const paragraphNodes = element
    .find(paragraphSelector)
    .addBack(paragraphSelector)
    .filter((_, paragraphNode) => document(paragraphNode).find(paragraphSelector).length === 0);
  const paragraphCount = paragraphNodes.length;
  const effectiveParagraphCount = paragraphCount > 0 ? paragraphCount : (textContent.length > 0 ? 1 : 0);
  const isHeading = paragraphNodes.first().is(headingSelector);
  const hasRenderableContent = html.trim().length > 0 && (textContent.length > 0 || images > 0 || /<(img|svg|table|hr|figure)\b/iu.test(html));

  if (!hasRenderableContent) {
    return null;
  }

  element.attr(chunkMarkerAttribute, markerId);
  if (paragraphCount === 0 && textContent.length > 0) {
    element.attr(extraParagraphAttribute, "true");
  }

  return {
    characters: textContent.length,
    hasRenderableContent,
    html,
    images,
    isHeading,
    markerId,
    paragraphs: effectiveParagraphCount
  };
}

function attachChunkUnit(
  document: ReturnType<typeof load>,
  node: Parameters<ReturnType<typeof load>["html"]>[0],
  markerId: string,
  state: ChunkCollectionState
): ChunkUnit | null {
  const unit = createChunkUnit(document, node, markerId);
  if (!unit) {
    return null;
  }

  for (const pendingAnchorNode of state.pendingAnchorNodes) {
    document(pendingAnchorNode).attr(chunkMarkerAttribute, markerId);
  }
  state.pendingAnchorNodes = [];
  state.lastMarkerId = markerId;
  return unit;
}

function collectChunkUnits(
  document: ReturnType<typeof load>,
  node: Parameters<ReturnType<typeof load>["html"]>[0],
  state: ChunkCollectionState
): ChunkUnit[] {
  const element = document(node);
  const rawTagName = (node as { name?: string; tagName?: string }).tagName
    ?? (node as { name?: string; tagName?: string }).name;
  const tagName = rawTagName?.toLowerCase() ?? "";
  const nodeType = (node as { type?: string } | undefined)?.type;

  if (nodeType === "text") {
    const text = element.text();
    if (!normalizeWhitespace(text)) {
      return [];
    }

    const textRanges = buildTextRanges(text, maxParagraphCharacters);
    const markerIds = textRanges.map(() => String(state.value++));
    element.replaceWith(textRanges.map((range, index) => (
      `<span ${chunkMarkerAttribute}="${markerIds[index]}" ${temporaryTextWrapperAttribute}="true">${escapeHtmlText(text.slice(range.start, range.end))}</span>`
    )).join(""));

    return markerIds.flatMap((markerId) => {
      const wrappedNode = document(`[${chunkMarkerAttribute}="${markerId}"]`).first().get(0);
      if (!wrappedNode) {
        return [];
      }

      const unit = attachChunkUnit(document, wrappedNode, markerId, state);
      return unit ? [unit] : [];
    });
  }

  const isEmptyAnchor = nodeType === "tag"
    && Boolean(element.attr("id") || element.attr("xml:id") || (element.is("a") && element.attr("name")))
    && normalizeWhitespace(element.text()).length === 0
    && element.find("img, svg, image, table, hr, figure").length === 0;
  if (isEmptyAnchor) {
    state.pendingAnchorNodes.push(node);
    return [];
  }

  const hasNestedParagraphs = element.find(paragraphSelector).length > 0;
  const shouldDescend = nodeType === "tag"
    && structuralWrapperTags.has(tagName)
    && (!(tagName === "li" || tagName === "blockquote") || hasNestedParagraphs);

  if (shouldDescend) {
    const childUnits = element.contents()
      .toArray()
      .flatMap((childNode) => collectChunkUnits(document, childNode, state));

    if (childUnits.length > 0) {
      return childUnits;
    }
  }

  const markerId = String(state.value++);
  const unit = attachChunkUnit(document, node, markerId, state);
  return unit ? [unit] : [];
}

function resolveChunkUnits(document: ReturnType<typeof load>): ChunkUnit[] {
  document(`[${chunkMarkerAttribute}], [${temporaryTextWrapperAttribute}]`)
    .removeAttr(chunkMarkerAttribute)
    .removeAttr(temporaryTextWrapperAttribute);

  document("ol").each((_, node) => {
    const list = document(node);
    const items = list.children("li");
    const reversed = list.is("[reversed]");
    const step = reversed ? -1 : 1;
    let currentValue = Number.parseInt(list.attr("start") ?? "", 10);
    if (!Number.isInteger(currentValue)) {
      currentValue = reversed ? items.length : 1;
    }

    items.each((_, itemNode) => {
      const item = document(itemNode);
      const explicitValue = Number.parseInt(item.attr("value") ?? "", 10);
      if (Number.isInteger(explicitValue)) {
        currentValue = explicitValue;
      } else {
        item.attr("value", String(currentValue));
      }
      currentValue += step;
    });
  });

  const state: ChunkCollectionState = {
    lastMarkerId: null,
    pendingAnchorNodes: [],
    value: 1
  };
  const units = document("body")
    .first()
    .contents()
    .toArray()
    .flatMap((node) => collectChunkUnits(document, node, state));

  if (state.lastMarkerId) {
    for (const pendingAnchorNode of state.pendingAnchorNodes) {
      document(pendingAnchorNode).attr(chunkMarkerAttribute, state.lastMarkerId);
    }
  }

  return units;
}

function createChunkDocument(document: ReturnType<typeof load>, chunkUnits: ChunkUnit[]): ReturnType<typeof load> {
  const selectedMarkerIds = new Set(chunkUnits.map((unit) => unit.markerId));
  const chunkDocument = load(document.html(), { xmlMode: false });

  chunkDocument(`[${chunkMarkerAttribute}]`).each((_, node) => {
    const element = chunkDocument(node);
    if (!selectedMarkerIds.has(element.attr(chunkMarkerAttribute) ?? "")) {
      element.remove();
    }
  });

  const wrapperSelector = Array.from(structuralWrapperTags).join(", ");
  chunkDocument(wrapperSelector).toArray().reverse().forEach((node) => {
    const element = chunkDocument(node);
    const hasContent = normalizeWhitespace(element.text()).length > 0
      || element.find("img, svg, image, table, hr, figure").length > 0
      || Boolean(element.attr("id") || element.attr("xml:id") || element.attr("name"));
    if (!hasContent) {
      element.remove();
    }
  });

  chunkDocument(`[${chunkMarkerAttribute}]`).removeAttr(chunkMarkerAttribute);

  return chunkDocument;
}

/*
 * Paragraph-like containers such as list items and blockquotes are annotated at
 * their deepest textual node so HTML and persisted paragraph counts stay aligned.
 */
function findParagraphNodes(document: ReturnType<typeof load>, includeExtraParagraphs = false) {
  const selector = includeExtraParagraphs
    ? `${paragraphSelector}, [${extraParagraphAttribute}]`
    : paragraphSelector;

  return document("body")
    .find(selector)
    .filter((_, node) => document(node).find(selector).length === 0);
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
    const separatorCharacters = currentChunk.length > 0 ? 1 : 0;
    const wouldExceedCharacters = currentChunk.length > 0
      && currentCharacters + separatorCharacters + unit.characters > maxChunkCharacters;
    const wouldExceedParagraphs = currentChunk.length > 0 && currentParagraphs + unit.paragraphs > maxChunkParagraphs;
    const shouldBreakBeforeHeading = currentChunk.length > 0 && unit.isHeading && currentParagraphs >= Math.max(4, Math.floor(maxChunkParagraphs / 2));

    if (wouldExceedCharacters || wouldExceedParagraphs || shouldBreakBeforeHeading) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentCharacters = 0;
      currentParagraphs = 0;
    }

    const addedSeparatorCharacters = currentChunk.length > 0 ? 1 : 0;
    currentChunk.push(unit);
    currentCharacters += addedSeparatorCharacters + unit.characters;
    currentParagraphs += unit.paragraphs;
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function annotateParagraphNodes(document: ReturnType<typeof load>, includeExtraParagraphs = false): string[] {
  const paragraphs: string[] = [];

  findParagraphNodes(document, includeExtraParagraphs)
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
      element.removeAttr(extraParagraphAttribute).removeAttr(temporaryTextWrapperAttribute);
    });

  return paragraphs;
}

function annotateFallbackParagraph(document: ReturnType<typeof load>, rawText: string): string[] {
  if (!rawText) {
    return [];
  }

  const body = document("body").first();
  body.find(`[${temporaryTextWrapperAttribute}]`).each((_, node) => {
    const element = document(node);
    element.replaceWith(element.html() ?? "");
  });
  body.find(`[${extraParagraphAttribute}]`).removeAttr(extraParagraphAttribute);
  body.html(`<div class="reader-rich-node" data-paragraph-number="1" role="button" tabindex="0">${body.html() ?? ""}</div>`);
  return [rawText];
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
  splitOversizedParagraphNodes(document);
  const units = resolveChunkUnits(document);

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
    const chunkDocument = createChunkDocument(document, chunkUnits);

    const hasStandardParagraphs = findParagraphNodes(chunkDocument).length > 0;
    let paragraphs = annotateParagraphNodes(chunkDocument, hasStandardParagraphs);
    const rawText = normalizeWhitespace(chunkDocument("body").text());
    if (paragraphs.length === 0) {
      paragraphs = annotateFallbackParagraph(chunkDocument, rawText);
    }
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

function findNavigationTocRoot(document: ReturnType<typeof load>): Parameters<ReturnType<typeof load>>[0] | null {
  let tocRoot: Parameters<ReturnType<typeof load>>[0] | null = null;

  document("nav").each((_, node) => {
    const element = document(node);
    const epubType = element.attr("epub:type") ?? element.attr("type") ?? "";
    const role = element.attr("role") ?? "";
    const epubTypeTokens = epubType.split(/\s+/u).filter(Boolean);
    const roleTokens = role.split(/\s+/u).filter(Boolean);

    if (epubTypeTokens.includes("toc") || roleTokens.includes("doc-toc")) {
      tocRoot = element;
      return false;
    }

    return undefined;
  });

  return tocRoot;
}

function extractNavigationEntriesFromList(
  document: ReturnType<typeof load>,
  listElement: Parameters<ReturnType<typeof load>>[0],
  baseEntryPath: string,
  level: number,
  entries: TocReferenceEntry[]
): void {
  document(listElement).children("li").each((_, itemNode) => {
    const listItem = document(itemNode);
    const labelContainer = listItem.children().not("ol, ul");
    const directAnchor = labelContainer.filter("a[href]").first();
    const anchor = directAnchor.length > 0 ? directAnchor : labelContainer.find("a[href]").first();
    const title = normalizeWhitespace(anchor.length > 0 ? anchor.text() : labelContainer.first().text());

    if (anchor.length > 0 && title) {
      const href = anchor.attr("href");
      const resolvedTarget = href ? resolveInternalReference(baseEntryPath, href) : null;
      if (resolvedTarget) {
        entries.push({
          ...resolvedTarget,
          level: Math.min(6, Math.max(1, level)),
          title
        });
      }
    }

    listItem.children("ol, ul").each((_, childList) => {
      extractNavigationEntriesFromList(document, childList, baseEntryPath, level + 1, entries);
    });
  });
}

function extractNavTocEntries(parsedArchive: ParsedEpubArchive): TocReferenceEntry[] {
  for (const manifestItem of parsedArchive.manifest.values()) {
    if (!manifestItem.properties.has("nav") || !/html|xhtml/u.test(manifestItem.mediaType)) {
      continue;
    }

    const entryPath = resolveZipPath(parsedArchive.opfDirectory, manifestItem.href);
    const navigationEntry = findArchiveEntry(parsedArchive.archive, entryPath);
    if (!navigationEntry) {
      continue;
    }

    const document = load(navigationEntry.getData().toString("utf-8"), {
      xmlMode: false
    });
    const tocRoot = findNavigationTocRoot(document);
    if (!tocRoot) {
      continue;
    }

    const listRoot = document(tocRoot).children("ol, ul").first();
    if (listRoot.length === 0) {
      continue;
    }

    const entries: TocReferenceEntry[] = [];
    extractNavigationEntriesFromList(document, listRoot.get(0), entryPath, 1, entries);
    if (entries.length > 0) {
      return entries;
    }
  }

  return [];
}

function extractNcxNavPoints(
  document: ReturnType<typeof load>,
  navPoint: Parameters<ReturnType<typeof load>>[0],
  baseEntryPath: string,
  level: number,
  entries: TocReferenceEntry[]
): void {
  const point = document(navPoint);
  const title = normalizeWhitespace(point.children("navLabel").first().text());
  const source = point.children("content").attr("src");
  const resolvedTarget = source ? resolveInternalReference(baseEntryPath, source) : null;

  if (resolvedTarget && title) {
    entries.push({
      ...resolvedTarget,
      level: Math.min(6, Math.max(1, level)),
      title
    });
  }

  point.children("navPoint").each((_, childPoint) => {
    extractNcxNavPoints(document, childPoint, baseEntryPath, level + 1, entries);
  });
}

function extractNcxTocEntries(parsedArchive: ParsedEpubArchive): TocReferenceEntry[] {
  const manifestItemIds: string[] = [];
  const spineTocId = parsedArchive.opfDocument("spine").attr("toc");

  if (spineTocId) {
    manifestItemIds.push(spineTocId);
  }

  for (const [itemId, manifestItem] of parsedArchive.manifest.entries()) {
    if (manifestItem.mediaType === "application/x-dtbncx+xml" && !manifestItemIds.includes(itemId)) {
      manifestItemIds.push(itemId);
    }
  }

  for (const itemId of manifestItemIds) {
    const manifestItem = parsedArchive.manifest.get(itemId);
    if (!manifestItem) {
      continue;
    }

    const entryPath = resolveZipPath(parsedArchive.opfDirectory, manifestItem.href);
    const tocEntry = findArchiveEntry(parsedArchive.archive, entryPath);
    if (!tocEntry) {
      continue;
    }

    const document = load(tocEntry.getData().toString("utf-8"), {
      xmlMode: true
    });
    const entries: TocReferenceEntry[] = [];

    document("navMap > navPoint").each((_, navPoint) => {
      extractNcxNavPoints(document, navPoint, entryPath, 1, entries);
    });

    if (entries.length > 0) {
      return entries;
    }
  }

  return [];
}

function extractTocEntries(parsedArchive: ParsedEpubArchive): TocReferenceEntry[] {
  const navigationEntries = extractNavTocEntries(parsedArchive);
  if (navigationEntries.length > 0) {
    return navigationEntries;
  }

  return extractNcxTocEntries(parsedArchive);
}

function resolveParagraphNumberForNode(document: ReturnType<typeof load>, node: Parameters<ReturnType<typeof load>>[0]): number | null {
  const element = document(node);
  const ownParagraphNumber = parsePositiveInteger(element.attr("data-paragraph-number"));
  if (ownParagraphNumber) {
    return ownParagraphNumber;
  }

  for (const ancestor of element.parents().toArray()) {
    const ancestorParagraphNumber = parsePositiveInteger(document(ancestor).attr("data-paragraph-number"));
    if (ancestorParagraphNumber) {
      return ancestorParagraphNumber;
    }
  }

  const descendantParagraphNumber = parsePositiveInteger(element.find("[data-paragraph-number]").first().attr("data-paragraph-number"));
  if (descendantParagraphNumber) {
    return descendantParagraphNumber;
  }

  return null;
}

function registerPageAnchorTargets(
  lookup: PageAnchorLookup,
  entryPath: string,
  pageNumber: number,
  htmlContent: string | null | undefined
): void {
  const normalizedEntryPath = normalizeArchiveLookupPath(entryPath);
  const fallbackTarget = {
    pageNumber,
    paragraphNumber: 1
  } satisfies PageAnchorTarget;

  if (htmlContent) {
    const document = load(htmlContent, {
      xmlMode: false
    });
    fallbackTarget.paragraphNumber = parsePositiveInteger(document("[data-paragraph-number]").first().attr("data-paragraph-number")) ?? 1;

    document("[id], [xml\\:id], a[name]").each((_, node) => {
      const element = document(node);
      const fragment = element.attr("id") ?? element.attr("xml:id") ?? element.attr("name");
      if (!fragment) {
        return;
      }

      const target = {
        pageNumber,
        paragraphNumber: resolveParagraphNumberForNode(document, node) ?? fallbackTarget.paragraphNumber
      } satisfies PageAnchorTarget;

      for (const key of buildFragmentLookupKeys(normalizedEntryPath, fragment)) {
        if (!lookup.fragmentTargets.has(key)) {
          lookup.fragmentTargets.set(key, target);
        }
      }
    });
  }

  if (!lookup.entryTargets.has(normalizedEntryPath)) {
    lookup.entryTargets.set(normalizedEntryPath, fallbackTarget);
  }
}

function resolveTocTarget(lookup: PageAnchorLookup, entry: TocReferenceEntry): PageAnchorTarget | null {
  if (entry.fragment) {
    for (const key of buildFragmentLookupKeys(entry.entryPath, entry.fragment)) {
      const fragmentTarget = lookup.fragmentTargets.get(key);
      if (fragmentTarget) {
        return fragmentTarget;
      }
    }
  }

  return lookup.entryTargets.get(entry.entryPath) ?? null;
}

function rewritePageInternalLinks(
  htmlContent: string | null | undefined,
  entryPath: string,
  lookup: PageAnchorLookup
): string | null {
  if (!htmlContent) {
    return null;
  }

  const document = load(htmlContent, { xmlMode: false });
  document("a[href]").each((_, node) => {
    const element = document(node);
    const originalHref = element.attr("href")?.trim();
    const resolvedReference = originalHref ? resolveInternalReference(entryPath, originalHref) : null;
    if (!originalHref || !resolvedReference) {
      return;
    }

    const target = resolvedReference.fragment
      ? buildFragmentLookupKeys(resolvedReference.entryPath, resolvedReference.fragment)
        .map((key) => lookup.fragmentTargets.get(key))
        .find((candidate): candidate is PageAnchorTarget => candidate !== undefined) ?? null
      : lookup.entryTargets.get(normalizeArchiveLookupPath(resolvedReference.entryPath)) ?? null;
    if (!target) {
      return;
    }

    element.attr("data-lector-epub-href", originalHref);
    element.attr("data-lector-page", String(target.pageNumber));
    element.attr("data-lector-paragraph", String(target.paragraphNumber));
    element.attr("href", `?page=${target.pageNumber}&paragraph=${target.paragraphNumber}`);
  });

  return document("body").html()?.trim() || null;
}

function buildOutlineFromTocEntries(tocEntries: TocReferenceEntry[], lookup: PageAnchorLookup): ImportedOutlineEntry[] {
  const outline: ImportedOutlineEntry[] = [];
  const seenEntries = new Set<string>();

  for (const entry of tocEntries) {
    const target = resolveTocTarget(lookup, entry);
    if (!target) {
      continue;
    }

    const entryKey = `${target.pageNumber}:${target.paragraphNumber}:${entry.title}`;
    if (seenEntries.has(entryKey)) {
      continue;
    }

    seenEntries.add(entryKey);
    outline.push({
      level: entry.level,
      pageNumber: target.pageNumber,
      paragraphNumber: target.paragraphNumber,
      title: entry.title
    });
  }

  return outline;
}

function openEpubArchive(fileBuffer: Buffer): ParsedEpubArchive {
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
      manifest.set(id, {
        href,
        mediaType,
        properties: new Set((item.attr("properties") ?? "").split(/\s+/u).map((value) => value.trim()).filter(Boolean))
      });
    }
  });

  const spineItemIds: string[] = [];
  opfDocument("spine > itemref").each((_, element) => {
    const idReference = opfDocument(element).attr("idref");
    if (idReference) {
      spineItemIds.push(idReference);
    }
  });

  return {
    archive,
    manifest,
    opfDirectory,
    opfDocument,
    spineItemIds
  };
}

function resolveManifestItemAsset(parsedArchive: ParsedEpubArchive, manifestItem: ManifestItem): ImportedBinaryAsset | null {
  const entryPath = resolveZipPath(parsedArchive.opfDirectory, manifestItem.href);
  const assetEntry = findArchiveEntry(parsedArchive.archive, entryPath);
  if (!assetEntry) {
    return null;
  }

  if (manifestItem.mediaType.startsWith("image/")) {
    return {
      buffer: assetEntry.getData(),
      fileName: basenamePath(entryPath) || "cover-image",
      mimeType: manifestItem.mediaType
    };
  }

  if (/html|xhtml/u.test(manifestItem.mediaType)) {
    return extractFirstImageAssetFromDocument(parsedArchive.archive, entryPath);
  }

  return null;
}

function extractFirstImageAssetFromDocument(archive: AdmZip, entryPath: string): ImportedBinaryAsset | null {
  const contentEntry = findArchiveEntry(archive, entryPath);
  if (!contentEntry) {
    return null;
  }

  const document = load(contentEntry.getData().toString("utf-8"), {
    xmlMode: false
  });
  const documentDirectory = dirnamePath(entryPath);
  let resolvedAsset: ImportedBinaryAsset | null = null;

  const resolveSource = (source: string | undefined) => {
    if (resolvedAsset || !source || isEmbeddedDataReference(source) || isRemoteAssetReference(source) || isUnsafeAssetReference(source)) {
      return;
    }

    const resolvedEntryPath = resolveZipPath(documentDirectory, source);
    const assetEntry = findArchiveEntry(archive, resolvedEntryPath);
    if (!assetEntry) {
      return;
    }

    resolvedAsset = {
      buffer: assetEntry.getData(),
      fileName: basenamePath(resolvedEntryPath) || "cover-image",
      mimeType: inferMimeTypeFromPath(resolvedEntryPath)
    };
  };

  document("img[src]").each((_, node) => {
    resolveSource(document(node).attr("src"));
  });

  if (resolvedAsset) {
    return resolvedAsset;
  }

  document("image").each((_, node) => {
    resolveSource(document(node).attr("href") ?? document(node).attr("xlink:href"));
  });

  return resolvedAsset;
}

function extractCoverFromParsedArchive(parsedArchive: ParsedEpubArchive): ImportedBinaryAsset | null {
  const coverId = parsedArchive.opfDocument("metadata > meta[name='cover']").attr("content")
    ?? parsedArchive.opfDocument("package > metadata > meta[name='cover']").attr("content");

  if (coverId) {
    const manifestItem = parsedArchive.manifest.get(coverId);
    if (manifestItem) {
      const asset = resolveManifestItemAsset(parsedArchive, manifestItem);
      if (asset) {
        return asset;
      }
    }
  }

  for (const manifestItem of parsedArchive.manifest.values()) {
    if (!manifestItem.properties.has("cover-image")) {
      continue;
    }

    const asset = resolveManifestItemAsset(parsedArchive, manifestItem);
    if (asset) {
      return asset;
    }
  }

  for (const itemId of parsedArchive.spineItemIds) {
    const manifestItem = parsedArchive.manifest.get(itemId);
    if (!manifestItem || !/html|xhtml/u.test(manifestItem.mediaType)) {
      continue;
    }

    const entryPath = resolveZipPath(parsedArchive.opfDirectory, manifestItem.href);
    const asset = extractFirstImageAssetFromDocument(parsedArchive.archive, entryPath);
    if (asset) {
      return asset;
    }
  }

  return null;
}

export function extractEpubCover(fileBuffer: Buffer): ImportedBinaryAsset | null {
  return extractCoverFromParsedArchive(openEpubArchive(fileBuffer));
}

export async function parseEpubBuffer(fileBuffer: Buffer): Promise<ImportedDocument> {
  const parsedArchive = openEpubArchive(fileBuffer);
  const coverImage = extractCoverFromParsedArchive(parsedArchive);
  const tocEntries = extractTocEntries(parsedArchive);

  const pages: ImportedPage[] = [];
  const pageEntryPaths: string[] = [];
  const pageAnchorLookup: PageAnchorLookup = {
    entryTargets: new Map(),
    fragmentTargets: new Map()
  };
  const preparedDocuments: PreparedSpineDocument[] = [];

  for (const idReference of parsedArchive.spineItemIds) {
    const manifestItem = parsedArchive.manifest.get(idReference);
    if (!manifestItem || !/html|xhtml/u.test(manifestItem.mediaType)) {
      continue;
    }

    const entryPath = resolveZipPath(parsedArchive.opfDirectory, manifestItem.href);
    const contentEntry = findArchiveEntry(parsedArchive.archive, entryPath);
    if (!contentEntry) {
      continue;
    }

    const document = load(contentEntry.getData().toString("utf-8"), {
      xmlMode: false
    });
    const documentDirectory = dirnamePath(entryPath);

    document("br").replaceWith("\n");

    const inlineStyles = inlineLinkedStyles(document, documentDirectory, parsedArchive.archive);
    inlineBinaryAssets(document, documentDirectory, parsedArchive.archive);
    sanitizeDocumentMarkup(document);

    preparedDocuments.push({ document, entryPath, inlineStyles });
  }

  const headingOffsets = preparedDocuments.flatMap((preparedDocument) => normalizeDocumentHeadingsFromToc(preparedDocument, tocEntries));
  const dominantHeadingOffset = [...new Map(
    headingOffsets.map((offset) => [offset, headingOffsets.filter((candidate) => candidate === offset).length])
  ).entries()].sort((left, right) => right[1] - left[1] || Math.abs(left[0]) - Math.abs(right[0]))[0]?.[0] ?? 0;

  for (const preparedDocument of preparedDocuments) {
    const { document, entryPath, inlineStyles } = preparedDocument;
    applyHeadingLevelOffset(document, dominantHeadingOffset);

    const chunkedPages = createPagesFromDocument(document, inlineStyles);

    for (const chunkedPage of chunkedPages) {
      const pageNumber = pages.length + 1;
      registerPageAnchorTargets(pageAnchorLookup, entryPath, pageNumber, chunkedPage.htmlContent ?? null);

      pages.push({
        htmlContent: chunkedPage.htmlContent ?? null,
        pageNumber,
        paragraphs: chunkedPage.paragraphs,
        rawText: chunkedPage.rawText
      });
      pageEntryPaths.push(entryPath);
    }
  }

  for (const [pageIndex, page] of pages.entries()) {
    page.htmlContent = rewritePageInternalLinks(page.htmlContent, pageEntryPaths[pageIndex] ?? "", pageAnchorLookup);
  }

  const outlineEntries = tocEntries.length > 0
    ? buildOutlineFromTocEntries(tocEntries, pageAnchorLookup)
    : [];

  return {
    coverImage,
    ...(outlineEntries.length > 0 ? { outlineEntries } : {}),
    pages,
    totalPages: pages.length,
    totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
  };
}
