import { Buffer } from "node:buffer";

import AdmZip from "adm-zip";
import { load } from "cheerio";
import PDFDocument from "pdfkit";
import sharp from "sharp";

import type { BookOutlineEntry } from "./book-outline.js";
import type { BookLanguageCode } from "./book-import.js";
import { renderBookHtmlPdf } from "./html-pdf.js";

type ExportBook = {
  authorName: string | null;
  languageCode: BookLanguageCode;
  synopsis: string | null;
  title: string;
};

type ExportPage = {
  htmlContent: string | null;
  pageLabel: string | null;
  pageNumber: number;
  paragraphs: Array<{ paragraphText: string; paragraphNumber?: number; active?: boolean | number }>;
};

type ExportCoverAsset = {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
} | null;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildFallbackHtml(page: ExportPage): string {
  const body = page.paragraphs
    .map((paragraph, index) => paragraph.active === false || paragraph.active === 0
      ? ""
      : `<p class="reader-rich-node" data-paragraph-number="${paragraph.paragraphNumber ?? index + 1}" role="button" tabindex="0">${escapeXml(paragraph.paragraphText)}</p>`)
    .join("");

  return `<div class="epub-page-shell"><div class="epub-page-body">${body}</div></div>`;
}

function buildPageDocumentTitle(book: ExportBook, page: ExportPage) {
  return `${book.title} · ${book.languageCode === "it" ? "Pagina" : "Página"} ${page.pageLabel ?? page.pageNumber}`;
}

function getActivePageHtml(page: ExportPage): string {
  const html = page.htmlContent ?? buildFallbackHtml(page);
  const document = load(html, null, false);
  const inactiveElements = document("[data-is-active], [data-active]").filter((_, node) => {
    return ["data-is-active", "data-active"].some((attribute) => {
      const value = document(node).attr(attribute)?.trim().toLowerCase();
      return value === "false" || value === "0";
    });
  });
  if (inactiveElements.length === 0) return html;
  inactiveElements.remove();
  return document.html();
}

function createContentDocument(book: ExportBook, page: ExportPage): string {
  const htmlContent = getActivePageHtml(page);

  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${book.languageCode}" xml:lang="${book.languageCode}">
  <head>
    <title>${escapeXml(buildPageDocumentTitle(book, page))}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    ${htmlContent}
  </body>
</html>`;
}

export async function buildEpubExport(options: {
  book: ExportBook;
  coverAsset: ExportCoverAsset;
  outline: BookOutlineEntry[];
  pages: ExportPage[];
}): Promise<Buffer> {
  const archive = new AdmZip();
  const timestamp = new Date().toISOString();
  const indexLabel = options.book.languageCode === "it" ? "Indice" : "Índice";
  const coverLabel = options.book.languageCode === "it" ? "Copertina" : "Portada";
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
  let coverMediaType = "image/jpeg";
  if (options.coverAsset) {
    const normalizedCoverBuffer = await sharp(options.coverAsset.buffer).jpeg({ quality: 92 }).toBuffer();
    coverFileName = "OEBPS/assets/cover.jpg";
    coverMediaType = "image/jpeg";
    archive.addFile(coverFileName, normalizedCoverBuffer);
    archive.addFile("OEBPS/cover.xhtml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" lang="${options.book.languageCode}" xml:lang="${options.book.languageCode}">
  <head>
    <title>${escapeXml(options.book.title)}</title>
    <meta charset="utf-8" />
    <style type="text/css">
      .cover-page {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 95vh;
        padding: 1rem;
        box-sizing: border-box;
      }
      .cover-page img {
        max-width: 100%;
        max-height: 90vh;
        height: auto;
        object-fit: contain;
      }
    </style>
  </head>
  <body>
    <section class="cover-page">
      <img alt="${coverLabel}" src="assets/cover.jpg" />
    </section>
  </body>
</html>`, "utf-8"));
  }

  const navItems = options.outline
    .map((entry) => `<li><a href="page-${String(entry.pageNumber).padStart(4, "0")}.xhtml#p-${entry.pageNumber}-${entry.paragraphNumber}">${escapeXml(entry.title)}</a></li>`)
    .join("");

  archive.addFile("OEBPS/nav.xhtml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${options.book.languageCode}" xml:lang="${options.book.languageCode}">
  <head>
    <title>${indexLabel}</title>
    <meta charset="utf-8" />
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${indexLabel}</h1>
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
    manifestItems.unshift(`<item id="cover-image" href="assets/cover.jpg" media-type="${coverMediaType}" properties="cover-image"/>`);
    manifestItems.unshift(`<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`);
  }

  archive.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(options.book.title.toLowerCase().replace(/[^a-z0-9]+/gu, "-") || "lector-book")}</dc:identifier>
    <dc:title>${escapeXml(options.book.title)}</dc:title>
    ${options.book.authorName ? `<dc:creator>${escapeXml(options.book.authorName)}</dc:creator>` : ""}
    <dc:language>${options.book.languageCode}</dc:language>
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

