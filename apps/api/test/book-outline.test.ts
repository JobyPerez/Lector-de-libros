import assert from "node:assert/strict";
import test from "node:test";

import { buildOutlineFromTitles } from "../src/modules/books/book-outline.js";

test("el índice contiene exclusivamente títulos T1, T2 y T3", () => {
  const outline = buildOutlineFromTitles([
    {
      htmlContent: `
        <h1 data-paragraph-number="1">Principal</h1>
        <h2 data-paragraph-number="2">Sección</h2>
        <h3 data-paragraph-number="3">Apartado</h3>
        <h4 data-paragraph-number="4">Título visual T4</h4>
        <h5 data-paragraph-number="5">Título visual T5</h5>
        <h6 data-paragraph-number="6">Título visual T6</h6>
      `,
      pageNumber: 1
    }
  ], Array.from({ length: 6 }, (_, index) => ({
    pageNumber: 1,
    paragraphId: `paragraph-${index + 1}`,
    paragraphNumber: index + 1,
    sequenceNumber: index + 1
  })));

  assert.deepEqual(outline.map((entry) => ({ id: entry.chapterId, level: entry.level, title: entry.title })), [
    { id: "paragraph-1", level: 1, title: "Principal" },
    { id: "paragraph-2", level: 2, title: "Sección" },
    { id: "paragraph-3", level: 3, title: "Apartado" }
  ]);
});

test("el ID de sección es el ID estable del párrafo del título", () => {
  const pages = [{ htmlContent: '<h2 data-paragraph-number="1">Título estable</h2>', pageNumber: 4 }];
  const paragraphs = [{ paragraphId: "stable-paragraph-id", pageNumber: 4, paragraphNumber: 1, sequenceNumber: 20 }];

  const outline = buildOutlineFromTitles(pages, paragraphs);

  assert.equal(outline[0]?.chapterId, "stable-paragraph-id");
  assert.equal(outline[0]?.sequenceNumber, 20);
});
