import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import sharp from "sharp";
import { load } from "cheerio";
import { parsePageStyle } from "../src/modules/books/page-style.js";
import { buildRichPageFromEditableText, extractEmbeddedImageSources } from "../src/modules/books/rich-content.js";
import { buildVisualDocumentFromPage, cropVisualPageImage, renderVisualDocument, visualSourceHtml, visualPageDocumentSchema, type VisualPageDocument } from "../src/modules/books/visual-document.js";
import { annotatePageElementHtml, normalizeParagraphMetadata, paragraphElementMetadataSchema, projectActivePageHtml } from "../src/modules/books/page-elements.js";
import { matchParagraphsWithExplicitIds } from "../src/modules/books/paragraph-ids.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
const params = { bookId: randomUUID(), pageNumber: 1 };
const version = "2026-10-02T12:00:00.000001";
const savedVersion = "2026-10-02T12:00:00.000002";
const paragraphId = randomUUID();
const paragraph = { paragraphId, paragraphNumber: 1, sequenceNumber: 1, paragraphText: "Original", role: "body" as const,
  readAloud: true, active: false, includeInToc: true, imageWidth: 60, geometry: null };
const document = (): VisualPageDocument => ({ version: 1,
  blocks: [{ id: paragraphId, kind: "text", text: "Original", role: "body", active: false, readAloud: true, includeInToc: true, imageWidth: 60 }],
  layout: { id: randomUUID(), type: "column", children: [{ id: randomUUID(), type: "block", blockId: paragraphId }] } });

function declaration(name: string) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node);
  return ts.transpile(node.getText(source).replace(/^export /u, ""), { target: ts.ScriptTarget.ES2022 });
}
function handler(method: string, path: string, dependencies: Record<string, unknown>) {
  const start = routes.indexOf(`  app.${method}("${path}",`);
  const end = routes.indexOf("\n  });", start);
  assert.ok(start >= 0 && end >= 0);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  return new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
function reply() {
  return { statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
}
function setup(options: { foreign?: boolean; failReplace?: boolean; stored?: VisualPageDocument; buffer?: Buffer } = {}) {
  const calls: { sql: string; binds?: any }[] = [];
  let committed = 0;
  let rolledBack = 0;
  let replacement: any;
  const page = { pageId: "page", updatedAt: version, sourceFileId: "image", sourceImageRotation: 0,
    ...(options.stored ? { visualDocumentJson: JSON.stringify(options.stored) } : {}) };
  const connection = { execute: async (sql: string, binds: any) => {
    calls.push({ sql, binds });
    if (sql.includes('page_id AS "pageId" FROM book_paragraphs')) return { rows: options.foreign ? [{ paragraphId: "foreign", pageId: "other-page" }] : [] };
    if (sql.includes('content_blob AS "buffer"')) return { rows: [{ buffer: options.buffer }] };
    return { rows: [] };
  }, commit: async () => { calls.push({ sql: "commit" }); committed++; page.updatedAt = "concurrent-version"; },
  rollback: async () => { rolledBack++; }, close: async () => undefined };
  const dependencies = {
    z, pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.number() }),
    updateVisualDocumentSchema: z.object({ document: visualPageDocumentSchema, expectedUpdatedAt: z.string().min(1).max(100) }).strict(),
    getConnection: async () => connection, findBookPage: async () => page,
    findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es" }),
    listPageParagraphs: async () => [paragraph], visualPageDocumentSchema, cropVisualPageImage, renderVisualDocument, visualSourceHtml,
    externalizeContentImages: (sources: string[]) => {
      calls.push({ sql: "externalize" });
      return { contents: sources.map((source) => source.startsWith("data:") ? `lector-content-image:${randomUUID()}` : source), assets: ["asset"] };
    }, insertContentImageAssets: async (...args: any[]) => { calls.push({ sql: "insertAssets", binds: args }); },
    replaceBookPageParagraphs: async (_connection: any, options: any) => {
      replacement = options; calls.push({ sql: "replace" });
      if (setupOptions.failReplace) throw new Error("failed");
      page.updatedAt = savedVersion;
    }, oracledb: { BUFFER: 1 }
  };
  const setupOptions = options;
  const save = handler("put", "/:bookId/pages/:pageNumber/visual-document", dependencies);
  return { calls, page, get replacement() { return replacement; }, get rolledBack() { return rolledBack; },
    call: async (doc: VisualPageDocument, expectedUpdatedAt = version) => {
      const response = reply();
      await save({ params, body: { document: doc, expectedUpdatedAt }, currentUser: { userId: "editor" } }, response);
      return { ...response, committed };
    } };
}

