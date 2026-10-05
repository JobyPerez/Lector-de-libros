import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

import AdmZip from "adm-zip";
import sharp from "sharp";

import { buildEpubExport, buildImagePdfExport, buildPdfExport } from "../src/modules/books/book-export.js";
import { renderVisualDocument } from "../src/modules/books/visual-document.js";

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

test("PDF OCR preserves columns, relative font sizes, line breaks and captions, fitting long pages into one A4 sheet", async () => {
  const image = await sharp({ create: { width: 100, height: 50, channels: 3, background: "red" } }).png().toBuffer();
  const leftId = randomUUID(), rightId = randomUUID(), imageId = randomUUID();
  const visual = renderVisualDocument({
    version: 1,
    blocks: [
      { id: leftId, kind: "text", text: "Left column\nSecond line", role: "body", active: true, readAloud: true, includeInToc: false, fontScale: 2 },
      { id: rightId, kind: "text", text: "Right column", role: "body", active: true, readAloud: true, includeInToc: false },
      { id: imageId, kind: "image", text: "Visible caption", role: "image", active: true, readAloud: false, includeInToc: false, imageWidth: 50,
        source: `data:image/png;base64,${image.toString("base64")}` }
    ],
    layout: { id: randomUUID(), type: "row", weights: [2, 1], gap: 20, children: [
      { id: randomUUID(), type: "column", children: [{ id: randomUUID(), type: "block", blockId: leftId }, { id: randomUUID(), type: "block", blockId: imageId }] },
      { id: randomUUID(), type: "block", blockId: rightId }
    ] }
  }).htmlContent;
  const long = `<div>${Array.from({ length: 100 }, (_, i) => `<p>Long line ${i}</p>`).join("")}<p>Last line retained</p></div>`;
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport({
    book: { authorName: null, languageCode: "es", synopsis: null, title: "Layout regression" },
    coverAsset: null, outline: [],
    pages: [visual, long, "<p>Next page intact</p>"].map((htmlContent, i) => ({ htmlContent, pageNumber: i + 1, pageLabel: null, paragraphs: [] }))
  })), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 3);
    const first = await pdf.getPage(1);
    const items = (await first.getTextContent()).items.filter((item) => "str" in item);
    const left = items.find((item) => item.str === "Left column")!;
    const right = items.find((item) => item.str === "Right column")!;
    const second = items.find((item) => item.str === "Second line")!;
    assert.ok(left && right && second);
    assert.ok(right.transform[4] > left.transform[4] + 200, "columns must remain side by side");
    assert.ok(Math.abs(left.height / right.height - 2) < .05, "font scales must be preserved");
    assert.ok(second.transform[5] < left.transform[5], "explicit line breaks must be preserved");
    assert.ok(items.some((item) => item.str.includes("Visible caption")));
    for (let number = 1; number <= 3; number += 1) {
      const page = await pdf.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      assert.ok(Math.abs(viewport.width - 595.28) < 1);
      assert.ok(Math.abs(viewport.height - 841.89) < 1);
    }
    const longItems = (await (await pdf.getPage(2)).getTextContent()).items.filter((item) => "str" in item);
    assert.ok(longItems.some((item) => item.str.includes("Last line retained")));
    assert.ok(longItems.find((item) => item.str.includes("Long line 0"))!.height < right.height);
    assert.ok(longItems.every((item) => item.transform[5] > 30), "no text should be clipped below the sheet");
    const lastItems = (await (await pdf.getPage(3)).getTextContent()).items;
    assert.ok(lastItems.some((item) => "str" in item && item.str === "Next page intact"));
  } finally {
    await pdf.destroy();
  }
});

test("PDF cover and a long index do not split book pages and index links point to physical sheets", async () => {
  const cover = await sharp({ create: { width: 80, height: 120, channels: 3, background: "blue" } }).png().toBuffer();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport({
    book: { authorName: null, languageCode: "es", synopsis: null, title: "Index regression" },
    coverAsset: { buffer: cover, fileName: "cover.png", mimeType: "image/png" },
    outline: Array.from({ length: 80 }, (_, i) => ({ title: `Entry ${i}`, level: 1, pageNumber: i < 40 ? 5 : 9, paragraphNumber: 1 })),
    pages: [5, 9].map((pageNumber) => ({ pageNumber, pageLabel: null, htmlContent: `<p>Book page ${pageNumber}</p>`, paragraphs: [] }))
  })), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 4);
    const toc = await pdf.getPage(2);
    const text = (await toc.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.match(text, /Entry 79/);
    const links = (await toc.getAnnotations()).filter((annotation) => annotation.dest);
    assert.equal(links.length, 80);
    for (const [annotation, index] of [[links[0]!, 2], [links[79]!, 3]] as const) {
      const destination = typeof annotation.dest === "string" ? await pdf.getDestination(annotation.dest) : annotation.dest;
      assert.equal(await pdf.getPageIndex(destination[0]), index);
    }
  } finally {
    await pdf.destroy();
  }
});