export async function buildImagePdfExport(options: {
  title: string;
  pages: Array<{ buffer: Buffer | null; pageNumber: number }>;
}): Promise<Buffer> {
  if (options.pages.length === 0 || options.pages.some((page) => !page.buffer?.length)) {
    throw Object.assign(new Error("No se puede generar el PDF: faltan imágenes de las páginas."), { statusCode: 409 });
  }

  const document = new PDFDocument({ autoFirstPage: false, info: { Title: options.title } });
  const chunks: Buffer[] = [];
  document.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));

  // Keep rendering failures on the same promise as PDF stream failures.
  return new Promise<Buffer>((resolve, reject) => {
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.on("error", reject);

    void (async () => {
      for (const page of options.pages) {
        const { data, info } = await sharp(page.buffer!).rotate().png().toBuffer({ resolveWithObject: true });
        const width = 595.28;
        const height = width * info.height / info.width;
        document.addPage({ margin: 0, size: [width, height] });
        document.image(data, 0, 0, { width, height });
      }
      document.end();
    })().catch((error) => {
      reject(error);
      document.end();
    });
  });
}

export async function buildPdfExport(options: {
  book: ExportBook;
  coverAsset: ExportCoverAsset;
  outline: BookOutlineEntry[];
  pages: ExportPage[];
}): Promise<Buffer> {
  const sheets: string[] = [];
  const prefixPages = Number(Boolean(options.coverAsset)) + Number(options.outline.length > 0);
  if (options.coverAsset) {
    const cover = await sharp(options.coverAsset.buffer).rotate().jpeg({ quality: 92 }).toBuffer();
    sheets.push(`<section class="pdf-sheet"><div class="pdf-content"><img class="pdf-cover" alt="" src="data:image/jpeg;base64,${cover.toString("base64")}"></div></section>`);
  }
  if (options.outline.length > 0) {
    const entries = options.outline.flatMap((entry) => {
      const index = options.pages.findIndex((page) => page.pageNumber === entry.pageNumber);
      return index < 0 ? [] : [`<a href="#page-${entry.pageNumber}" style="padding-left:${Math.max(0, entry.level - 1) * 14}px"><span>${escapeXml(entry.title)}</span><span>${prefixPages + index + 1}</span></a>`];
    }).join("");
    sheets.push(`<section class="pdf-sheet"><div class="pdf-content pdf-toc"><h1>${options.book.languageCode === "it" ? "Indice" : "Índice"}</h1>${entries}</div><div class="pdf-footer">${prefixPages}</div></section>`);
  }
  for (const [index, page] of options.pages.entries()) {
    const html = load(getActivePageHtml(page), null, false);
    html("script, iframe, object, embed, base, link, meta, form").remove();
    html("*").each((_, node) => {
      const element = html(node);
      for (const attribute of Object.keys(element.attr() ?? {})) {
        if (/^on/iu.test(attribute)) element.removeAttr(attribute);
      }
      const targetPage = Number(element.attr("data-book-page"));
      if (element.is("a") && targetPage > 0) element.attr("href", `#page-${targetPage}`);
    });
    sheets.push(`<section class="pdf-sheet reader-layout reader-ocr-layout" id="page-${page.pageNumber}"><div class="pdf-content reader-rich-content">${html.html()}</div><div class="pdf-footer">${prefixPages + index + 1}</div></section>`);
  }
  return renderBookHtmlPdf(options.book.title, options.book.languageCode, sheets);
}