test("PUT has EDITOR guard, book/page lock ordering, mandatory version and no writes on stale/foreign/missing IDs", async () => {
  assert.match(routes, /app\.put\("\/:bookId\/pages\/:pageNumber\/visual-document", \{ preHandler: \[authenticateRequest, requireBookRole\("EDITOR"\)\]/u);
  for (const kind of ["stale", "missing", "foreign", "emptyVersion"] as const) {
    const app = setup({ foreign: kind === "foreign" });
    const value = document();
    if (kind === "missing") { value.blocks = []; (value.layout as any).children = []; }
    const result = await app.call(value, kind === "stale" ? "old-version" : kind === "emptyVersion" ? "" : version);
    assert.equal(result.statusCode, kind === "stale" ? 409 : 400, kind);
    assert.equal(result.committed, 0);
    assert.ok(!app.calls.some(({ sql }) => /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql) || ["externalize", "insertAssets", "replace"].includes(sql)));
    if (kind !== "emptyVersion") {
      assert.match(app.calls[0]!.sql, /FROM books.*FOR UPDATE/u);
      assert.match(app.calls[1]!.sql, /FROM book_pages.*FOR UPDATE/u);
    }
  }
});

test("PUT new client IDs and complete inactive atoms reach persistence in DFS order and return its own version", async () => {
  const value = document();
  const id = randomUUID();
  value.blocks.push({ id, kind: "text", text: "Manual\n**text**", role: "body", active: true, readAloud: true, includeInToc: false });
  (value.layout as any).children.unshift({ id: randomUUID(), type: "block", blockId: id });
  const app = setup();
  const result = await app.call(value);
  assert.equal(result.committed, 1);
  assert.equal(result.body.updatedAt, savedVersion);
  assert.deepEqual(result.body.document, value);
  assert.deepEqual(app.replacement.requestedParagraphIds, [id, paragraphId]);
  assert.deepEqual(app.replacement.paragraphs, ["Manual\ntext", "Original"]);
  assert.equal(app.replacement.paragraphMetadata[1].active, false);
  assert.equal(app.replacement.visualDocument.blocks[0].id, paragraphId);
  assert.ok(app.calls.some(({ sql }) => sql.includes("UPDATE user_book_ai_requests SET is_stale = 1")));
  assert.ok(app.calls.some(({ sql }) => sql.includes("UPDATE user_book_section_summaries SET is_stale = 1")));
  assert.equal(app.calls.at(-1)?.sql, "commit");
});

test("PUT crop/externalization happens inside transaction, resolves returned sources and rolls back asset/paragraph failure", async () => {
  const buffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: "white" } }).png().toBuffer();
  const value = document();
  const id = randomUUID();
  value.blocks.push({ id, kind: "image", source: "page-crop", text: "Crop", role: "image", active: true, readAloud: false,
    includeInToc: false, geometry: { bbox: { left: 0, top: 0, width: 0.5, height: 0.5 } } });
  (value.layout as any).children.push({ id: randomUUID(), type: "block", blockId: id });
  const original = Buffer.from(buffer);
  const app = setup({ buffer });
  const result = await app.call(value);
  assert.equal(result.committed, 1);
  assert.match(result.body.document.blocks[1].source, /^lector-content-image:/u);
  assert.deepEqual(buffer, original);
  assert.equal(value.blocks[1]!.source, "page-crop");
  const failed = setup({ buffer, failReplace: true });
  await assert.rejects(failed.call(value), /failed/u);
  assert.equal(failed.rolledBack, 1);
  assert.ok(!failed.calls.some(({ sql }) => sql === "commit"));
  assert.ok(!failed.calls.some(({ sql }) => /UPDATE book_files/u.test(sql)));
});

