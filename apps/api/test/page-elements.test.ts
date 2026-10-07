import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { load } from "cheerio";
import ts from "typescript";
import { z } from "zod";
import { annotatePageElementHtml, geometrySchema, normalizeParagraphMetadata, pageElementRoles, paragraphElementMetadataSchema } from "../src/modules/books/page-elements.js";
import { normalizeImportedPageParagraphs } from "../src/modules/books/book-import.js";
import { matchParagraphsWithExplicitIds } from "../src/modules/books/paragraph-ids.js";
import { parsePageStyle } from "../src/modules/books/page-style.js";
import { visualPageDocumentSchema } from "../src/modules/books/visual-document.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
const bbox = { left: 0.1, top: 0.2, width: 0.3, height: 0.4 };
const geometry = { bbox };
const metadata = { role: "footer" as const, readAloud: false, geometry };

function declaration(name: string) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node);
  return ts.transpile(node.getText(source).replace(/^export /u, ""), { target: ts.ScriptTarget.ES2022 });
}

test("roles, booleans, normalized positive extents and tolerance are validated", () => {
  for (const role of pageElementRoles) assert.equal(paragraphElementMetadataSchema.parse({ role, readAloud: true }).readAloud, true);
  for (const invalid of [{ role: "unknown", readAloud: true }, { role: "body", readAloud: 1 }]) {
    assert.equal(paragraphElementMetadataSchema.safeParse(invalid).success, false);
  }
  for (const invalid of [{ ...bbox, left: -0.1 }, { ...bbox, width: 0 }, { ...bbox, height: -1 },
    { ...bbox, left: 0.9 }, { ...bbox, top: 1 }, { ...bbox, width: Infinity }]) {
    assert.equal(geometrySchema.safeParse({ bbox: invalid }).success, false);
  }
  assert.deepEqual(geometrySchema.parse({ bbox: { left: -0.0000001, top: 0, width: 1.0000001, height: 1 } }),
    { bbox: { left: 0, top: 0, width: 1, height: 1 } });
  assert.throws(() => normalizeParagraphMetadata([metadata], 2));
  assert.deepEqual(normalizeParagraphMetadata(undefined, 1), [{ role: "body", readAloud: true, geometry: null }]);
});

test("derived HTML escapes geometry JSON, replaces labels and computes block unions", () => {
  const html = '<section data-reading-block-id="b"><p data-paragraph-number="1" data-read-aloud="true">Text</p><p data-paragraph-number="2">Other</p></section>';
  const paragraphs = [{ ...metadata, paragraphNumber: 1 }, { role: "body" as const, readAloud: true, paragraphNumber: 2,
    geometry: { bbox: { left: 0.5, top: 0.6, width: 0.2, height: 0.2 } } }];
  const annotated = annotatePageElementHtml(html, paragraphs)!;
  assert.match(annotated, /&quot;bbox&quot;/);
  const document = load(annotated);
  assert.equal(document("p").first().attr("data-element-role"), "footer");
  assert.equal(document("p").first().attr("data-read-aloud"), "false");
  assert.deepEqual(JSON.parse(document("p").first().attr("data-element-geometry")!), geometry);
  const union = JSON.parse(document("section").attr("data-element-geometry")!).bbox;
  assert.equal(union.left, 0.1);
  assert.ok(Math.abs(union.width - 0.6) < 1e-12);
  assert.equal(annotatePageElementHtml(annotated, paragraphs), annotated);
  assert.equal(annotatePageElementHtml(null, paragraphs), null);
});

test("import sanitization preserves aligned descriptors and rejects ambiguous splitting/filtering", () => {
  const page = { pageNumber: 1, rawText: "text", paragraphs: [" text "], paragraphMetadata: [metadata] };
  assert.deepEqual(normalizeImportedPageParagraphs(page, "PDF"), { paragraphs: ["text"], paragraphMetadata: [metadata] });
  assert.throws(() => normalizeImportedPageParagraphs({ ...page, paragraphs: ["word ".repeat(300)] }, "PDF"));
  assert.throws(() => normalizeImportedPageParagraphs({ ...page, paragraphs: [""] }, "EPUB"));
  assert.throws(() => normalizeImportedPageParagraphs({ ...page, paragraphMetadata: [{ ...metadata, geometry: { bbox: { ...bbox, width: 2 } } }] }, "PDF"));
  assert.equal(normalizeImportedPageParagraphs({ pageNumber: 1, rawText: "", paragraphs: ["body"] }, "EPUB").paragraphMetadata, undefined);
});

