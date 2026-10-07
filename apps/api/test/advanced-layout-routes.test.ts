import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { load } from "cheerio";
import { externalizeContentImages } from "../src/modules/books/content-images.js";
import { calculateParagraphReadingMetrics } from "../src/services/paragraph-metrics.js";
import { normalizeParagraphMetadata } from "../src/modules/books/page-elements.js";
import { matchParagraphsWithExplicitIds } from "../src/modules/books/paragraph-ids.js";
import { normalizeWhitespace } from "../src/modules/books/rich-content.js";
import { parsePageStyle } from "../src/modules/books/page-style.js";
import { buildVisualDocumentFromPage, renderVisualDocument, visualSourceHtml, visualPageDocumentSchema, type VisualPageDocument } from "../src/modules/books/visual-document.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === name));
  assert.ok(node, name);
  return node.getText(source).replace(/^export /u, "");
}
function functions(names: string[], dependencies: Record<string, unknown>) {
  return new Function(...Object.keys(dependencies), ts.transpile(`${names.map(declaration).join("\n")}\nreturn {${names.join(",")}};`,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
function handler(method: string, path: string, dependencies: Record<string, unknown>) {
  const start = routes.indexOf(`  app.${method}("${path}",`);
  const end = routes.indexOf("\n  });", start);
  assert.ok(start >= 0 && end >= 0);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  return new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
const schemas = functions(["booleanFormFieldSchema", "ocrPromptOverrideSchema", "customOcrModelSchema", "imageBookFieldsSchema", "importImagesFieldsSchema", "rerunOcrPageSchema"], {
  z, supportedBookLanguageCodes: ["es", "it"], supportedImageOcrModes: ["AUTO", "VISION", "TEXTRACT"]
});
const imageSource = "data:image/png;base64,aGVsbG8=";
function document(): VisualPageDocument {
  const textId = randomUUID(), imageId = randomUUID();
  return { version: 1, blocks: [
    { id: textId, kind: "text", text: "Stable paragraph identity", role: "body", active: true, readAloud: true, includeInToc: false },
    { id: imageId, kind: "image", text: "Portrait", source: imageSource, role: "image", active: true, readAloud: false, includeInToc: false }
  ], layout: { id: randomUUID(), type: "column", semantic: "figure", style: { padding: 8 }, children: [
    { id: randomUUID(), type: "block", blockId: imageId }, { id: randomUUID(), type: "block", blockId: textId }
  ] } };
}
const common = { randomUUID, visualPageDocumentSchema, renderVisualDocument, externalizeContentImages, normalizeParagraphMetadata,
  calculateParagraphReadingMetrics, buildVisualDocumentFromPage, matchParagraphsWithExplicitIds, normalizeWhitespace };
const matching = functions(["normalizeParagraphForMatch", "computeParagraphSimilarity", "matchReplacementParagraphs"], common);

test("multipart flags default false, accept explicit booleans and reject invalid values; JSON rerun is strictly boolean", () => {
  for (const schema of [schemas.imageBookFieldsSchema, schemas.importImagesFieldsSchema]) {
    assert.equal(schema.parse({ title: "Book" }).advancedLayout, false);
    for (const [input, expected] of [["true", true], ["1", true], [true, true], ["false", false], ["0", false], [false, false]]) {
      assert.equal(schema.parse({ title: "Book", advancedLayout: input }).advancedLayout, expected);
    }
    for (const input of ["invalid", "", 1, null]) assert.equal(schema.safeParse({ title: "Book", advancedLayout: input }).success, false);
  }
  assert.equal(schemas.rerunOcrPageSchema.parse({}).advancedLayout, false);
  assert.equal(schemas.rerunOcrPageSchema.parse({ advancedLayout: true }).advancedLayout, true);
  assert.equal(schemas.rerunOcrPageSchema.safeParse({ advancedLayout: "false" }).success, false);
  assert.match(routes, /advancedLayout: multipartForm.fields.advancedLayout/u);
  assert.match(routes, /undefined, undefined, payload.advancedLayout\)/u);
  assert.match(routes, /payload.advancedLayout\s+\);/u);
});

test("legacy PUT /ocr rejects every persisted visual document, including unstyled tables and nested layouts, before reconstruction", async () => {
  const plain = document();
  plain.blocks = [plain.blocks[0]!];
  plain.layout = { id: randomUUID(), type: "column", children: [{ id: randomUUID(), type: "block", blockId: plain.blocks[0]!.id }] };
  const table = structuredClone(plain);
  table.layout = { id: randomUUID(), type: "column", semantic: "table", children: [
    { id: randomUUID(), type: "row", semantic: "tableRow", children: [
      { id: randomUUID(), type: "column", semantic: "tableCell", children: [plain.layout.children[0]!] }
    ] }
  ] };
  const nested = structuredClone(plain);
  nested.layout = { id: randomUUID(), type: "row", children: [nested.layout] };
  for (const value of [plain, table, nested, document()]) {
    visualPageDocumentSchema.parse(value);
    const calls: string[] = [];
    const run = handler("put", "/:bookId/pages/:pageNumber/ocr", {
      load, parsePageStyle, visualPageDocumentSchema,
      pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }),
      updateOcrPageSchema: z.object({ editedText: z.string(), expectedUpdatedAt: z.string() }),
      getConnection: async () => ({ execute: async (sql: string) => { calls.push(sql); }, close: async () => { calls.push("close"); } }),
      findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es" }),
      findBookPage: async () => ({ pageId: "page", updatedAt: "version", htmlContent: null, visualDocumentJson: JSON.stringify(value) }),
      buildRichPageFromEditableText: () => { throw new Error("must not reconstruct visual pages"); }
    });
    const reply = { statusCode: 200, body: undefined as any, status(code: number) { this.statusCode = code; return this; }, send(body: any) { this.body = body; return this; } };
    await run({ currentUser: { userId: "editor" }, params: { bookId: "book", pageNumber: 1 },
      body: { editedText: "Flattened content", expectedUpdatedAt: "version" } }, reply);
    assert.equal(reply.statusCode, 409);
    assert.match(reply.body.message, /Utiliza el editor visual/u);
    assert.equal(calls.length, 3);
    assert.match(calls[0]!, /FROM books.*FOR UPDATE/u);
    assert.match(calls[1]!, /FROM book_pages.*FOR UPDATE/u);
    assert.equal(calls[2], "close");
  }
});