test("unchanged visual save does not mark cached AI stale", async () => {
  const value = document();
  const app = setup({ stored: value });
  await app.call(value);
  assert.ok(!app.calls.some(({ sql }) => sql.includes("is_stale = 1")));
});

function ocrSetup(storedPage: { htmlContent?: string | null; visualDocumentJson?: string | null } = {}) {
  const calls: string[] = [];
  let replacement: any;
  const page = { pageId: "page", updatedAt: version, sourceFileId: "image", sourceImageRotation: 0, htmlContent: null, ...storedPage };
  const connection = {
    execute: async (sql: string) => {
      calls.push(sql);
      return { rows: sql.includes("FROM book_files") ? [{ contentBlob: Buffer.alloc(0), fileName: "page.png", mimeType: "image/png" }] : [] };
    },
    commit: async () => { calls.push("commit"); }, rollback: async () => { calls.push("rollback"); }, close: async () => { calls.push("close"); }
  };
  const dependencies = {
    load, parsePageStyle, visualPageDocumentSchema,
    pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.number() }),
    updateOcrPageSchema: z.object({ editedText: z.string().min(1), expectedUpdatedAt: z.string().optional() }),
    rerunOcrPageSchema: z.object({ expectedUpdatedAt: z.string().optional(), ocrMode: z.literal("VISION") }),
    getConnection: async () => connection, findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es", title: "Book" }),
    findBookPage: async () => page,
    extractEmbeddedImageSources: (html: string | null) => { calls.push("extractImages"); return extractEmbeddedImageSources(html); },
    buildRichPageFromEditableText: (text: string, options: any) => { calls.push("buildRich"); return buildRichPageFromEditableText(text, options); },
    externalizeContentImages: (contents: string[]) => { calls.push("externalize"); return { contents, assets: [] }; },
    insertContentImageAssets: async () => { calls.push("insertAssets"); },
    replaceBookPageParagraphs: async (_connection: unknown, value: unknown) => { calls.push("replace"); replacement = value; page.updatedAt = savedVersion; },
    recordUserActivity: async () => { calls.push("activity"); },
    getEffectiveUserAiCredentials: async () => ({}), collectBookOcrMarginHints: async () => undefined,
    runOcrOnImage: async () => { calls.push("mockOcr"); return buildRichPageFromEditableText("Intentionally reprocessed."); },
    oracledb: { BUFFER: 1 }
  };
  return { page, calls, get replacement() { return replacement; },
    call: async (rerun = false) => {
      const response = reply();
      const run = handler(rerun ? "post" : "put", rerun ? "/:bookId/pages/:pageNumber/rerun-ocr" : "/:bookId/pages/:pageNumber/ocr", dependencies);
      await run({ params, currentUser: { userId: "editor" }, body: { expectedUpdatedAt: version, ...(rerun ? { ocrMode: "VISION" } : { editedText: "Edited legacy text." }) } }, response);
      return response;
    } };
}

test("legacy PUT /ocr rejects visual documents, editorial styles and separated image alt before reconstruction or any writes", async () => {
  const styled = document();
  styled.blocks[0]!.style = { color: "#123abc" };
  const separated = document();
  separated.blocks[0] = { ...separated.blocks[0]!, kind: "image", source: "https://example.com/image.png", text: "Printed caption", altText: "Portrait" };
  for (const storedPage of [
    { visualDocumentJson: JSON.stringify(document()) },
    { visualDocumentJson: JSON.stringify(styled) },
    { visualDocumentJson: JSON.stringify(separated) },
    { htmlContent: '<figure data-image-alt-separated="true"><img alt="Portrait"><figcaption>Printed caption</figcaption></figure>' },
    ...["color:#123abc", "background-color:#fffefd", "border-color:#abcdef", "border-width:0px", "padding:12px", "font-size:1.5em", "font-family:serif", "text-align:center"]
      .map((style) => ({ htmlContent: `<p data-paragraph-number="1" style="${style}">Original</p>` }))
  ]) {
    const app = ocrSetup(storedPage);
    const original = structuredClone(app.page);
    const response = await app.call();
    assert.equal(response.statusCode, 409, JSON.stringify(storedPage));
    assert.match(response.body.message, /Utiliza el editor visual/u);
    assert.deepEqual(app.page, original);
    assert.equal(app.replacement, undefined);
    assert.equal(app.calls.length, 3);
    assert.match(app.calls[0]!, /FROM books.*FOR UPDATE/u);
    assert.match(app.calls[1]!, /FROM book_pages.*FOR UPDATE/u);
    assert.equal(app.calls[2], "close");
  }
});

