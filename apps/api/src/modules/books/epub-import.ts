import AdmZip from "adm-zip";
import { load } from "cheerio";

import type { ImportedDocument, ImportedPage } from "./book-import.js";

type ManifestItem = {
  href: string;
  mediaType: string;
};

function normalizeZipEntryName(entryName: string): string {
  return entryName.replace(/\\/g, "/");
}

function findArchiveEntry(archive: AdmZip, entryPath: string) {
  const normalizedEntryPath = normalizeZipEntryName(entryPath);

  return archive.getEntries().find((entry) => normalizeZipEntryName(entry.entryName) === normalizedEntryPath);
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

  opfDocument("spine > itemref").each((index, element) => {
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

    const document = load(contentEntry.getData().toString("utf-8"));
    document("script, style, noscript, svg").remove();
    document("br").replaceWith("\n");

    const paragraphs = document("body")
      .find("p, h1, h2, h3, h4, h5, h6, li, blockquote")
      .map((_, node) => normalizeWhitespace(document(node).text()))
      .get()
      .filter(Boolean);

    const rawText = normalizeWhitespace(document("body").text());

    pages.push({
      pageNumber: index + 1,
      paragraphs: paragraphs.length > 0 ? paragraphs : fallbackParagraphsFromText(rawText),
      rawText
    });
  });

  return {
    pages,
    totalPages: pages.length,
    totalParagraphs: pages.reduce((count, page) => count + page.paragraphs.length, 0)
  };
}