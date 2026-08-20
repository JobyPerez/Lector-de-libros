import assert from "node:assert/strict";
import test from "node:test";

import AdmZip from "adm-zip";
import { load } from "cheerio";

import { parseEpubBuffer } from "../src/modules/books/epub-import.js";
import { parseUploadedBook } from "../src/modules/books/book-import.js";

function createEpub(chapterMarkup: string, navigationMarkup?: string, language?: string): Buffer {
  const archive = new AdmZip();
  archive.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
    </container>`));
  archive.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Prueba</dc:title>${language ? `<dc:language>${language}</dc:language>` : ""}</metadata>
      <manifest>
        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml" />
        ${navigationMarkup ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />' : ""}
      </manifest>
      <spine><itemref idref="chapter" /></spine>
    </package>`));
  archive.addFile("OEBPS/chapter.xhtml", Buffer.from(`<!doctype html><html><body>${chapterMarkup}</body></html>`));

  if (navigationMarkup) {
    archive.addFile("OEBPS/nav.xhtml", Buffer.from(`<!doctype html><html><body>${navigationMarkup}</body></html>`));
  }

  return archive.toBuffer();
}

function createMultiDocumentEpub(documents: Array<{ id: string; markup: string }>): Buffer {
  const archive = new AdmZip();
  archive.addFile("META-INF/container.xml", Buffer.from(`<?xml version="1.0"?>
    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
      <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" /></rootfiles>
    </container>`));
  archive.addFile("OEBPS/content.opf", Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
    <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Prueba</dc:title></metadata>
      <manifest>${documents.map((document) => `<item id="${document.id}" href="${document.id}.xhtml" media-type="application/xhtml+xml" />`).join("")}</manifest>
      <spine>${documents.map((document) => `<itemref idref="${document.id}" />`).join("")}</spine>
    </package>`));
  for (const document of documents) {
    archive.addFile(`OEBPS/${document.id}.xhtml`, Buffer.from(`<!doctype html><html><body>${document.markup}</body></html>`));
  }
  return archive.toBuffer();
}

test("divide los contenedores estructurales grandes en paginas comodas", async () => {
  const expectedParagraphs = Array.from({ length: 40 }, (_, index) => `Parrafo ${index + 1} ${"contenido ".repeat(44)}`.trim());
  const chapterMarkup = [
    `<div class="chapter-part">${expectedParagraphs.slice(0, 20).map((paragraph) => `<p>${paragraph}</p>`).join("")}</div>`,
    `<div class="chapter-part">${expectedParagraphs.slice(20).map((paragraph, index) => `${index === 5 ? '<section id="target"></section>' : ""}<p>${paragraph}</p>`).join("")}</div>`
  ].join("");
  const epub = createEpub(chapterMarkup, '<nav epub:type="toc"><ol><li><a href="chapter.xhtml#target">Destino</a></li></ol></nav>');

  const imported = await parseEpubBuffer(epub);

  assert.ok(imported.totalPages > 2);
  assert.deepEqual(imported.pages.flatMap((page) => page.paragraphs), expectedParagraphs);
  assert.ok(imported.pages.every((page) => page.rawText.length <= 4200));
  assert.ok(imported.pages.every((page) => page.paragraphs.length <= 14));
  assert.ok((imported.outlineEntries?.[0]?.pageNumber ?? 0) > 1);
});

test("normaliza dc:language y lo conserva como sugerencia de importacion", async () => {
  const italian = await parseUploadedBook("EPUB", createEpub("<p>Testo</p>", undefined, "it-IT"));
  const unsupported = await parseEpubBuffer(createEpub("<p>Text</p>", undefined, "en"));

  assert.equal(italian.metadataLanguageCode, "it");
  assert.equal(unsupported.metadataLanguageCode, undefined);
});

test("normaliza títulos EPUB con el TOC antes de paginar", async () => {
  const epub = createEpub(
    '<h2 id="chapter">1</h2><h2>Revelación de un nuevo camino</h2><h3>Subsección</h3><h5>Detalle visual</h5>',
    '<nav epub:type="toc"><ol><li><a href="chapter.xhtml#chapter">1. Revelación de un nuevo camino</a></li></ol></nav>'
  );

  const imported = await parseEpubBuffer(epub);
  const document = load(imported.pages[0]?.htmlContent ?? "");

  assert.equal(document("h1").first().text(), "1. Revelación de un nuevo camino");
  assert.equal(document("h1").length, 1);
  assert.equal(document("h2").text(), "Subsección");
  assert.equal(document("h4").text(), "Detalle visual");
  assert.deepEqual(imported.pages[0]?.paragraphs, ["1. Revelación de un nuevo camino", "Subsección", "Detalle visual"]);
});

test("convierte enlaces internos EPUB en destinos navegables del lector", async () => {
  const fillerParagraphs = Array.from({ length: 18 }, (_, index) => `<p>${`Contenido ${index + 1} `.repeat(35)}</p>`).join("");
  const imported = await parseEpubBuffer(createEpub(`
    <p><a href="#target"><em>Ir al destino</em></a></p>
    <p><a href="https://example.com">Enlace externo</a></p>
    ${fillerParagraphs}
    <p id="target">Destino interno</p>
  `));
  const sourceDocument = load(imported.pages[0]?.htmlContent ?? "");
  const internalLink = sourceDocument("a").filter((_, node) => sourceDocument(node).text().includes("Ir al destino")).first();
  const externalLink = sourceDocument("a").filter((_, node) => sourceDocument(node).text().includes("Enlace externo")).first();

  assert.ok(Number(internalLink.attr("data-lector-page")) > 1);
  assert.ok(Number(internalLink.attr("data-lector-paragraph")) > 0);
  assert.equal(internalLink.attr("data-lector-epub-href"), "#target");
  assert.equal(internalLink.attr("href"), `?page=${internalLink.attr("data-lector-page")}&paragraph=${internalLink.attr("data-lector-paragraph")}`);
  assert.equal(externalLink.attr("href"), "https://example.com");
  assert.equal(externalLink.attr("data-lector-page"), undefined);
});

test("remapea enlaces internos después de descartar páginas vacías", async () => {
  const epub = createMultiDocumentEpub([
    { id: "empty", markup: "" },
    { id: "index", markup: '<p><a href="target.xhtml#destination">Abrir destino</a></p>' },
    { id: "target", markup: '<p id="destination">Destino</p>' }
  ]);

  const imported = await parseUploadedBook("EPUB", epub);
  const document = load(imported.pages[0]?.htmlContent ?? "");
  const link = document("a").first();

  assert.equal(imported.totalPages, 2);
  assert.equal(link.attr("data-lector-page"), "2");
  assert.equal(link.attr("href"), "?page=2&paragraph=1");
});

test("mantiene sincronizados el HTML y los parrafos al dividir un parrafo largo", async () => {
  const longParagraph = Array.from({ length: 150 }, (_, index) => `Esta es la frase numero ${index + 1}.`).join(" ");
  const imported = await parseEpubBuffer(createEpub(`<div><p id="long">${longParagraph}</p></div>`));
  const importedParagraphs = imported.pages.flatMap((page) => page.paragraphs);
  const annotatedNodes = imported.pages.reduce((count, page) => {
    const document = load(page.htmlContent ?? "");
    return count + document("[data-paragraph-number]").length;
  }, 0);

  assert.ok(importedParagraphs.length > 1);
  assert.ok(importedParagraphs.every((paragraph) => paragraph.length <= 900));
  assert.equal(importedParagraphs.join(" "), longParagraph);
  assert.equal(annotatedNodes, importedParagraphs.length);
  assert.ok(imported.pages.every((page) => page.rawText.length <= 4200));
});

test("conserva el espaciado y el formato inline", async () => {
  const inlineMarkup = '<div>Hola <span>mundo</span>. <code>foo</code>()</div>';
  const imported = await parseEpubBuffer(createEpub(inlineMarkup));

  assert.equal(imported.pages[0]?.rawText, "Hola mundo. foo()");
  assert.match(imported.pages[0]?.htmlContent ?? "", /Hola <span>mundo<\/span>\. <code>foo<\/code>\(\)/u);
  assert.equal(load(imported.pages[0]?.htmlContent ?? "")("[data-paragraph-number]").length, 1);
});

test("incluye texto suelto junto a parrafos en la persistencia", async () => {
  const imported = await parseEpubBuffer(createEpub("<div>Inicio.<p>Centro.</p>Final.</div>"));

  assert.deepEqual(imported.pages[0]?.paragraphs, ["Inicio.", "Centro.", "Final."]);
  assert.equal(load(imported.pages[0]?.htmlContent ?? "")("[data-paragraph-number]").length, 3);
});

test("cuenta el texto suelto al aplicar el limite de parrafos", async () => {
  const spans = Array.from({ length: 40 }, (_, index) => `<span>Fragmento ${index + 1}.</span>`).join(" ");
  const imported = await parseEpubBuffer(createEpub(`<div><p>Introduccion.</p>${spans}</div>`));

  assert.ok(imported.totalPages > 1);
  assert.ok(imported.pages.every((page) => page.paragraphs.length <= 14));
});

test("no elimina enlaces ni enfasis de un parrafo largo con formato", async () => {
  const longText = "texto con formato ".repeat(300).trim();
  const imported = await parseEpubBuffer(createEpub(`<p id="formatted"><em>${longText}</em> <a href="#note">nota</a></p>`));
  const importedParagraphs = imported.pages.flatMap((page) => page.paragraphs);
  const combinedHtml = imported.pages.map((page) => page.htmlContent ?? "").join("");

  assert.ok(imported.totalParagraphs > 1);
  assert.ok(importedParagraphs.every((paragraph) => paragraph.length <= 900));
  assert.equal(importedParagraphs.join(" "), `${longText} nota`);
  assert.match(combinedHtml, /<p[^>]*id="formatted"/u);
  assert.match(combinedHtml, /<em>texto con formato/u);
  assert.match(combinedHtml, /<a href="#note">nota<\/a>/u);
  assert.equal(imported.pages.reduce((count, page) => count + load(page.htmlContent ?? "")("[data-paragraph-number]").length, 0), imported.totalParagraphs);
});

test("divide blockquotes con muchos parrafos sin aplanar su estructura", async () => {
  const paragraphs = Array.from({ length: 20 }, (_, index) => `Cita ${index + 1} ${"contenido ".repeat(40)}`.trim());
  const imported = await parseEpubBuffer(createEpub(`<blockquote id="quote">${paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join("")}</blockquote>`));

  assert.ok(imported.totalPages > 1);
  assert.deepEqual(imported.pages.flatMap((page) => page.paragraphs), paragraphs);
  assert.ok(imported.pages.every((page) => page.rawText.length <= 4200));
  assert.ok(imported.pages.every((page) => page.paragraphs.length <= 14));
  assert.ok(imported.pages.every((page) => load(page.htmlContent ?? "")("blockquote#quote").length === 1));
});

test("conserva la numeracion de listas ordenadas entre paginas", async () => {
  const items = Array.from({ length: 20 }, (_, index) => `<li>Paso ${index + 1}</li>`).join("");
  const imported = await parseEpubBuffer(createEpub(`<ol>${items}</ol>`));
  const secondPage = load(imported.pages[1]?.htmlContent ?? "");

  assert.equal(imported.totalPages, 2);
  assert.equal(secondPage("ol > li").first().attr("value"), "15");
});

test("respeta start, value y reversed en listas ordenadas", async () => {
  const imported = await parseEpubBuffer(createEpub(`
    <ol start="5"><li>Uno</li><li value="10">Dos</li><li>Tres</li></ol>
    <ol reversed><li>A</li><li>B</li><li>C</li></ol>
  `));
  const document = load(imported.pages[0]?.htmlContent ?? "");
  const lists = document("ol");

  assert.deepEqual(lists.eq(0).children("li").map((_, node) => document(node).attr("value")).get(), ["5", "10", "11"]);
  assert.deepEqual(lists.eq(1).children("li").map((_, node) => document(node).attr("value")).get(), ["3", "2", "1"]);
});

test("divide contenido preformateado largo sin perder texto", async () => {
  const longText = Array.from({ length: 700 }, (_, index) => `linea-${index + 1}`).join("\n");
  const imported = await parseEpubBuffer(createEpub(`<pre>${longText}</pre>`));

  assert.ok(imported.totalPages > 1);
  assert.equal(imported.pages.map((page) => page.rawText).join(" "), longText.replace(/\s+/gu, " "));
  assert.ok(imported.pages.every((page) => page.rawText.length <= 4200));
  assert.ok(imported.pages.every((page) => load(page.htmlContent ?? "")("[data-paragraph-number]").length === page.paragraphs.length));
});
