import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { buildOutlineFromTitles } from "../src/modules/books/book-outline.js";
import { orderedVisualBlocks, renderVisualDocument, type VisualBlock, type VisualPageDocument } from "../src/modules/books/visual-document.js";

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
  assert.equal(outline[0]?.beginsPageContent, true);
});

test("page 8 starts with T2 after peripheral blocks, but its following T3 does not", () => {
  const outline = buildOutlineFromTitles([{ pageNumber: 8, htmlContent: `
    <h2 data-paragraph-number="1">Cabecera</h2>
    <p data-paragraph-number="2">8</p>
    <p data-paragraph-number="5">Pie</p>
    <h2 data-paragraph-number="3">T2</h2>
    <h3 data-paragraph-number="4">T3</h3>
  ` }], ["header", "pageNumber", "heading", "heading", "footer"].map((elementRole, index) => ({
    paragraphId: `p8-${index + 1}`, pageNumber: 8, paragraphNumber: index + 1,
    sequenceNumber: 80 + index, elementRole, active: true
  })));
  assert.deepEqual(outline.map((entry) => [entry.title, entry.paragraphNumber, entry.beginsPageContent]), [
    ["T2", 3, true], ["T3", 4, false]
  ]);
});

test("real HTML order, not paragraph or sequence numbers, determines preceding content", () => {
  for (const content of [
    '<p data-paragraph-number="9" data-read-aloud="false">Continuacion real</p>',
    '<figure data-paragraph-number="9"><img src="https://example.com/image.png" alt=""></figure>',
    '<div>Texto sin numero de parrafo</div>',
    '<h4 data-paragraph-number="9">Titulo fuera del indice</h4>'
  ]) {
    const outline = buildOutlineFromTitles([{ pageNumber: 2,
      htmlContent: `${content}<h2 data-paragraph-number="1">Titulo</h2>` }], [
      { paragraphId: "title", pageNumber: 2, paragraphNumber: 1, sequenceNumber: 1 },
      { paragraphId: "body", pageNumber: 2, paragraphNumber: 9, sequenceNumber: 9 }
    ]);
    assert.equal(outline[0]?.beginsPageContent, false, content);
  }
});

test("inactive, blank and peripheral subtrees do not precede narrative content", () => {
  const outline = buildOutlineFromTitles([{ pageNumber: 3, htmlContent: `
    <p data-paragraph-number="1">Inactivo en base de datos</p>
    <div data-active="false"><p>Inactivo HTML</p><img src="https://example.com/hidden.png"></div>
    <p data-is-active="0">Inactivo legado</p>
    <p data-paragraph-number="2">&nbsp; <br> <span> </span></p>
    <div data-element-role="header"><p>Cabecera HTML</p></div>
    <div data-element-role="footer"><img src="https://example.com/footer.png"></div>
    <p data-element-role="pageNumber">3</p>
    <img src="">
    <h2 data-paragraph-number="3">Primero</h2>
  ` }], [
    { paragraphId: "inactive", pageNumber: 3, paragraphNumber: 1, sequenceNumber: 1, active: 0 },
    { paragraphId: "blank", pageNumber: 3, paragraphNumber: 2, sequenceNumber: 2, active: true },
    { paragraphId: "title", pageNumber: 3, paragraphNumber: 3, sequenceNumber: 3, active: true }
  ]);
  assert.equal(outline[0]?.beginsPageContent, true);
});

test("rendered visual IDs take precedence over stale paragraph numbers", () => {
  const outline = buildOutlineFromTitles([{ pageNumber: 1, htmlContent: `
    <p data-visual-block-id="header" data-paragraph-number="1">Cabecera</p>
    <h2 data-visual-block-id="title" data-paragraph-number="2">Titulo</h2>
  ` }], [
    { paragraphId: "title", pageNumber: 1, paragraphNumber: 1, sequenceNumber: 1, elementRole: "heading" },
    { paragraphId: "header", pageNumber: 1, paragraphNumber: 2, sequenceNumber: 2, elementRole: "header" }
  ]);
  assert.deepEqual(outline.map((entry) => [entry.chapterId, entry.paragraphNumber, entry.beginsPageContent]), [["title", 1, true]]);
});

test("compound headings remain whole and evaluate preceding content before their own atoms", () => {
  const makeBlock = (text: string, overrides: Partial<VisualBlock> = {}): VisualBlock => ({
    id: randomUUID(), kind: "text", text, role: "body", active: true, readAloud: false, includeInToc: false, ...overrides
  });
  for (const precedingContent of [false, true]) {
    const header = makeBlock("Cabecera", { role: "header" });
    const hidden = makeBlock("", { active: false });
    const first = makeBlock("CAPITULO", { kind: "heading", role: "heading", headingLevel: 3 });
    const second = makeBlock("**Completo**", { kind: "heading", role: "heading", headingLevel: 3 });
    const next = makeBlock("Siguiente", { kind: "heading", role: "heading", headingLevel: 3, includeInToc: true });
    const body = makeBlock("Continuacion real");
    const leaf = (block: VisualBlock) => ({ id: randomUUID(), type: "block" as const, blockId: block.id });
    const value: VisualPageDocument = {
      version: 1,
      // Storage order intentionally differs from layout order.
      blocks: [next, second, first, hidden, header, ...(precedingContent ? [body] : [])],
      layout: { id: randomUUID(), type: "column", children: [leaf(header), ...(precedingContent ? [leaf(body)] : []),
        { id: randomUUID(), type: "column", content: { kind: "heading", separator: "line", headingLevel: 2, includeInToc: true },
          children: [leaf(hidden), leaf(first), leaf(second)] }, leaf(next)] }
    };
    const paragraphs = orderedVisualBlocks(value).map((block, index) => ({
      paragraphId: block.id, paragraphNumber: index + 1, pageNumber: 8, sequenceNumber: index + 1,
      active: block.active, elementRole: block.role, includeInToc: block.includeInToc
    }));
    const original = structuredClone(value);
    const rendered = renderVisualDocument(value).htmlContent;
    for (const page of [
      { pageNumber: 8, htmlContent: rendered },
      { pageNumber: 8, htmlContent: '<p>Obsoleto</p>', visualDocumentJson: JSON.stringify(value) }
    ]) {
      const outline = buildOutlineFromTitles([page], paragraphs);
      assert.deepEqual(outline.map((entry) => [entry.chapterId, entry.title, entry.level, entry.beginsPageContent]), [
        [first.id, "CAPITULO Completo", 2, !precedingContent], [next.id, "Siguiente", 3, false]
      ]);
    }
    assert.deepEqual(value, original);
  }
});