test("OCR flow defaults false and initial/append persistence uses canonical DFS IDs and one consistent asset externalization", async () => {
  for (const advancedLayout of [false, true]) {
    for (const startingPageNumber of [1, 4]) {
      const value = document();
      const calls: { sql: string; binds: any }[] = [];
      let externalizations = 0;
      let ocrOptions: any;
      const deps = { ...common, runOcrOnImage: async (_b: unknown, _f: unknown, _m: unknown, options: any) => {
        ocrOptions = options;
        return { editedText: `![](${imageSource})`, htmlContent: `<img src="${imageSource}">`, rawText: "Legacy", paragraphs: ["Not canonical"],
          ...(advancedLayout ? { visualDocument: value, paragraphIds: ["ignored-wrong-order"] } : {}) };
      }, isRetryableOcrError: () => false, computeChecksum: () => "checksum",
      externalizeContentImages: (contents: string[]) => { externalizations++; return externalizeContentImages(contents); },
      insertContentImageAssets: async (_c: unknown, _b: unknown, _p: unknown, assets: unknown) => { calls.push({ sql: "assets", binds: assets }); } };
      const { ocrImageFiles, insertProcessedImagePages } = functions(["ocrImageFiles", "insertProcessedImagePages"], deps);
      const args = [[{ buffer: Buffer.from("image"), fieldName: "image", fileName: "page.png", mimeType: "image/png" }], "VISION", "es", "test-model", undefined,
        { secretAccessKey: "must-not-be-persisted" }, "api-secret", undefined, undefined];
      const pages = await ocrImageFiles(...args, ...(advancedLayout ? [true] : []));
      assert.equal(ocrOptions.advancedLayout, advancedLayout);
      assert.equal(pages[0].advancedLayout, advancedLayout);
      const result = await insertProcessedImagePages({ execute: async (sql: string, binds: any) => {
        calls.push({ sql, binds }); return { rows: [] };
      } }, randomUUID(), pages, startingPageNumber, 10);
      assert.equal(externalizations, 1);
      const page = calls.find(({ sql }) => sql.includes("INSERT INTO book_pages"))!.binds;
      const paragraphs = calls.filter(({ sql }) => sql.includes("INSERT INTO book_paragraphs")).map(({ binds }) => binds);
      assert.equal(page.pageNumber, startingPageNumber);
      assert.equal(result.addedParagraphs, advancedLayout ? 2 : 1);
      assert.doesNotMatch(JSON.stringify(calls), /data:image|must-not-be-persisted|api-secret/u);
      const job = JSON.parse(calls.find(({ sql }) => sql.includes("INSERT INTO processing_jobs"))!.binds.payloadJson);
      assert.equal(job.advancedLayout, advancedLayout);
      assert.equal(job.ocrMode, "VISION");
      assert.equal(job.ocrModel, "test-model");
      if (advancedLayout) {
        const saved = visualPageDocumentSchema.parse(JSON.parse(page.visualDocumentJson));
        const rendered = renderVisualDocument(saved, { includeInactive: true });
        assert.deepEqual(paragraphs.map((p) => p.paragraphId), rendered.paragraphIds);
        assert.deepEqual(paragraphs.map((p) => p.paragraphText), rendered.paragraphs);
        assert.deepEqual(paragraphs.map((p) => p.paragraphNumber), [1, 2]);
        assert.equal(paragraphs[0].readAloud, 0);
        const assets = calls.find(({ sql }) => sql === "assets")!.binds;
        assert.equal(assets.length, 1);
        assert.equal(saved.blocks[1]!.source, assets[0].reference);
        assert.match(page.sourceHtmlContent, new RegExp(assets[0].reference));
        assert.match(page.htmlContent, new RegExp(assets[0].reference));
        assert.equal(value.blocks[1]!.source, imageSource);
      } else assert.equal(page.visualDocumentJson, null);
    }
  }
});