test("legacy PUT /ocr still saves unstyled legacy pages and intentional OCR rerun is not blocked by editorial metadata", async () => {
  for (const storedPage of [{ htmlContent: "<p>Original</p>" }, {}]) {
    const app = ocrSetup(storedPage);
    assert.equal((await app.call()).statusCode, 200);
    assert.deepEqual(app.replacement.paragraphs, ["Edited legacy text."]);
    assert.ok(app.calls.includes("commit"));
  }
  const value = document();
  value.blocks[0]!.style = { backgroundColor: "#fffefd", padding: 12 };
  const app = ocrSetup({ visualDocumentJson: JSON.stringify(value), htmlContent: '<figure data-image-alt-separated="true" style="padding:12px"><img alt="Portrait"></figure>' });
  assert.equal((await app.call(true)).statusCode, 200);
  assert.deepEqual(app.replacement.paragraphs, ["Intentionally reprocessed."]);
  assert.ok(app.calls.includes("mockOcr"));
  assert.ok(app.calls.includes("commit"));
});

test("compound references follow current active anchor after save/reload and revert on separation without alias writes", async () => {
  const value = document();
  value.blocks[0]!.active = true;
  const second = randomUUID();
  value.blocks.push({ id: second, kind: "heading", text: "Second", headingLevel: 2, role: "heading",
    active: true, readAloud: true, includeInToc: true });
  if (value.layout.type === "block") throw new Error("container expected");
  value.layout.children.push({ id: randomUUID(), type: "block", blockId: second });
  value.layout.content = { kind: "heading", separator: "space", includeInToc: true };
  const app = setup();
  const saved = await app.call(value);
  assert.equal(saved.committed, 1);
  assert.deepEqual(app.replacement.paragraphs, ["Original", "Second"]);
  assert.deepEqual(app.replacement.requestedParagraphIds, [paragraphId, second]);
  assert.ok(!app.calls.some(({ sql }) => /(?:INSERT|DELETE|UPDATE).*book_section_aliases/su.test(sql)));
  let stored = JSON.stringify(saved.body.document);
  const calls: string[] = [];
  const connection = { execute: async (sql: string) => { calls.push(sql); return { rows: [{ visualDocumentJson: stored }] }; } };
  const dependencies = { visualPageDocumentSchema };
  const resolve = new Function(...Object.keys(dependencies), `${declaration("resolveCanonicalChapterId")}; return resolveCanonicalChapterId;`)(...Object.values(dependencies));
  assert.equal(await resolve(connection, params.bookId, second), paragraphId);
  assert.equal(await resolve(connection, params.bookId, paragraphId), paragraphId);
  const reloaded = JSON.parse(stored);
  reloaded.blocks[0].active = false;
  stored = JSON.stringify(reloaded);
  assert.equal(await resolve(connection, params.bookId, paragraphId), second);
  delete reloaded.layout.content;
  stored = JSON.stringify(reloaded);
  assert.equal(await resolve(connection, params.bookId, second), second);
  assert.equal(await resolve(connection, params.bookId, paragraphId), paragraphId);
  assert.ok(calls.every((sql) => /^SELECT/u.test(sql)));
});

