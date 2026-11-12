import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/shelf/BookInfoMetadata.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("BookInfoMetadata.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const code = ts.transpileModule(ast.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(ast)).join("\n").replaceAll("export function", "function"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
}).outputText;
const { BookInfoMetadata, formatBookReadingTime } = new Function("React", "Link", "getBookLanguageLabel", `${code}; return { BookInfoMetadata, formatBookReadingTime };`)(
  React, ({ to, children }: { to: string; children: React.ReactNode }) => React.createElement("a", { href: to }, children), () => "Español"
);

test("book metadata follows the requested order, highlights title/author and links directly to index and notes", () => {
  const book = {
    bookId: "sample", title: "El cielo de los leones", authorName: "Ángeles", sourceType: "EPUB", languageCode: "es",
    publicationYear: 1999, rating: 4, totalPages: 212, totalWords: 143158,
    lastOpenedAt: "2026-11-10T12:00:00Z", readingDate: "2026-11-09", userComments: "Comentario\nSegunda línea"
  };
  const dom = new JSDOM(renderToStaticMarkup(React.createElement(BookInfoMetadata, { book, ratingLabel: "4 - Me gustó", shelfReturnTo: "/", onOpenNavigation() {} })));
  try {
    const document = dom.window.document;
    assert.deepEqual([...document.querySelectorAll("dt")].map((node) => node.textContent), [
      "Formato:", "Título:", "Autor:", "Idioma:", "Año de publicación:", "Calificación:", "Páginas:", "Palabras:",
      "Tiempo estimado de lectura:", "Última lectura:", "Fecha de lectura:", "Comentarios:"
    ]);
    const values = [...document.querySelectorAll("dd")].map((node) => node.textContent);
    assert.equal(values[0], "EPUB");
    assert.equal(values[3], "Español");
    assert.equal(values[4], "1999");
    assert.equal(values[6], "212");
    assert.equal(values[7], "143.158");
    assert.equal(values[8], "15 h 24 min");
    assert.equal(values[11], "Comentario\nSegunda línea");
    assert.equal(document.querySelector("h3")?.textContent, book.title);
    assert.equal(document.querySelector(".shelf-book-info-author")?.textContent, book.authorName);
    assert.equal(document.querySelector("a")?.getAttribute("href"), "/books/sample?panel=index-notes");
  } finally { dom.window.close(); }
});

test("empty metadata remains visible with explicit placeholders and invalid estimates are not displayed", () => {
  const html = renderToStaticMarkup(React.createElement(BookInfoMetadata, {
    book: { bookId: "empty", title: "Libro", sourceType: "IMAGES", totalPages: 0, totalWords: 0 },
    shelfReturnTo: "/", onOpenNavigation() {}
  }));
  for (const label of ["Imágenes (OCR)", "Autor pendiente", "Sin especificar", "Sin calificar", "Sin registrar", "Sin comentarios", "No disponible"]) {
    assert.ok(html.includes(label), label);
  }
  assert.equal(formatBookReadingTime(Number.NaN), "No disponible");
  assert.equal(formatBookReadingTime(-1), "No disponible");
  assert.equal(formatBookReadingTime(155), "1 min");
  assert.equal(formatBookReadingTime(9300), "1 h");
});
