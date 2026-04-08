import { Buffer } from "node:buffer";

import AdmZip from "adm-zip";
import { load } from "cheerio";
import PDFDocument from "pdfkit";

import type { BookOutlineEntry } from "./book-outline.js";

type ExportBook = {
  authorName: string | null;
  synopsis: string | null;
  title: string;
};

type ExportPage = {
  htmlContent: string | null;
  pageLabel: string | null;
  pageNumber: number;
  paragraphs: Array<{ paragraphText: string }>;
};

type ExportCoverAsset = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
} | null;

type RenderBlock = {
  alignment?: "center" | "justify" | "left" | "right";
  level?: number;
  source?: string;
  text?: string;
  type: "blockquote" | "heading" | "image" | "list-item" | "paragraph";
};

function resolveBlockAlignment(
  explicitAlignmentValue: string | undefined,
  styleAttribute: string | undefined
): "center" | "justify" | "left" | "right" | undefined {
  const explicitAlignment = explicitAlignmentValue?.trim().toLowerCase();
  if (explicitAlignment === "left" || explicitAlignment === "center" || explicitAlignment === "right" || explicitAlignment === "justify") {
    return explicitAlignment;
  }

  const styleMatch = (styleAttribute ?? "").match(/text-align\s*:\s*(left|center|right|justify)/iu);
  const styleAlignment = styleMatch?.[1]?.toLowerCase();
  if (styleAlignment === "left" || styleAlignment === "center" || styleAlignment === "right" || styleAlignment === "justify") {
    return styleAlignment;
  }

  return undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function buildFallbackHtml(page: ExportPage): string {
  const body = page.paragraphs
    .map((paragraph, index) => `<p class="reader-rich-node" data-paragraph-number="${index + 1}" role="button" tabindex="0">${escapeXml(paragraph.paragraphText)}</p>`)
    .join("");

  return `<div class="epub-page-shell"><div class="epub-page-body">${body}</div></div>`;
}

function buildPageDocumentTitle(book: ExportBook, page: ExportPage) {
  return `${book.title} · Página ${page.pageLabel ?? page.pageNumber}`;
}

function createContentDocument(book: ExportBook, page: ExportPage): string {
  const htmlContent = page.htmlContent ?? buildFallbackHtml(page);

  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(buildPageDocumentTitle(book, page))}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    ${htmlContent}
  </body>
</html>`;
}

function mimeTypeToExtension(mimeType: string): string {
  if (/png/u.test(mimeType)) {
    return "png";
  }

  if (/webp/u.test(mimeType)) {
    return "webp";
  }

  if (/svg/u.test(mimeType)) {
    return "svg";
  }

  return "jpg";
}

function extractRenderableBlocks(page: ExportPage): RenderBlock[] {
  const html = page.htmlContent ?? buildFallbackHtml(page);
  const document = load(html);
  const root = document(".epub-page-body").first();
  const blocks: RenderBlock[] = [];

  function visit(node: unknown) {
    const element = document(node as string);
    const tagName = element.prop("tagName")?.toLowerCase();
    if (!tagName) {
      return;
    }

    if (/^h[1-6]$/u.test(tagName)) {
      const text = normalizeWhitespace(element.text());
      if (text) {
        const alignment = resolveBlockAlignment(element.attr("data-text-align"), element.attr("style"));
        blocks.push({
          ...(alignment ? { alignment } : {}),
          level: Number.parseInt(tagName.replace("h", ""), 10),
          text,
          type: "heading"
        });
      }
      return;
    }

    if (tagName === "p") {
      const text = normalizeWhitespace(element.text());
      if (text) {
        const alignment = resolveBlockAlignment(element.attr("data-text-align"), element.attr("style"));
        blocks.push({ ...(alignment ? { alignment } : {}), text, type: "paragraph" });
      }
      return;
    }

    if (tagName === "blockquote") {
      const text = normalizeWhitespace(element.text());
      if (text) {
        const alignment = resolveBlockAlignment(element.attr("data-text-align"), element.attr("style"));
        blocks.push({ ...(alignment ? { alignment } : {}), text, type: "blockquote" });
      }
      return;
    }

    if (tagName === "li") {
      const text = normalizeWhitespace(element.text());
      if (text) {
        const alignment = resolveBlockAlignment(element.attr("data-text-align"), element.attr("style"));
        blocks.push({ ...(alignment ? { alignment } : {}), text, type: "list-item" });
      }
      return;
    }

    if (tagName === "img") {
      const source = element.attr("src")?.trim();
      if (source) {
        blocks.push({ source, type: "image" });
      }
      return;
    }

    element.children().each((_, child) => {
      visit(document(child));
    });
  }

  root.children().each((_, child) => {
    visit(document(child));
  });

  return blocks;
}

function renderPdfPageFooter(document: PDFKit.PDFDocument, pageLabel: string) {
  const footerWidth = document.page.width - document.page.margins.left - document.page.margins.right;
  const footerY = document.page.height - document.page.margins.bottom - 12;

  document
    .font("Helvetica")
    .fontSize(10)
    .fillColor("#666666")
    .text(pageLabel, document.page.margins.left, footerY, {
      align: "center",
      lineBreak: false,
      width: footerWidth
    });
}

function renderPdfBlocks(document: PDFKit.PDFDocument, blocks: RenderBlock[]) {
  for (const block of blocks) {
    if (block.type === "heading" && block.text) {
      const fontSize = Math.max(16, 28 - ((block.level ?? 1) - 1) * 2);
      document.moveDown(0.5);
      document.font("Helvetica-Bold").fontSize(fontSize).fillColor("#111111").text(block.text, {
        align: block.alignment ?? "left"
      });
      document.moveDown(0.35);
      continue;
    }

    if (block.type === "blockquote" && block.text) {
      document.font("Helvetica-Oblique").fontSize(12).fillColor("#333333").text(block.text, {
        align: block.alignment ?? "left",
        indent: 24,
        paragraphGap: 10
      });
      continue;
    }

    if (block.type === "list-item" && block.text) {
      document.font("Helvetica").fontSize(12).fillColor("#1f1f1f").text(`• ${block.text}`, {
        align: block.alignment ?? "left",
        indent: 12,
        paragraphGap: 6
      });
      continue;
    }

    if (block.type === "image" && block.source) {
      if (/^data:image\//u.test(block.source)) {
        try {
          const [, mimeMetadata, dataPart] = block.source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/u) ?? [];
          if (mimeMetadata && dataPart) {
            const imageBuffer = Buffer.from(dataPart, "base64");
            const maxWidth = document.page.width - 100;
            const maxHeight = document.page.height * 0.35;
            document.image(imageBuffer, {
              fit: [maxWidth, maxHeight],
              align: "center"
            });
            document.moveDown();
          }
        } catch {
          // Ignore broken inline images during PDF export.
        }
      }
      continue;
    }

    if (block.text) {
      document.font("Helvetica").fontSize(12).fillColor("#1f1f1f").text(block.text, {
        align: block.alignment ?? "justify",
        paragraphGap: 10
      });
    }
  }
}

export async function buildEpubExport(options: {
  book: ExportBook;
  coverAsset: ExportCoverAsset;
  outline: BookOutlineEntry[];
  pages: ExportPage[];
}): Promise<Buffer> {
  const archive = new AdmZip();
  const timestamp = new Date().toISOString();
  const contentFiles = options.pages.map((page) => ({
    fileName: `OEBPS/page-${String(page.pageNumber).padStart(4, "0")}.xhtml`,
    id: `page-${page.pageNumber}`,
    page
  }));

  archive.addFile("mimetype", Buffer.from("application/epub+zip", "utf-8"));
  archive.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`, "utf-8"));

  for (const contentFile of contentFiles) {
    archive.addFile(contentFile.fileName, Buffer.from(createContentDocument(options.book, contentFile.page), "utf-8"));
  }

  let coverFileName: string | null = null;
  if (options.coverAsset) {
    const extension = mimeTypeToExtension(options.coverAsset.mimeType);
    coverFileName = `OEBPS/assets/cover.${extension}`;
    archive.addFile(coverFileName, options.coverAsset.buffer);
    archive.addFile("OEBPS/cover.xhtml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${escapeXml(options.book.title)}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <section>
      <img alt="Portada" src="assets/cover.${extension}" style="max-width: 100%; height: auto;" />
      <h1>${escapeXml(options.book.title)}</h1>
      ${options.book.authorName ? `<p>${escapeXml(options.book.authorName)}</p>` : ""}
    </section>
  </body>
</html>`, "utf-8"));
  }

  const navItems = options.outline
    .map((entry) => `<li><a href="page-${String(entry.pageNumber).padStart(4, "0")}.xhtml#p-${entry.pageNumber}-${entry.paragraphNumber}">${escapeXml(entry.title)}</a></li>`)
    .join("");

  archive.addFile("OEBPS/nav.xhtml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Índice</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>Índice</h1>
      <ol>${navItems}</ol>
    </nav>
  </body>
</html>`, "utf-8"));

  const manifestItems = [
    `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
    ...contentFiles.map((contentFile) => `<item id="${contentFile.id}" href="${contentFile.fileName.replace(/^OEBPS\//u, "")}" media-type="application/xhtml+xml"/>`)
  ];
  const spineItems = [
    ...(coverFileName ? ["<itemref idref=\"cover-page\"/>"] : []),
    ...contentFiles.map((contentFile) => `<itemref idref="${contentFile.id}"/>`)
  ];

  if (coverFileName) {
    const extension = coverFileName.split(".").pop() ?? "jpg";
    const mediaType = extension === "png"
      ? "image/png"
      : extension === "webp"
        ? "image/webp"
        : extension === "svg"
          ? "image/svg+xml"
          : "image/jpeg";
    manifestItems.unshift(`<item id="cover-image" href="assets/cover.${extension}" media-type="${mediaType}" properties="cover-image"/>`);
    manifestItems.unshift(`<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
  }

  archive.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(options.book.title.toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "lector-book")}</dc:identifier>
    <dc:title>${escapeXml(options.book.title)}</dc:title>
    ${options.book.authorName ? `<dc:creator>${escapeXml(options.book.authorName)}</dc:creator>` : ""}
    <dc:language>es</dc:language>
    <meta property="dcterms:modified">${timestamp.replace(/\.\d{3}Z$/u, "Z")}</meta>
    ${coverFileName ? "<meta name=\"cover\" content=\"cover-image\" />" : ""}
  </metadata>
  <manifest>
    ${manifestItems.join("\n    ")}
  </manifest>
  <spine>
    ${spineItems.join("\n    ")}
  </spine>