test("old member summary cache is read with stale masking only while the member resolves to the current compound", async () => {
  const anchor = randomUUID();
  const member = randomUUID();
  const reads: string[] = [];
  let joined = true;
  const dependencies = {
    findStoredSectionSummary: async (_connection: unknown, _bookId: string, id: string) => {
      reads.push(id);
      return id === member ? { chapterId: member, isStale: true, summaryText: "El contenido ha cambiado. Regenera el resumen." } : null;
    },
    resolveCanonicalChapterId: async () => joined ? anchor : member,
    findGeneratedSectionSummaryFallback: async () => null
  };
  const find = new Function(...Object.keys(dependencies), `${declaration("findStoredSectionSummaryForSection")}; return findStoredSectionSummaryForSection;`)(...Object.values(dependencies));
  const cached = await find({}, params.bookId, "user", { chapterId: anchor }, member);
  assert.equal(cached.isStale, true);
  assert.deepEqual(reads, [anchor, member]);
  joined = false;
  reads.length = 0;
  assert.equal(await find({}, params.bookId, "user", { chapterId: anchor }, member), null);
  assert.deepEqual(reads, [anchor]);
});

test("GET full document is OWNER/EDITOR only, derived without persistence, and ordinary GET never leaks inactive text", async () => {
  for (const role of ["OWNER", "EDITOR", "VIEWER", "COMMENTER"]) {
    for (const includeInactive of [false, true]) {
      const calls: string[] = [];
      const page = { pageId: "page", updatedAt: version, htmlContent: '<p data-paragraph-number="1">Original</p>', rawText: "Original", editedText: "Original" };
      const value = handler("get", "/:bookId/pages/:pageNumber", {
        z, pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }),
        getConnection: async () => ({ execute: async (sql: string) => { calls.push(sql); return { rows: sql.includes("FROM books b") ? [{ title: "Book", totalPages: 1, languageCode: "es" }] : [] }; }, commit: async () => undefined, close: async () => undefined }),
        findBookPage: async () => page, listPageParagraphs: async () => [paragraph], recordBookView: async () => undefined,
        buildVisualDocumentFromPage, visualPageDocumentSchema, renderVisualDocument, visualSourceHtml, annotatePageElementHtml, projectActivePageHtml
      });
      const response = reply();
      await value({ params, query: includeInactive ? { includeInactive: "true" } : {}, currentUser: { userId: "user" }, bookAccess: { role } }, response);
      if (includeInactive && role !== "OWNER" && role !== "EDITOR") { assert.equal(response.statusCode, 403); assert.equal(calls.length, 0); continue; }
      assert.equal(response.body.page.hasVisualDocument, false);
      assert.equal(response.body.page.paragraphs.length, includeInactive ? 1 : 0);
      if (includeInactive) assert.equal(response.body.page.visualDocument.blocks[0].id, paragraphId);
      else {
        assert.equal(response.body.page.visualDocument, undefined);
        assert.doesNotMatch(JSON.stringify(response.body.page), /Original/u);
      }
      assert.ok(!calls.some((sql) => /^\s*(?:UPDATE|INSERT|DELETE)\b/u.test(sql)));
      assert.match(calls.at(-1)!, /is_active = 1/u);
    }
  }
});

test("PATCH omits new metadata without resetting it and synchronizes only matching document blocks", async () => {
  for (const explicit of [false, true]) {
    const value = document();
    const calls: { sql: string; binds: any }[] = [];
    const patch = handler("patch", "/:bookId/pages/:pageNumber/elements", {
      pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }),
      updatePageElementsSchema: z.object({ elements: z.array(paragraphElementMetadataSchema.extend({ paragraphId: z.string() })), expectedUpdatedAt: z.string() }),
      getConnection: async () => ({ execute: async (sql: string, binds: any) => { calls.push({ sql, binds }); return { rows: [] }; }, commit: async () => undefined, rollback: async () => undefined, close: async () => undefined }),
      findBookPage: async () => ({ pageId: "page", updatedAt: version, visualDocumentJson: JSON.stringify(value) }),
      listPageParagraphs: async () => [paragraph], visualPageDocumentSchema, renderVisualDocument, invalidateBookAudioCache: async () => undefined
    });
    const response = reply();
    await patch({ params, currentUser: { userId: "editor" }, body: { expectedUpdatedAt: version,
      elements: [{ paragraphId, role: "footer", readAloud: false, ...(explicit ? { active: true, includeInToc: false, imageWidth: null } : {}) }] } }, response);
    assert.equal(response.statusCode, 200);
    const sqlMetadata = calls.find(({ sql }) => sql.includes("UPDATE book_paragraphs"))!.binds;
    assert.equal(sqlMetadata.active, explicit ? 1 : 0);
    assert.equal(sqlMetadata.includeInToc, explicit ? 0 : 1);
    assert.equal(sqlMetadata.imageWidth, explicit ? null : 60);
    const saved = JSON.parse(calls.find(({ sql }) => sql.includes("visual_document_json"))!.binds.document);
    assert.equal(saved.blocks[0].active, explicit);
    assert.equal(saved.blocks[0].includeInToc, !explicit);
    assert.equal(saved.blocks[0].imageWidth, explicit ? undefined : 60);
    assert.equal(saved.blocks[0].role, "footer");
    assert.equal(saved.blocks[0].id, paragraphId);
    assert.equal(saved.blocks[0].text, "Original");
  }
});

