import assert from "node:assert/strict";
import test from "node:test";

import AdmZip from "adm-zip";

import { buildEpubExport } from "../src/modules/books/book-export.js";

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