function rerunSetup(failure?: "provider" | "missing-document" | "invalid-document" | "stale", configure?: (generated: VisualPageDocument, existing: any[], page: any) => void) {
  const generated = document();
  const existing = ["Stable paragraph identity", "Archived unmatched annotation"].map((paragraphText, index) => ({
    paragraphId: randomUUID(), paragraphNumber: index + 1, sequenceNumber: index + 1, paragraphText,
    role: "body", active: index !== 0, readAloud: false, includeInToc: true, imageWidth: 35, geometry: null
  }));
  const page = { pageId: randomUUID(), updatedAt: "version", sourceFileId: randomUUID(), sourceImageRotation: 0, htmlContent: null, sourceHtmlContent: null as string | null };
  configure?.(generated, existing, page);
  const calls: { sql: string; binds?: any }[] = [];
  let options: any, replacement: any;
  const connection = { execute: async (sql: string, binds: any) => {
    calls.push({ sql, binds });
    if (sql.includes("FROM book_files")) return { rows: [{ contentBlob: Buffer.from("image"), mimeType: "image/png" }] };
    if (sql.includes("SET source_html_content = :sourceHtmlContent")) {
      assert.match(sql, /AND source_html_content IS NULL/u);
      assert.equal(binds.sourceHtmlContent.type, 2);
      page.sourceHtmlContent ??= binds.sourceHtmlContent.val;
    }
    return { rows: [] };
  }, commit: async () => { calls.push({ sql: "commit" }); }, rollback: async () => { calls.push({ sql: "rollback" }); }, close: async () => undefined };
  const deps = { ...common, ...matching, rerunOcrPageSchema: schemas.rerunOcrPageSchema,
    pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }), getConnection: async () => connection,
    findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es", title: "Book" }), findBookPage: async () => page,
    listPageParagraphs: async () => { calls.push({ sql: "readParagraphs" }); return existing; }, listPageBookmarks: async () => [{ paragraphId: existing[1]!.paragraphId }],
    listPageHighlights: async () => [], listPageNotes: async () => [{ paragraphId: existing[1]!.paragraphId }],
    invalidateBookAudioCache: async () => undefined, shiftSubsequentSequenceNumbers: async () => undefined,
    shiftSubsequentAnnotationSequenceNumbers: async () => undefined,
    restorePageBookmarks: async () => undefined, restorePageNotes: async () => undefined,
    getEffectiveUserAiCredentials: async () => ({ opencodeOcrModel: "audit-model", opencodeApiKey: "secret" }), collectBookOcrMarginHints: async () => undefined,
    runOcrOnImage: async (_b: unknown, _f: unknown, _m: unknown, input: any) => {
      options = input;
      calls.push({ sql: "mockOcr" });
      if (failure === "provider") throw new Error("advanced pass failed");
      return { ...renderVisualDocument(generated), ...(failure === "missing-document" ? {} : { visualDocument: failure === "invalid-document" ? { version: 2 } : generated }) };
    }, insertContentImageAssets: async () => { calls.push({ sql: "assets" }); },
    recordUserActivity: async (_c: unknown, binds: any) => { calls.push({ sql: "audit", binds }); }, oracledb: { BUFFER: 1, CLOB: 2 } };
  const { replaceBookPageParagraphs } = functions(["replaceBookPageParagraphs"], deps);
  Object.assign(deps, { replaceBookPageParagraphs: async (c: any, value: any) => { replacement = value; return replaceBookPageParagraphs(c, value); } });
  const run = handler("post", "/:bookId/pages/:pageNumber/rerun-ocr", deps);
  return { existing, generated, calls, page, get options() { return options; }, get replacement() { return replacement; },
    call: async (advancedLayout = true) => {
      const reply = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, send() { return this; } };
      await run({ currentUser: { userId: "editor" }, params: { bookId: "book", pageNumber: 1 },
        body: { ocrMode: "VISION", advancedLayout, expectedUpdatedAt: failure === "stale" ? "old-version" : "version" } }, reply);
      return reply;
    } };
}