test("PATCH cannot reactivate an empty inactive atom or write an invalid document", async () => {
  const value = document(); value.blocks[0]!.text = "";
  const calls: string[] = [];
  const patch = handler("patch", "/:bookId/pages/:pageNumber/elements", {
    pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }),
    updatePageElementsSchema: z.object({ elements: z.array(paragraphElementMetadataSchema.extend({ paragraphId: z.string() })), expectedUpdatedAt: z.string() }),
    getConnection: async () => ({ execute: async (sql: string) => { calls.push(sql); return { rows: [] }; }, commit: async () => undefined, rollback: async () => undefined, close: async () => undefined }),
    findBookPage: async () => ({ pageId: "page", updatedAt: version, visualDocumentJson: JSON.stringify(value) }),
    listPageParagraphs: async () => [{ ...paragraph, paragraphText: " " }], visualPageDocumentSchema, renderVisualDocument,
    invalidateBookAudioCache: async () => undefined
  });
  const response = reply();
  await patch({ params, currentUser: { userId: "editor" }, body: { expectedUpdatedAt: version,
    elements: [{ paragraphId, role: "body", readAloud: true, active: true }] } }, response);
  assert.equal(response.statusCode, 400);
  assert.ok(!calls.some((sql) => /^\s*(?:UPDATE|DELETE|INSERT)\b/u.test(sql)));
});

test("legacy replacement keeps omitted inactive rows with their IDs, text and flags instead of deleting/reactivating them", async () => {
  const writes: any[] = [];
  const dependencies = { normalizeParagraphMetadata, listPageParagraphs: async () => [paragraph], listPageBookmarks: async () => [],
    listPageHighlights: async () => [], listPageNotes: async () => [], randomUUID, matchParagraphsWithExplicitIds,
    calculateParagraphReadingMetrics: () => ({ wordCount: 1, characterCount: 8 }), matchReplacementParagraphs: () => new Map(),
    invalidateBookAudioCache: async () => undefined, shiftSubsequentSequenceNumbers: async () => undefined, shiftSubsequentAnnotationSequenceNumbers: async () => undefined };
  const replace = new Function(...Object.keys(dependencies), `${declaration("replaceBookPageParagraphs")}; return replaceBookPageParagraphs;`)(...Object.values(dependencies));
  await replace({ execute: async (sql: string, binds: any) => { if (sql.includes("INSERT INTO book_paragraphs")) writes.push(binds); return { rows: [] }; } }, {
    ...params, page: { pageId: "page", sourceImageRotation: 0 }, paragraphs: ["New"], paragraphMetadata: [{ role: "body", readAloud: true }],
    rawText: "New", editedText: "New", htmlContent: null, ocrStatus: "READY"
  });
  assert.equal(writes.length, 2);
  assert.equal(writes[1].paragraphId, paragraphId); assert.equal(writes[1].paragraphText, "Original");
  assert.equal(writes[1].active, 0); assert.equal(writes[1].includeInToc, 1); assert.equal(writes[1].imageWidth, 60);
});

