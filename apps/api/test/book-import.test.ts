import assert from "node:assert/strict";
import test from "node:test";

import { inferSourceType, suggestImportedDocumentLanguage, type ImportedDocument } from "../src/modules/books/book-import.js";

function documentWithText(text: string, metadataLanguageCode?: "es" | "it"): ImportedDocument {
  return {
    ...(metadataLanguageCode ? { metadataLanguageCode } : {}),
    pages: [{ pageNumber: 1, paragraphs: [text], rawText: text }],
    totalPages: 1,
    totalParagraphs: 1
  };
}

test("detecta PDF y EPUB por el tipo MIME", () => {
  assert.equal(inferSourceType("libro", "application/pdf"), "PDF");
  assert.equal(inferSourceType("libro", "application/epub+zip"), "EPUB");
});

test("detecta PDF y EPUB por la extension cuando el MIME es generico", () => {
  assert.equal(inferSourceType("libro.PDF", "application/octet-stream"), "PDF");
  assert.equal(inferSourceType("libro.EPUB", "application/octet-stream"), "EPUB");
});

test("rechaza formatos no admitidos", () => {
  assert.equal(inferSourceType("libro.txt", "text/plain"), null);
});

test("sugiere italiano a partir de los metadatos EPUB", () => {
  assert.deepEqual(suggestImportedDocumentLanguage(documentWithText("Texto ambiguo", "it")), {
    languageCode: "it",
    source: "metadata"
  });
});

test("detecta italiano y español a partir de una muestra suficiente", () => {
  assert.deepEqual(suggestImportedDocumentLanguage(documentWithText("Questo libro racconta della città e delle persone che sono nella storia, anche quando cambia tutto.")), {
    languageCode: "it",
    source: "detected"
  });
  assert.deepEqual(suggestImportedDocumentLanguage(documentWithText("Este libro también cuenta por qué las personas viajaron desde la ciudad hasta el campo, aunque había problemas.")), {
    languageCode: "es",
    source: "detected"
  });
});

test("no fuerza una sugerencia para texto ambiguo", () => {
  assert.equal(suggestImportedDocumentLanguage(documentWithText("Roma, 1984.")), null);
});