test("initial advanced persistence validates documents before even cover/file writes", async () => {
  const { insertProcessedImagePages } = functions(["insertProcessedImagePages"], common);
  for (const visualDocument of [undefined, { version: 2 }]) {
    const calls: string[] = [];
    await assert.rejects(insertProcessedImagePages({ execute: async (sql: string) => { calls.push(sql); return { rows: [] }; } }, "book", [{
      advancedLayout: true, visualDocument, buffer: Buffer.from("image"), fileName: "page.png", mimeType: "image/png",
      paragraphs: [], editedText: "", htmlContent: null, rawText: ""
    }], 1, 1));
    assert.deepEqual(calls, []);
  }
});

test("visual replacement rejects omitted existing IDs before reserving negative SQL positions", async () => {
  const calls: string[] = [];
  const existing = { paragraphId: randomUUID(), paragraphText: "Old", paragraphNumber: 1, sequenceNumber: 1, role: "body", readAloud: true };
  const { replaceBookPageParagraphs } = functions(["replaceBookPageParagraphs"], { ...common, ...matching,
    listPageParagraphs: async () => [existing], listPageBookmarks: async () => [], listPageHighlights: async () => [], listPageNotes: async () => [] });
  const value = document(), rendered = renderVisualDocument(value);
  await assert.rejects(replaceBookPageParagraphs({ execute: async (sql: string) => { calls.push(sql); return { rows: [] }; } }, {
    bookId: "book", pageNumber: 1, page: { pageId: "page" }, visualDocument: value, requestedParagraphIds: rendered.paragraphIds,
    paragraphs: rendered.paragraphs, rawText: rendered.rawText, htmlContent: rendered.htmlContent, editedText: rendered.editedText, ocrStatus: "READY"
  }), /conservar todos/u);
  assert.ok(calls.every((sql) => /^\s*SELECT/u.test(sql)));
});