test("in-flight generation cannot overwrite stale flags with a response based on content annulled during generation", async () => {
  for (const path of ["/:bookId/ai-requests", "/:bookId/sections/:chapterId/ai-requests", "/:bookId/sections/:chapterId/summary"]) {
    const calls: string[] = [];
    let currentVersion = version;
    const section = { chapterId: "section", title: "Section" };
    const generate = async () => { calls.push("mockProvider"); currentVersion = savedVersion; return "Old generated text"; };
    const save = handler("post", path, {
      bookParamsSchema: z.object({ bookId: z.string() }), sectionParamsSchema: z.object({ bookId: z.string(), chapterId: z.string() }),
      aiRequestPayloadSchema: z.object({ promptText: z.string(), kind: z.string().default("TEXT") }), sectionSummaryGenerationSchema: z.object({}),
      getConnection: async () => ({ execute: async () => { calls.push("write"); return { rows: [] }; }, commit: async () => { calls.push("commit"); }, rollback: async () => undefined, close: async () => undefined }),
      findAccessibleBook: async () => ({ title: "Book", languageCode: "es" }),
      findBookContentVersion: async (_c: any, _id: string, lock: boolean) => { calls.push(lock ? "lockVersion" : "readVersion"); return currentVersion; },
      listBookParagraphTexts: async () => ["Original"], resolveBookSectionContext: async () => section,
      resolveSelectedSectionContexts: async () => [section], listSelectedSectionParagraphTexts: async () => ["Original"],
      listSectionParagraphTexts: async () => ["Original"], createSelectedSectionsAiTitle: () => "Section",
      getEffectiveUserAiCredentials: async () => ({}), generateAiRequestResponse: generate, generateSectionSummary: generate,
      appEnv: { opencodeModel: "test" }, createAiRequest: async () => { calls.push("create"); },
      findStoredSectionSummaryForSection: async () => { calls.push("findSummary"); }
    });
    const response = reply();
    await save({ params: { ...params, chapterId: "section" }, currentUser: { userId: "user" }, body: { promptText: "Prompt" } }, response);
    assert.equal(response.statusCode, 409, path);
    assert.deepEqual(calls, ["readVersion", "mockProvider", "lockVersion"]);
  }
  assert.match(declaration("findBookContentVersion"), /FOR UPDATE/u);
});

test("replacement honors requested new IDs and updates existing rows/annotations without cascade; omitted old metadata preserves flags", async () => {
  for (const visual of [false, true]) {
    const calls: { sql: string; binds: any }[] = [];
    const value = document();
    const newId = randomUUID();
    const dependencies = { normalizeParagraphMetadata, listPageParagraphs: async () => [paragraph], listPageBookmarks: async () => [],
      listPageHighlights: async () => [], listPageNotes: async () => [], randomUUID, matchParagraphsWithExplicitIds,
      calculateParagraphReadingMetrics: () => ({ wordCount: 1, characterCount: 8 }), matchReplacementParagraphs: () => new Map(),
      invalidateBookAudioCache: async () => undefined, shiftSubsequentSequenceNumbers: async () => undefined, shiftSubsequentAnnotationSequenceNumbers: async () => undefined };
    const replace = new Function(...Object.keys(dependencies), `${declaration("replaceBookPageParagraphs")}; return replaceBookPageParagraphs;`)(...Object.values(dependencies));
    await replace({ execute: async (sql: string, binds: any) => { calls.push({ sql, binds }); return { rows: [] }; } }, {
      ...params, page: { pageId: "page", sourceImageRotation: 0 }, paragraphs: ["New", "Original"], paragraphIds: [null, paragraphId],
      paragraphMetadata: [{ role: "body", readAloud: true }, { role: "body", readAloud: true }],
      ...(visual ? { visualDocument: value, requestedParagraphIds: [newId, paragraphId] } : {}),
      editedText: "New\nOriginal", rawText: "New\nOriginal", htmlContent: null, ocrStatus: "READY"
    });
    const writes = calls.filter(({ sql, binds }) => /(?:INSERT INTO|UPDATE) book_paragraphs/u.test(sql) && binds.paragraphId);
    assert.equal(writes[1]!.binds.paragraphId, paragraphId);
    assert.equal(writes[1]!.binds.active, 0); assert.equal(writes[1]!.binds.includeInToc, 1); assert.equal(writes[1]!.binds.imageWidth, 60);
    assert.equal(writes[0]!.binds.active, 1); assert.equal(writes[0]!.binds.includeInToc, null);
    if (visual) {
      assert.equal(writes[0]!.binds.paragraphId, newId);
      assert.ok(!calls.some(({ sql }) => /DELETE FROM (?:book_paragraphs|user_notes)/u.test(sql)));
      assert.equal(calls.filter(({ sql }) => /UPDATE user_(?:notes|highlights|bookmarks)/u.test(sql)).length, 3);
    }
    const pageBinds = calls.find(({ sql }) => sql.includes("UPDATE book_pages"))!.binds;
    assert.equal(pageBinds.visualDocumentJson, visual ? JSON.stringify(value) : null);
  }
});