function patchSetup() {
  const statements: { sql: string; binds: any }[] = [];
  let updatedAt = "2026-10-02T12:00:00.000001";
  let committed = false;
  const paragraph = { ...metadata, paragraphId: "p1", paragraphNumber: 1, sequenceNumber: 4, paragraphText: "unchanged" };
  const schemaNode = source.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === "updatePageElementsSchema"));
  assert.ok(schemaNode);
  const schema = new Function("z", "paragraphElementMetadataSchema", `${ts.transpile(schemaNode.getText(source))}; return updatePageElementsSchema;`)(z, paragraphElementMetadataSchema);
  const start = routes.indexOf('  app.patch("/:bookId/pages/:pageNumber/elements",');
  const end = routes.indexOf("\n  });", start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  assert.ok(body);
  const handler = new Function("pageParamsSchema", "updatePageElementsSchema", "getConnection", "findBookPage", "listPageParagraphs", "invalidateBookAudioCache",
    ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 }))(
    z.object({ bookId: z.string(), pageNumber: z.number() }), schema,
    async () => ({ execute: async (sql: string, binds: any) => {
      statements.push({ sql, binds });
      if (sql.includes("UPDATE book_pages")) updatedAt = "2026-10-02T12:00:00.000002";
      return { rows: [] };
    }, commit: async () => { committed = true; }, rollback: async () => undefined, close: async () => undefined }),
    async () => ({ pageId: "page", updatedAt }), async () => [paragraph],
    async () => { statements.push({ sql: "invalidateAudio", binds: {} }); }
  );
  return { statements, paragraph, call: async (elements: unknown[], expectedUpdatedAt = updatedAt) => {
    const reply = { statusCode: 200, body: undefined as any,
      status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
    await handler({ currentUser: { userId: "editor" }, params: { bookId: "book", pageNumber: 1 }, body: { elements, expectedUpdatedAt } }, reply);
    return { ...reply, committed };
  } };
}