test("advanced rerun reconciles fresh UUIDs, preserves flags and unmatched annotated rows, and restores every SQL position", async () => {
  const app = rerunSetup();
  assert.equal((await app.call()).statusCode, 200);
  assert.equal(app.options.advancedLayout, true);
  assert.deepEqual(app.options.advancedLayoutLimits, { maxBlocks: 498, maxDepth: 7 });
  assert.equal(app.calls.filter(({ sql }) => sql === "readParagraphs").length, 1);
  assert.ok(app.calls.findIndex(({ sql }) => sql === "readParagraphs") < app.calls.findIndex(({ sql }) => sql === "mockOcr"));
  const saved = app.replacement;
  const rendered = renderVisualDocument(saved.visualDocument, { includeInactive: true });
  assert.deepEqual(saved.requestedParagraphIds, rendered.paragraphIds);
  assert.deepEqual(saved.paragraphs, rendered.paragraphs);
  assert.deepEqual(saved.paragraphMetadata, rendered.paragraphMetadata);
  assert.equal(saved.requestedParagraphIds[1], app.existing[0]!.paragraphId);
  assert.equal(saved.requestedParagraphIds[2], app.existing[1]!.paragraphId);
  assert.equal(saved.paragraphMetadata[1].active, false);
  assert.equal(saved.paragraphMetadata[1].readAloud, false);
  assert.equal(saved.paragraphMetadata[1].includeInToc, true);
  assert.equal(saved.paragraphMetadata[1].imageWidth, null);
  assert.equal(saved.paragraphMetadata[2].active, false);
  assert.equal(saved.paragraphs[2], app.existing[1]!.paragraphText);
  assert.doesNotMatch(JSON.stringify(saved), /data:image/u);
   const snapshotWrite = app.calls.find(({ sql }) => sql.includes("SET source_html_content = :sourceHtmlContent"))!;
   assert.equal(snapshotWrite.binds.sourceHtmlContent.val, rendered.htmlContent);
  const snapshot = load(app.page.sourceHtmlContent!);
  assert.deepEqual(snapshot("[data-visual-block-id]").toArray().map((node) => snapshot(node).attr("data-visual-block-id")), saved.requestedParagraphIds);
  assert.equal(snapshot(`[data-visual-block-id="${app.generated.blocks[0]!.id}"]`).length, 0);
  assert.equal(snapshot(`[data-visual-block-id="${app.existing[0]!.paragraphId}"]`).attr("data-active"), "false");
  assert.doesNotMatch(app.page.sourceHtmlContent!, /data:image/u);
  const paragraphs = saved.paragraphs.map((paragraphText: string, index: number) => ({ ...saved.paragraphMetadata[index], paragraphText,
    paragraphId: saved.requestedParagraphIds[index], paragraphNumber: index + 1 }));
  const bound = load(visualSourceHtml(app.page.sourceHtmlContent, paragraphs, saved.visualDocument)!);
  assert.deepEqual(bound("[data-paragraph-id]").toArray().map((node) => bound(node).attr("data-paragraph-id")), saved.requestedParagraphIds);
  const writes = app.calls.filter(({ sql, binds }) => /(?:INSERT INTO|UPDATE) book_paragraphs/u.test(sql) && binds?.paragraphId);
  assert.deepEqual(writes.map(({ binds }) => binds.paragraphNumber), [1, 2, 3]);
  assert.ok(app.existing.every((previous) => writes.some(({ binds }) => binds.paragraphId === previous.paragraphId && binds.sequenceNumber > 0)));
  assert.ok(!app.calls.some(({ sql }) => /DELETE FROM (?:book_paragraphs|user_notes)/u.test(sql)));
  assert.equal(app.calls.filter(({ sql }) => /UPDATE user_(?:bookmarks|highlights|notes) SET paragraph_number/u.test(sql)).length, 6);
  assert.deepEqual(JSON.parse(app.calls.find(({ sql }) => sql === "audit")!.binds.detail), { ocrMode: "VISION", advancedLayout: true, ocrModel: "audit-model" });
  assert.ok(app.calls.some(({ sql }) => sql === "commit"));
  assert.match(app.calls[0]!.sql, /FROM books.*FOR UPDATE/u);
  assert.match(app.calls[1]!.sql, /FROM book_pages.*FOR UPDATE/u);
});

