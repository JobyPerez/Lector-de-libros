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

test("PDF paginates long indices at a readable size and updates physical page numbers and links", async () => {
  const cover = await sharp({ create: { width: 80, height: 120, channels: 3, background: "blue" } }).png().toBuffer();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport({
    book: { authorName: null, languageCode: "es", synopsis: null, title: "Index regression" },
    coverAsset: { buffer: cover, fileName: "cover.png", mimeType: "image/png" },
    outline: Array.from({ length: 80 }, (_, i) => ({
      title: `Entry ${i}${i % 7 === 0 ? " with a long chapter title that wraps across several lines while retaining the entire heading and its page reference" : ""}`,
      level: i % 4 + 1, pageNumber: i < 40 ? 5 : 9, paragraphNumber: 1
    })),
    pages: [5, 9].map((pageNumber) => ({ pageNumber, pageLabel: null, htmlContent: `<p>Book page ${pageNumber}</p>`, paragraphs: [] }))
  })), useSystemFonts: true }).promise;
  try {
    assert.ok(pdf.numPages > 4, "the index must occupy multiple A4 pages");
    const firstBookPage = pdf.numPages - 1;
    const links: any[] = [];
    const visiblePageNumbers: string[] = [];
    let indexText = "";
    for (let number = 2; number < firstBookPage; number += 1) {
      const toc = await pdf.getPage(number);
      const items = (await toc.getTextContent()).items.filter((item) => "str" in item);
      const text = items.map((item) => item.str).join(" ");
      assert.match(text, /Índice/);
      if (number > 2) assert.match(text, /continuación/);
      indexText += ` ${text}`;
      for (const item of items.filter((item) => item.str.trim() && item.transform[5] > 50)) {
        assert.ok(item.height >= 11.9, "index text must retain its 12pt size");
        assert.ok(item.transform[5] >= 50, "index entries must stay above the bottom margin");
        if (/^\d+$/u.test(item.str)) visiblePageNumbers.push(item.str);
      }
      assert.ok(items.some((item) => item.str === String(number) && item.transform[5] < 50), "footer must match the physical page");
      const annotations = (await toc.getAnnotations()).filter((annotation) => annotation.dest);
      for (const annotation of annotations) assert.ok(annotation.rect[1] >= 49, "index links must not overflow the page");
      links.push(...annotations);
    }
    for (let i = 0; i < 80; i += 1) assert.match(indexText, new RegExp(`Entry ${i}(?!\\d)`));
    assert.equal(links.length, 80);
    assert.deepEqual(visiblePageNumbers, Array.from({ length: 80 }, (_, i) => String(firstBookPage + Number(i >= 40))));
    for (const [i, annotation] of links.entries()) {
      const destination = typeof annotation.dest === "string" ? await pdf.getDestination(annotation.dest) : annotation.dest;
      assert.equal(await pdf.getPageIndex(destination[0]), firstBookPage - 1 + Number(i >= 40));
    }
    for (const [index, bookPage] of [5, 9].entries()) {
      const text = (await (await pdf.getPage(firstBookPage + index)).getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
      assert.match(text, new RegExp(`Book page ${bookPage}`));
    }
  } finally {
    await pdf.destroy();
  }
});

test("a short Italian PDF index stays on one page without a cover and keeps correct references", async () => {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(await buildPdfExport({
    book: { authorName: null, languageCode: "it", synopsis: null, title: "Libro" },
    coverAsset: null,
    outline: [{ title: "Primo capitolo", level: 1, pageNumber: 7, paragraphNumber: 1 }],
    pages: [{ pageNumber: 7, pageLabel: null, htmlContent: "<p>Contenuto</p>", paragraphs: [] }]
  })), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 2);
    const toc = await pdf.getPage(1);
    const text = (await toc.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.match(text, /Indice/);
    assert.match(text, /Primo capitolo/);
    assert.match(text, /\b2\b/u);
    const [link] = (await toc.getAnnotations()).filter((annotation) => annotation.dest);
    const destination = typeof link!.dest === "string" ? await pdf.getDestination(link!.dest) : link!.dest;
    assert.equal(await pdf.getPageIndex(destination[0]), 1);
  } finally {
    await pdf.destroy();
  }
});
