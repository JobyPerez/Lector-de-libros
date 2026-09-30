import assert from "node:assert/strict";
import test from "node:test";

import AdmZip from "adm-zip";
import sharp from "sharp";

import { buildEpubExport, buildImagePdfExport, buildPdfExport } from "../src/modules/books/book-export.js";

test("exporta EPUB italiano con metadatos y atributos de idioma", async () => {
  const buffer = await buildEpubExport({
    book: {
      authorName: "Autore",
      languageCode: "it",
      synopsis: null,
      title: "Libro"
    },
    coverAsset: null,
    outline: [],
    pages: [{
      htmlContent: null,
      pageLabel: null,
      pageNumber: 1,
      paragraphs: [{ paragraphText: "Testo" }]
    }]
  });
  const archive = new AdmZip(buffer);
  const opf = archive.readAsText("OEBPS/content.opf");
  const page = archive.readAsText("OEBPS/page-0001.xhtml");
  const navigation = archive.readAsText("OEBPS/nav.xhtml");

  assert.match(opf, /<dc:language>it<\/dc:language>/u);
  assert.match(page, /lang="it" xml:lang="it"/u);
  assert.match(navigation, /lang="it" xml:lang="it"/u);
  assert.match(navigation, /<h1>Indice<\/h1>/u);
});

test("exporta las imagenes guardadas en orden, sin texto ni paginas extra", async () => {
  const firstImage = await sharp({ create: { width: 120, height: 240, channels: 3, background: "red" } }).png().toBuffer();
  const secondImage = await sharp({ create: { width: 240, height: 120, channels: 3, background: "blue" } }).webp().toBuffer();
  const buffer = await buildImagePdfExport({
    title: "Imagenes recortadas",
    pages: [{ buffer: firstImage, pageNumber: 1 }, { buffer: secondImage, pageNumber: 2 }]
  });
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 2);
    for (const [index, ratio] of [2, 0.5].entries()) {
      const page = await pdf.getPage(index + 1);
      const viewport = page.getViewport({ scale: 1 });
      assert.ok(Math.abs(viewport.height / viewport.width - ratio) < 0.001);
      assert.equal((await page.getTextContent()).items.length, 0);
      const operators = await page.getOperatorList();
      assert.equal(operators.fnArray.filter((operator) => operator === OPS.paintImageXObject).length, 1);
    }
  } finally {
    await pdf.destroy();
  }
});

test("rechaza PDF de imagenes vacio, incompleto o con imagen corrupta", async () => {
  await assert.rejects(buildImagePdfExport({ title: "Vacio", pages: [] }), { statusCode: 409 });
  await assert.rejects(buildImagePdfExport({ title: "Incompleto", pages: [{ buffer: null, pageNumber: 1 }] }), { statusCode: 409 });
  await assert.rejects(buildImagePdfExport({ title: "Corrupto", pages: [{ buffer: Buffer.from("invalid"), pageNumber: 1 }] }));
});

test("la exportacion PDF de texto sigue incluyendo el contenido OCR", async () => {
  const buffer = await buildPdfExport({
    book: { authorName: null, languageCode: "es", synopsis: null, title: "OCR" },
    coverAsset: null,
    outline: [],
    pages: [{ htmlContent: null, pageLabel: null, pageNumber: 1, paragraphs: [{ paragraphText: "Texto OCR corregido" }] }]
  });
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    const page = await pdf.getPage(1);
    const text = await page.getTextContent();
    assert.ok(text.items.some((item) => "str" in item && item.str.includes("Texto OCR corregido")));
  } finally {
    await pdf.destroy();
  }
});