test("cached AI projections mask stale CLOB text, preserve original records and reset stale on regeneration", () => {
  for (const name of ["findStoredSectionSummary", "findGeneratedSectionSummaryFallback", "listAiRequests"]) {
    assert.match(declaration(name), /CASE WHEN (?:ar\.)?is_stale = 1 THEN TO_CLOB\(/u);
  }
  assert.match(routes, /summary_text = :summaryText,\s+is_stale = 0/u);
  assert.match(declaration("listSectionParagraphTexts"), /is_active = 1/u);
  assert.match(declaration("listBookParagraphTexts"), /is_active = 1/u);
  assert.match(declaration("searchOwnedBookParagraphs"), /bp.is_active = 1[\s\S]*WHERE row_number > :offset/u);
  assert.match(declaration("assembleBookExportDownload"), /projectActivePageHtml/u);
  assert.match(declaration("findLastParagraphBoundary"), /is_active = 1/u);
  assert.doesNotMatch(declaration("countParagraphsUpToPage"), /is_active/u);
});

test("export assembly projects active SQL paragraphs and applies legacy metadata/width to HTML without renumbering", async () => {
  let payload: any;
  const dependencies = { renderVisualDocument, visualPageDocumentSchema, annotatePageElementHtml, projectActivePageHtml,
    paragraphElementMetadataSchema, resolveBookOutline: async () => [], resolveBookCoverAsset: async () => null,
    hydrateContentImages: (html: string) => html, oracledb: { BUFFER: 1 }, buildDownloadFileName: () => "book.epub",
    buildEpubExport: async (options: any) => { payload = options; return Buffer.from("epub"); } };
  const assemble = new Function(...Object.keys(dependencies), `${declaration("assembleBookExportDownload")}; return assembleBookExportDownload;`)(...Object.values(dependencies));
  const html = '<div class="reader-reading-row"><section class="reader-reading-block"><p data-paragraph-number="1">Secret</p></section><section class="reader-reading-block"><figure data-paragraph-number="2"><img src="https://example.com/a.png"><figcaption>Visible</figcaption></figure></section></div>';
  await assemble({ execute: async (sql: string) => ({ rows: sql.includes("FROM book_pages")
    ? [{ pageNumber: 1, htmlContent: html, pageLabel: null, visualDocumentJson: null }]
    : sql.includes("FROM book_paragraphs") ? [
      { pageNumber: 1, paragraphNumber: 1, paragraphText: "Secret", role: "body", readAloud: 1, active: 0, includeInToc: null, imageWidth: null },
      { pageNumber: 1, paragraphNumber: 2, paragraphText: "Imagen. Visible", role: "image", readAloud: 0, active: 1, includeInToc: false, imageWidth: 35 }
    ] : [] }) }, { bookId: params.bookId, title: "Book", sourceType: "IMAGES", languageCode: "es" }, "epub");
  assert.equal(payload.pages[0].paragraphs.length, 1);
  assert.equal(payload.pages[0].paragraphs[0].paragraphNumber, 2);
  assert.doesNotMatch(payload.pages[0].htmlContent, /Secret/u);
  assert.match(payload.pages[0].htmlContent, /data-image-width="35"/u);
  assert.match(payload.pages[0].htmlContent, /--reader-image-width:35%/u);
  assert.match(payload.pages[0].htmlContent, /data-read-aloud="false"/u);
  assert.match(html, /Secret/u);
});