</package>`, "utf-8"));

  return archive.toBuffer();
}

export async function buildPdfExport(options: {
  book: ExportBook;
  coverAsset: ExportCoverAsset;
  outline: BookOutlineEntry[];
  pages: ExportPage[];
}): Promise<Buffer> {
  const document = new PDFDocument({ autoFirstPage: false, margin: 50, size: "A4" });
  const chunks: Buffer[] = [];

  document.on("data", (chunk) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  const finishPromise = new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);
  });

  let prefixPages = 0;

  if (options.coverAsset) {
    prefixPages += 1;
    document.addPage();
    document.image(options.coverAsset.buffer, 50, 60, {
      fit: [document.page.width - 100, document.page.height * 0.6],
      align: "center"
    });
    document.moveDown(20);
    document.font("Helvetica-Bold").fontSize(26).fillColor("#111111").text(options.book.title, { align: "center" });
    if (options.book.authorName) {
      document.moveDown();
      document.font("Helvetica").fontSize(14).fillColor("#444444").text(options.book.authorName, { align: "center" });
    }
    renderPdfPageFooter(document, "1");
  }

  if (options.outline.length > 0) {
    prefixPages += 1;
    document.addPage();
    document.font("Helvetica-Bold").fontSize(24).fillColor("#111111").text("Índice");
    document.moveDown();
    for (const entry of options.outline) {
      const physicalPageNumber = prefixPages + entry.pageNumber;
      document.font("Helvetica").fontSize(12).fillColor("#1f1f1f").text(`${"  ".repeat(Math.max(0, entry.level - 1))}${entry.title}`, {
        continued: true,
        indent: Math.max(0, entry.level - 1) * 14
      });
      document.text(String(physicalPageNumber), { align: "right" });
    }
    renderPdfPageFooter(document, String(prefixPages));
  }

  for (const page of options.pages) {
    const physicalPageNumber = prefixPages + page.pageNumber;
    document.addPage();
    document.font("Helvetica").fontSize(10).fillColor("#666666").text(`Página ${page.pageLabel ?? page.pageNumber}`, { align: "right" });
    document.moveDown(0.5);
    renderPdfBlocks(document, extractRenderableBlocks(page));
    renderPdfPageFooter(document, String(physicalPageNumber));
  }

  document.end();
  return finishPromise;
}