test("PATCH flag-only changes metadata without renaming IDs or touching text or annotations", async () => {
  assert.match(routes, /app\.patch\("\/:bookId\/pages\/:pageNumber\/elements", \{ preHandler: \[authenticateRequest, requireBookRole\("EDITOR"\)\]/);
  const app = patchSetup();
  const before = structuredClone(app.paragraph);
  const result = await app.call([{ paragraphId: "p1", role: "footer", readAloud: true }]);
  assert.equal(result.statusCode, 200);
  assert.equal(result.committed, true);
  assert.equal(result.body.updatedAt, "2026-10-02T12:00:00.000002");
  assert.deepEqual(app.paragraph, before);
  const update = app.statements.find(({ sql }) => sql.includes("UPDATE book_paragraphs"))!;
  assert.equal(update.binds.readAloud, 1);
  assert.equal(update.binds.paragraphId, "p1");
  assert.deepEqual(JSON.parse(update.binds.geometryJson), geometry);
  assert.ok(app.statements.some(({ sql }) => sql === "invalidateAudio"));
  for (const { sql } of app.statements) assert.doesNotMatch(sql, /DELETE|INSERT|user_notes|user_highlights|user_bookmarks|paragraph_text\s*=|raw_text\s*=|html_content\s*=|paragraph_number\s*=|sequence_number\s*=/i);
});

test("PATCH rejects duplicates, foreign IDs, invalid geometry and exact stale version before updates", async () => {
  const element = { paragraphId: "p1", role: "body", readAloud: true };
  for (const elements of [[element, element], [{ ...element, paragraphId: "foreign" }],
    [{ ...element, geometry: { bbox: { ...bbox, width: 2 } } }]]) {
    const app = patchSetup();
    assert.equal((await app.call(elements)).statusCode, 400);
    assert.ok(!app.statements.some(({ sql }) => /^\s*UPDATE\b/u.test(sql)));
  }
  const app = patchSetup();
  assert.equal((await app.call([element], "2026-10-02T12:00:00.000000")).statusCode, 409);
  assert.ok(!app.statements.some(({ sql }) => /^\s*UPDATE\b/u.test(sql)));
});

test("replacement retains matched manual labels/flags/geometry and explicit descriptors override them", async () => {
  const compiled = declaration("replaceBookPageParagraphs");
  for (const explicit of [false, true]) {
    const inserts: any[] = [];
    const replace = new Function("normalizeParagraphMetadata", "listPageParagraphs", "listPageBookmarks", "listPageHighlights", "listPageNotes", "calculateParagraphReadingMetrics", "randomUUID", "matchParagraphsWithExplicitIds", "matchReplacementParagraphs", "invalidateBookAudioCache", "shiftSubsequentSequenceNumbers", "shiftSubsequentAnnotationSequenceNumbers", `${compiled}; return replaceBookPageParagraphs;`)(
      normalizeParagraphMetadata, async () => [{ ...metadata, paragraphId: "old", paragraphNumber: 1, sequenceNumber: 1, paragraphText: "text" }], async () => [], async () => [], async () => [],
      () => ({ characterCount: 4, wordCount: 1 }), () => "new", matchParagraphsWithExplicitIds, () => new Map(), async () => undefined, async () => undefined, async () => undefined
    );
    await replace({ execute: async (sql: string, binds: any) => {
      if (sql.includes("INSERT INTO book_paragraphs")) inserts.push(binds);
      return { rows: [] };
    } }, { bookId: "book", pageNumber: 1, page: { pageId: "page", sourceImageRotation: 0 }, editedText: "text", rawText: "text", htmlContent: null, ocrStatus: "READY", paragraphs: ["text"], paragraphIds: ["old"],
      ...(explicit ? { paragraphMetadata: [{ role: "heading", readAloud: true, geometry: null }] } : {}) });
    assert.equal(inserts[0].paragraphId, "old");
    assert.equal(inserts[0].elementRole, explicit ? "heading" : "footer");
    assert.equal(inserts[0].readAloud, explicit ? 1 : 0);
    assert.equal(inserts[0].geometryJson, explicit ? null : JSON.stringify(geometry));
  }
});

test("legacy row metadata is body/readtrue; labeled legacy rows never infer mute from role", async () => {
  const list = new Function("paragraphElementMetadataSchema", `${declaration("listPageParagraphs")}; return listPageParagraphs;`)(paragraphElementMetadataSchema);
  const rows = await list({ execute: async () => ({ rows: [{ paragraphId: "old" }, { paragraphId: "header", role: "header", readAloud: 1 }, { paragraphId: "muted", role: "body", readAloud: 0 }] }) }, "book", 1);
  assert.equal(rows[0].role, "body");
  assert.equal(rows[0].readAloud, true);
  assert.equal(rows[1].readAloud, true);
  assert.equal(rows[2].readAloud, false);
  assert.equal(rows[0].geometry, null);
});

test("source replacement/crop and rotation clear only geometry; timestamp concurrency preserves microseconds", () => {
  for (const path of ["image", "image-rotation"]) {
    const start = routes.indexOf(`  app.put("/:bookId/pages/:pageNumber/${path}",`);
    const end = routes.indexOf("\n  });", start);
    const route = routes.slice(start, end);
    assert.match(route, /UPDATE book_paragraphs SET geometry_json = NULL WHERE book_id = :bookId AND page_number = :pageNumber/u);
    assert.doesNotMatch(route, /element_role\s*=|read_aloud\s*=/u);
    assert.match(route, /FOR UPDATE/u);
  }
  assert.match(declaration("findBookPage"), /TO_CHAR\(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6'\)/u);
  assert.match(declaration("replaceBookPageParagraphs"), /options.sourceImageRotation !== options.page.sourceImageRotation \? null/u);
});

function pageSaveSetup(kind: "ocr" | "image" | "rerun-ocr", options: { changedDuringOcr?: boolean } = {}) {
  const calls: string[] = [];
  const initialVersion = "2026-10-02T12:00:00.000001";
  const savedVersion = "2026-10-02T12:00:00.000002";
  let updatedAt = initialVersion;
  const original = { image: "original bytes", text: "original text", geometry, snapshot: false };
  const state = structuredClone(original);
  let commits = 0;
  const connection = {
    async execute(sql: string) {
      calls.push(sql);
      if (/^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(sql)) {
        updatedAt = savedVersion;
        if (sql.includes("INSERT INTO book_files")) state.snapshot = true;
        if (sql.includes("UPDATE book_files")) state.image = "edited bytes";
        if (sql.includes("geometry_json = NULL")) state.geometry = null as any;
      }
      return { rows: sql.includes("FROM book_files") ? [{ contentBlob: Buffer.from("image"), mimeType: "image/png" }] : [] };
    },
    async commit() {
      commits++;
      calls.push("commit");
      // Simulate another editor acquiring the lock immediately after our commit.
      updatedAt = "2026-10-02T12:00:00.000003";
    },
    async rollback() { calls.push("rollback"); },
    async close() { calls.push("close"); }
  };
  const richPage = { editedText: "edited", htmlContent: "<p>edited</p>", rawText: "edited", paragraphs: ["edited"] };
  const dependencies = {
    z, load, parsePageStyle, visualPageDocumentSchema,
    pageParamsSchema: z.object({ bookId: z.string(), pageNumber: z.number() }),
    updateOcrPageSchema: z.object({ editedText: z.string().min(1), expectedUpdatedAt: z.string().min(1).max(100).optional() }),
    rerunOcrPageSchema: z.object({ expectedUpdatedAt: z.string().min(1).max(100).optional(), ocrMode: z.string().default("TEXTRACT") }),
    getConnection: async () => connection,
    findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es", title: "book" }),
    findBookPage: async () => {
      calls.push("findPage");
      assert.ok(calls.some((sql) => sql.includes("FROM books") && sql.includes("FOR UPDATE")));
      assert.ok(calls.some((sql) => sql.includes("FROM book_pages") && sql.includes("FOR UPDATE")));
      assert.ok(calls.findIndex((sql) => sql.includes("FROM books") && sql.includes("FOR UPDATE"))
        < calls.findIndex((sql) => sql.includes("FROM book_pages") && sql.includes("FOR UPDATE")));
      return { pageId: "page", sourceFileId: "source", sourceImageRotation: 0, htmlContent: "<p>original</p>", updatedAt };
    },
    ensureImageFiles: (files: unknown[]) => files,
    readUploadedFile: async (file: any) => {
      calls.push("readImage");
      // Multipart permits fields after the image. They become available on consumption.
      if (file.version !== undefined) file.fields.expectedUpdatedAt = { value: file.version };
      return Buffer.from("edited bytes");
    },
    maximumUploadedImageBytes: 10000,
    randomUUID: () => "snapshot",
    computeChecksum: () => "checksum",
    recordUserActivity: async () => { calls.push("activity"); },
    extractEmbeddedImageSources: () => { calls.push("extractImages"); return []; },
    buildRichPageFromEditableText: () => richPage,
    externalizeContentImages: (contents: string[]) => ({ contents, assets: [] }),
    insertContentImageAssets: async () => { calls.push("insertAssets"); },
    replaceBookPageParagraphs: async () => { calls.push("replaceParagraphs"); state.text = "edited"; updatedAt = savedVersion; },
    getUserAiCredentials: async () => ({}),
    getEffectiveUserAiCredentials: async () => ({}),
    collectBookOcrMarginHints: async () => ({ headers: [], footers: [] }),
    oracledb: { BUFFER: 1 },
    runOcrOnImage: async () => {
      calls.push("AWS");
      if (options.changedDuringOcr) updatedAt = "2026-10-02T12:00:00.000004";
      return richPage;
    }
  };
  const method = kind === "rerun-ocr" ? "post" : "put";
  const start = routes.indexOf(`  app.${method}("/:bookId/pages/:pageNumber/${kind}",`);
  const end = routes.indexOf("\n  });", start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  assert.ok(body);
  const handler = new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
  return { calls, state, original, initialVersion, savedVersion, call: async (expectedUpdatedAt?: string) => {
    const reply = { statusCode: 200, body: undefined as any,
      status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } };
    await handler({ currentUser: { userId: "editor" }, params: { bookId: "book", pageNumber: 1 },
      body: { editedText: "edited", ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }) },
      file: async () => ({ filename: "image.png", mimetype: "image/png", fields: {}, version: expectedUpdatedAt }) }, reply);
    return { ...reply, commits };
  } };
}

test("stale PUT OCR/image and rerun return 409 under book/page locks without any mutation", async () => {
  for (const kind of ["ocr", "image", "rerun-ocr"] as const) {
    const app = pageSaveSetup(kind);
    const result = await app.call("2026-10-02T12:00:00.000000");
    assert.equal(result.statusCode, 409, kind);
    assert.equal(result.commits, 0);
    assert.deepEqual(app.state, app.original);
    assert.ok(!app.calls.some((call) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(call)));
    for (const call of ["extractImages", "insertAssets", "replaceParagraphs", "activity", "AWS"]) assert.ok(!app.calls.includes(call), `${kind}: ${call}`);
  }
});

test("successful OCR/image saves return their own committed version for chaining; legacy calls remain accepted", async () => {
  for (const kind of ["ocr", "image", "rerun-ocr"] as const) {
    for (const legacy of [true, false]) {
      const app = pageSaveSetup(kind);
      const result = await app.call(legacy ? undefined : app.initialVersion);
      assert.equal(result.statusCode, 200, kind);
      assert.equal(result.commits, 1);
      assert.deepEqual(result.body, { updatedAt: app.savedVersion });
      assert.equal(app.calls.at(-3), "findPage");
      assert.equal(app.calls.at(-2), "commit");
    }
  }
});

test("rerun rechecks the recognized page version before assets and text persistence", async () => {
  const app = pageSaveSetup("rerun-ocr", { changedDuringOcr: true });
  const result = await app.call(app.initialVersion);
  assert.equal(result.statusCode, 409);
  assert.ok(app.calls.includes("AWS"));
  assert.ok(!app.calls.includes("insertAssets"));
  assert.ok(!app.calls.includes("replaceParagraphs"));
  assert.deepEqual(app.state, app.original);
});

test("empty version tokens are invalid, not silently treated as legacy omissions", async () => {
  for (const kind of ["ocr", "image"] as const) {
    const app = pageSaveSetup(kind);
    assert.equal((await app.call("")).statusCode, 400);
    assert.deepEqual(app.state, app.original);
    assert.ok(!app.calls.some((call) => /^\s*(?:INSERT|UPDATE|DELETE)\b/u.test(call)));
  }
});

test("book timestamps are sortable FF6Z across list, book and page GETs; page CAS token remains FF6 without Z", () => {
  for (const path of ["/", "/:bookId", "/:bookId/pages/:pageNumber"]) {
    const start = routes.indexOf(`  app.get("${path}",`);
    const end = routes.indexOf("\n  });", start);
    assert.match(routes.slice(start, end), /TO_CHAR\(b.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'\) AS "updatedAt"/u);
  }
  assert.match(declaration("findBookPage"), /TO_CHAR\(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6'\) AS "updatedAt"/u);
  for (const name of ["updateOcrPageSchema", "rerunOcrPageSchema"]) {
    const node = source.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === name));
    assert.ok(node);
    assert.match(node.getText(source), /expectedUpdatedAt: z.string\(\).min\(1\).max\(100\).optional\(\)/u);
  }
});