test("advanced rerun preserves an intentional existing source snapshot via a conditional update", async () => {
  const original = '<p data-paragraph-id="historical">Original source</p>';
  const app = rerunSetup(undefined, (_generated, _existing, page) => { page.sourceHtmlContent = original; });
  await app.call();
  assert.equal(app.page.sourceHtmlContent, original);
  const snapshotWrite = app.calls.find(({ sql }) => sql.includes("SET source_html_content = :sourceHtmlContent"))!;
  assert.match(snapshotWrite.sql, /AND source_html_content IS NULL/u);
  assert.doesNotMatch(snapshotWrite.sql, /COALESCE|NVL/u);
});

test("advanced rerun keeps recalculated image widths instead of restoring old layout sizing", async () => {
  const app = rerunSetup(undefined, (generated, existing) => {
    generated.blocks[1]!.imageWidth = 55;
    existing[0]!.paragraphText = "Imagen. Portrait";
    existing[0]!.role = "image";
    existing[0]!.active = true;
    existing[0]!.imageWidth = 100;
  });
  assert.equal((await app.call()).statusCode, 200);
  const saved = app.replacement;
  const matched = saved.visualDocument.blocks.find((block) => block.id === app.existing[0]!.paragraphId);
  assert.equal(matched.kind, "image");
  assert.equal(matched.imageWidth, 55);
  assert.equal(matched.readAloud, false);
  const index = saved.requestedParagraphIds.indexOf(matched.id);
  assert.equal(saved.paragraphMetadata[index].imageWidth, 55);
});

test("advanced snapshot uses explicit CLOB binds for short and greater-than-32KB HTML", async () => {
  for (const large of [false, true]) {
    const app = rerunSetup(undefined, (generated) => {
      if (large) generated.blocks[0]!.text = "a".repeat(40_000);
    });
    assert.equal((await app.call()).statusCode, 200);
    const snapshotWrite = app.calls.find(({ sql }) => sql.includes("SET source_html_content = :sourceHtmlContent"))!;
    assert.doesNotMatch(snapshotWrite.sql, /COALESCE|NVL/u);
    assert.match(snapshotWrite.sql, /WHERE page_id = :pageId AND source_html_content IS NULL/u);
    assert.equal(snapshotWrite.binds.sourceHtmlContent.type, 2);
    assert.equal(snapshotWrite.binds.sourceHtmlContent.val, renderVisualDocument(app.replacement.visualDocument, { includeInactive: true }).htmlContent);
    assert.equal(snapshotWrite.binds.sourceHtmlContent.val.length > 32767, large);
    assert.ok(app.calls.some(({ sql }) => sql === "commit"));
  }
});

test("standard rerun does not reserve advanced limits or use visual replacement and reads paragraphs only after OCR", async () => {
  const app = rerunSetup();
  assert.equal((await app.call(false)).statusCode, 200);
  assert.equal(app.options.advancedLayout, false);
  assert.equal(app.options.advancedLayoutLimits, undefined);
  assert.equal(app.replacement.visualDocument, undefined);
  assert.equal(app.replacement.existingParagraphs, undefined);
  assert.equal(app.replacement.requestedParagraphIds, undefined);
  assert.equal(app.calls.filter(({ sql }) => sql === "readParagraphs").length, 1);
  assert.ok(app.calls.findIndex(({ sql }) => sql === "readParagraphs") > app.calls.findIndex(({ sql }) => sql === "mockOcr"));
  assert.ok(!app.calls.some(({ sql }) => sql.includes("SET source_html_content = :sourceHtmlContent")));
  assert.ok(app.calls.some(({ sql }) => sql.includes("DELETE FROM book_paragraphs")));
  assert.ok(app.calls.some(({ sql }) => sql === "commit"));
});

