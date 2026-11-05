import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

test("reader enables the same Original/Adaptable view for native PDFs and OCR, but not EPUB", () => {
  const source = readFileSync(new URL("../src/features/reader/ReaderPage.tsx", import.meta.url), "utf8");
  const declarations = ["isOcrBook", "supportsOriginalView", "isOriginalView"].map((name) => {
    const expression = source.match(new RegExp(`  const ${name} = ([^;]+);`));
    assert.ok(expression); return `const ${name} = ${expression[1]};`;
  }).join("\n");
  const state = new Function("pageQuery", "readingView", `${declarations}; return {supportsOriginalView, isOriginalView};`);
  for (const sourceType of ["PDF", "IMAGES", "EPUB"]) for (const hasSourceImage of [true, false]) {
    const pageQuery = { data: { book: { sourceType }, page: { hasSourceImage } } };
    const result = state(pageQuery, "original");
    assert.equal(result.supportsOriginalView, sourceType !== "EPUB");
    assert.equal(result.isOriginalView, sourceType !== "EPUB" && hasSourceImage);
    assert.equal(state(pageQuery, "adaptable").isOriginalView, false);
  }
  assert.match(source, /supportsOriginalView \? <div className="reader-view-selector"/);
});

test("PDF preparation sends stable page identity and exact revision; physical sheet stays optional", async () => {
  const text = readFileSync(new URL("../src/app/api.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("api.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "preparePdfPage");
  assert.ok(declaration);
  const calls: { url: string; options: any }[] = [];
  const request = async (url: string, options: unknown) => { calls.push({ url, options }); return {}; };
  const method = new Function("request", ts.transpile(`${declaration.getText(source).replace(/^export /u, "")}; return preparePdfPage;`, { target: ts.ScriptTarget.ES2022 }))(request);
  await method("token", "book", 6, "stable-page", "2026-11-05T12:00:00.123456");
  assert.equal(calls[0]!.url, "/books/book/pages/6/prepare-pdf?pageId=stable-page");
  assert.equal(calls[0]!.options.method, "POST");
  assert.deepEqual(calls[0]!.options.body, { expectedUpdatedAt: "2026-11-05T12:00:00.123456" });
  await method("token", "book", 6, "stable-page", "revision", 21);
  assert.equal(calls[1]!.options.body.sourcePdfPageNumber, 21);
});

test("PDF editor reuses original-image zones and blocks preparation while a draft is dirty", () => {
  const gallery = readFileSync(new URL("../src/features/book-pages/GalleryPageEditor.tsx", import.meta.url), "utf8");
  const builder = readFileSync(new URL("../src/features/book-builder/BookBuilderPage.tsx", import.meta.url), "utf8");
  const control = readFileSync(new URL("../src/components/PdfPreparationControl.tsx", import.meta.url), "utf8");
  assert.match(gallery, /sourceImage=\{sourceImage\} source=\{\(overlay\) => overlay\}/);
  assert.match(gallery, /disabled=\{dirty \|\| saving \|\| loading/);
  assert.match(builder, /disabled=\{visualDocumentDirty \|\| isSavingReview/);
  assert.match(control, /if \(disabled \|\| running\.current\) return/);
  assert.match(control, /expectedUpdatedAt|page\.updatedAt/);
  assert.match(builder, /OCR opcional para páginas escaneadas o difíciles/);
  assert.match(builder, /hasReviewImage && selectedReviewBook\?\.sourceType === "IMAGES"/);
});