test("advanced rerun reserves space before paid OCR and rejects full previous pages without mutations", async () => {
  for (const count of [500, 501]) {
    const app = rerunSetup(undefined, (_generated, existing) => {
      while (existing.length < count) existing.push({ ...existing[0], paragraphId: randomUUID(), paragraphNumber: existing.length + 1 });
    });
    assert.equal((await app.call()).statusCode, 400);
    assert.equal(app.options, undefined);
    assert.equal(app.replacement, undefined);
    assert.equal(app.calls.filter(({ sql }) => sql === "readParagraphs").length, 1);
    assert.ok(!app.calls.some(({ sql }) => /FROM book_files|^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql) || ["mockOcr", "assets", "audit", "commit"].includes(sql)));
  }
});

test("advanced rerun appends inactives to a plain depth-eight root and extends existing weights without wrapping", async () => {
  const app = rerunSetup(undefined, (generated) => {
    assert.ok(generated.layout.type !== "block");
    delete generated.layout.semantic;
    generated.layout.weights = [3, 1];
    let child = generated.layout.children[0]!;
    for (let index = 0; index < 6; index++) child = { id: randomUUID(), type: "column", children: [child] };
    generated.layout.children[0] = child;
  });
  assert.equal((await app.call()).statusCode, 200);
  const saved = visualPageDocumentSchema.parse(app.replacement.visualDocument);
  assert.ok(saved.layout.type !== "block");
  assert.equal(saved.layout.id, app.generated.layout.id);
  assert.equal(saved.layout.children.length, 3);
  assert.deepEqual(saved.layout.weights, [3, 1, 1]);
  assert.equal(app.replacement.requestedParagraphIds.at(-1), app.existing[1]!.paragraphId);
});

test("advanced rerun uses the reserved depth for semantic roots and checks final block/depth budgets before writes", async () => {
  for (const depth of [7, 8]) {
    const app = rerunSetup(undefined, (generated) => {
      assert.ok(generated.layout.type !== "block");
      let child = generated.layout.children[0]!;
      for (let index = 0; index < depth - 2; index++) child = { id: randomUUID(), type: "column", children: [child] };
      generated.layout.children[0] = child;
    });
    if (depth === 7) {
      assert.equal((await app.call()).statusCode, 200);
      const saved = visualPageDocumentSchema.parse(app.replacement.visualDocument);
      assert.ok(saved.layout.type !== "block");
      assert.equal(saved.layout.children[0]!.id, app.generated.layout.id);
    } else {
      await assert.rejects(app.call());
      assert.equal(app.replacement, undefined);
      assert.ok(!app.calls.some(({ sql }) => /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql) || ["assets", "audit", "commit"].includes(sql)));
    }
  }
  const overflow = rerunSetup(undefined, (generated) => {
    assert.ok(generated.layout.type !== "block");
    while (generated.blocks.length < 500) {
      const atom = { ...generated.blocks[0]!, id: randomUUID(), text: `Fresh block ${generated.blocks.length}` };
      generated.blocks.push(atom);
      generated.layout.children.push({ id: randomUUID(), type: "block", blockId: atom.id });
    }
  });
  await assert.rejects(overflow.call());
  assert.equal(overflow.replacement, undefined);
  assert.ok(!overflow.calls.some(({ sql }) => /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql) || ["assets", "audit", "commit"].includes(sql)));
});

test("failed advanced reruns and stale versions never write assets, paragraphs, audit or page content", async () => {
  for (const failure of ["provider", "missing-document", "invalid-document", "stale"] as const) {
    const app = rerunSetup(failure);
    if (failure === "stale") assert.equal((await app.call()).statusCode, 409);
    else await assert.rejects(app.call());
    assert.equal(app.replacement, undefined);
    assert.ok(!app.calls.some(({ sql }) => /^\s*(?:UPDATE|DELETE|INSERT)\b/u.test(sql) || ["assets", "audit", "commit"].includes(sql)));
  }
});
