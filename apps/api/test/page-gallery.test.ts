import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { listGalleryPages, pageOrderSchema, remapPageLinks, remapVisualPageLinks, reorderGalleryPages, resolveGalleryPage, validatePageOrder } from "../src/modules/books/page-gallery.js";

const bookId = randomUUID();
const ids = [randomUUID(), randomUUID(), randomUUID()];
const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
function handler(method: string, path: string, dependencies: Record<string, unknown>) {
  const start = routes.indexOf(`  app.${method}("${path}",`);
  const end = routes.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  return new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
const response = () => ({ statusCode: 200, body: undefined as any,
  status(code: number) { this.statusCode = code; return this; }, send(body: unknown) { this.body = body; return this; } });

test("complete stable-ID permutations only, with optimistic order conflicts including added/deleted pages", () => {
  validatePageOrder(ids, ids, [...ids].reverse());
  for (const expected of [[...ids].reverse(), ids.slice(1), [...ids, randomUUID()]]) {
    assert.throws(() => validatePageOrder(ids, expected, ids), (error: any) => error.statusCode === 409 && error.code === "PAGE_ORDER_CONFLICT");
  }
  for (const requested of [ids.slice(1), [ids[0]!, ids[0]!, ids[2]!], [ids[0]!, ids[1]!, randomUUID()]]) {
    assert.throws(() => validatePageOrder(ids, ids, requested), (error: any) => error.statusCode === 400);
  }
  assert.equal(pageOrderSchema.safeParse({ expectedPageIds: ids, pageIds: ids, extra: true }).success, false);
  validatePageOrder([], [], []);
});

test("internal HTML/markdown and visual JSON links move once, external URLs and anchors are untouched", () => {
  const mapping = new Map([[1, 3], [2, 1], [3, 2]]);
  const content = '<a data-lector-page="1" href="?page=1&amp;paragraph=7#anchor">One</a> [Two](reader-page-2-paragraph-8) <a href="https://example.org/?page=1">External</a>';
  const remapped = remapPageLinks(content, mapping)!;
  assert.match(remapped, /data-lector-page="3" href="\?page=3&amp;paragraph=7#anchor"/);
  assert.match(remapped, /reader-page-1-paragraph-8/);
  assert.match(remapped, /https:\/\/example.org\/\?page=1/);
  const visual = { blocks: [{ id: "stable", text: content }], layout: { id: "unchanged" } };
  assert.deepEqual(JSON.parse(remapVisualPageLinks(JSON.stringify(visual), mapping)!), { ...visual, blocks: [{ id: "stable", text: remapped }] });
  assert.equal(remapPageLinks(null, mapping), null);
});

test("gallery is lightweight, stable, read-only for viewers, with content previews for PDF/EPUB", async () => {
  let sql = "";
  const connection = { execute: async (query: string) => { sql = query; return { rows: [
    { pageId: ids[0], position: 1, sourceType: "PDF", updatedAt: "v1", previewText: "PDF content", paragraphCount: 2 },
    { pageId: ids[1], position: 2, sourceType: "EPUB", updatedAt: "v2", previewText: "EPUB content", paragraphCount: 3 },
    { pageId: ids[2], position: 3, sourceType: "IMAGES", sourceMimeType: "image/png", sourceFileId: "image", updatedAt: "v3", paragraphCount: 1 }
  ] }; } } as any;
  const gallery = await listGalleryPages(connection, bookId, false);
  assert.deepEqual(gallery.pageIds, ids);
  assert.ok(gallery.pages.every((page) => !page.capabilities.edit && !page.capabilities.ocr));
  assert.deepEqual(gallery.pages.map((page) => page.preview.kind), ["CONTENT", "CONTENT", "IMAGE"]);
  assert.match(gallery.pages[0]!.preview.contentUrl, new RegExp(`pageId=${ids[0]}`));
  assert.match(gallery.pages[2]!.preview.imageUrl!, new RegExp(`pageId=${ids[2]}`));
  assert.match(gallery.pages[2]!.preview.imageUrl!, /&thumbnail=true$/);
  assert.equal((await listGalleryPages(connection, bookId, true)).pages[2]!.capabilities.ocr, true);
  assert.match(sql, /DBMS_LOB.SUBSTR/);
  assert.match(sql, /bp.is_active = 1/);
  assert.ok(!sql.includes("content_blob"));
});

test("stable-ID targeting resolves the current position inside the book, never falls back for missing IDs", async () => {
  const params = { bookId, pageNumber: 1 };
  const statements: any[] = [];
  const connection = { execute: async (sql: string, binds: any) => { statements.push({ sql, binds }); return { rows: [{ pageNumber: 9 }] }; } } as any;
  await resolveGalleryPage(connection, params, { pageId: ids[0] });
  assert.equal(params.pageNumber, 9);
  assert.deepEqual(statements[0].binds, { bookId, pageId: ids[0] });
  assert.match(statements[0].sql, /book_id = :bookId AND page_id = :pageId/);
  await assert.rejects(resolveGalleryPage({ execute: async () => ({ rows: [] }) } as any, params, { pageId: ids[0] }), (error: any) => error.statusCode === 404);
  await assert.rejects(resolveGalleryPage(connection, params, { pageId: "bad" }));
});

test("reorder stages unique positions/sequences, retains IDs and remaps all dependent references", async () => {
  const calls: { sql: string; binds: any }[] = [];
  const pages = ids.map((pageId, index) => ({ pageId, pageNumber: index + 1,
    htmlContent: '<a href="?page=1&paragraph=1" data-lector-page="1">Link</a>', editedText: "[Link](reader-page-1-paragraph-1)",
    sourceHtmlContent: null, rawText: "text", visualDocumentJson: null }));
  const paragraphs = [
    { paragraphId: "a", pageId: ids[0], pageNumber: 1, paragraphNumber: 1, sequenceNumber: 1, paragraphText: "A" },
    { paragraphId: "b", pageId: ids[0], pageNumber: 1, paragraphNumber: 2, sequenceNumber: 2, paragraphText: "B" },
    { paragraphId: "c", pageId: ids[2], pageNumber: 3, paragraphNumber: 1, sequenceNumber: 3, paragraphText: "C" }
  ];
  const connection = { execute: async (sql: string, binds: any) => {
    calls.push({ sql, binds });
    return { rows: sql.includes("FROM book_pages WHERE") ? pages : sql.includes('paragraph_text AS "paragraphText"') ? paragraphs : [] };
  } } as any;
  await reorderGalleryPages(connection, bookId, ids, [ids[2]!, ids[1]!, ids[0]!]);
  const writes = calls.filter((call) => call.sql.startsWith("UPDATE"));
  assert.ok(!calls.some((call) => /DELETE FROM book_(?:pages|paragraphs)|INSERT INTO book_(?:pages|paragraphs)/.test(call.sql)));
  const updated = writes.filter((call) => call.sql.includes("paragraph_text = :paragraphText"));
  assert.deepEqual(updated.map((call) => [call.binds.paragraphId, call.binds.pageNumber, call.binds.sequenceNumber]), [["c", 1, 1], ["a", 3, 2], ["b", 3, 3]]);
  const updatedPages = writes.filter((call) => call.sql.includes("html_content = :htmlContent"));
  assert.deepEqual(updatedPages.map((call) => [call.binds.pageId, call.binds.pageNumber]), [[ids[0], 3], [ids[1], 2], [ids[2], 1]]);
  for (const table of ["book_pages", "book_paragraphs", "book_files", "user_bookmarks", "user_highlights", "user_notes", "book_chapters"]) {
    const stage = writes.findIndex((call) => call.sql.startsWith(`UPDATE ${table} SET page_number = page_number + :offset`));
    assert.ok(stage >= 0, table);
    assert.ok(writes[stage]!.binds.offset > 3);
  }
  assert.ok(writes.some((call) => /UPDATE user_book_progress progress SET current_sequence_number = COALESCE/.test(call.sql)));
  assert.ok(writes.some((call) => /reading_percentage = CASE/.test(call.sql)));
  assert.ok(writes.some((call) => /UPDATE user_book_ai_requests SET is_stale = 1/.test(call.sql)));
  assert.ok(writes.some((call) => /UPDATE user_book_section_summaries SET is_stale = 1/.test(call.sql)));
  assert.ok(!writes.some((call) => call.sql.includes("audio_offset_ms")), "reorder preserves audio offsets and paragraph audio caches");
});

test("no-op/stale order does not write any content", async () => {
  for (const stale of [false, true]) {
    let writes = 0;
    const connection = { execute: async (sql: string) => { if (sql.startsWith("UPDATE")) writes++; return { rows: ids.map((pageId, index) => ({ pageId, pageNumber: index + 1 })) }; } } as any;
    if (stale) await assert.rejects(reorderGalleryPages(connection, bookId, [...ids].reverse(), ids), (error: any) => error.statusCode === 409);
    else await reorderGalleryPages(connection, bookId, ids, ids);
    assert.equal(writes, 0);
  }
});

test("order endpoint locks before reorder, commits once, and rolls back failures", async () => {
  assert.match(routes, /app\.put\("\/:bookId\/pages\/order", \{ preHandler: \[authenticateRequest, requireBookRole\("EDITOR"\)\]/);
  assert.match(routes, /app\.get\("\/:bookId\/pages", \{ preHandler: \[authenticateRequest, requireBookRole\("VIEWER"\)\]/);
  for (const fail of [false, true]) {
    const calls: string[] = [];
    const connection = { execute: async (sql: string) => { assert.match(sql, /FOR UPDATE/); calls.push("lock"); },
      commit: async () => { calls.push("commit"); }, rollback: async () => { calls.push("rollback"); }, close: async () => { calls.push("close"); } };
    const run = handler("put", "/:bookId/pages/order", {
      bookParamsSchema: z.object({ bookId: z.string().uuid() }), pageOrderSchema, getConnection: async () => connection,
      reorderGalleryPages: async () => { calls.push("reorder"); if (fail) throw new Error("database failure"); },
      listGalleryPages: async () => { calls.push("gallery"); return { pageIds: ids }; }
    });
    const reply = response();
    const request = { params: { bookId }, body: { expectedPageIds: ids, pageIds: [...ids].reverse() } };
    if (fail) await assert.rejects(run(request, reply), /database failure/);
    else await run(request, reply);
    assert.deepEqual(calls, fail ? ["lock", "reorder", "rollback", "close"] : ["lock", "reorder", "gallery", "commit", "close"]);
  }
});

test("gallery deletion resolves stable ID after book lock and before destructive writes", async () => {
  const run = handler("delete", "/:bookId/pages/:pageNumber", {
    pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.number() }),
    getConnection: async () => ({ execute: async (sql: string) => { assert.match(sql, /FOR UPDATE/); return { rows: [] }; }, rollback: async () => {}, close: async () => {} }),
    findAccessibleBook: async () => ({ sourceType: "EPUB" }),
    resolveGalleryPage: async (_connection: any, params: any, query: any) => { assert.equal(query.pageId, ids[0]); params.pageNumber = 8; },
    findBookPage: async (_connection: any, _bookId: any, pageNumber: number) => { assert.equal(pageNumber, 8); return null; }
  });
  const reply = response();
  await run({ currentUser: { userId: "user" }, params: { bookId, pageNumber: 1 }, query: { pageId: ids[0] } }, reply);
  assert.equal(reply.statusCode, 404);
});

test("OCR edit and rerun use stable IDs under locks before checking page versions or calling providers", async () => {
  for (const mode of ["ocr", "rerun-ocr"] as const) {
    const calls: string[] = [];
    const run = handler(mode === "ocr" ? "put" : "post", `/:bookId/pages/:pageNumber/${mode}`, {
      assertBookRole: async () => {},
      pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.number() }),
      updateOcrPageSchema: z.object({ editedText: z.string() }), rerunOcrPageSchema: z.object({}),
      getConnection: async () => ({ execute: async (sql: string) => { assert.match(sql, /FOR UPDATE/); calls.push("lock"); return { rows: [] }; }, rollback: async () => {}, close: async () => {} }),
      findAccessibleBook: async () => ({ sourceType: "IMAGES" }),
      resolveGalleryPage: async (_connection: any, params: any) => { calls.push("resolve"); params.pageNumber = 7; },
      findBookPage: async (_connection: any, _book: any, position: number) => { assert.equal(position, 7); calls.push("find"); return null; }
    });
    const reply = response();
    await run({ currentUser: { userId: "user" }, params: { bookId, pageNumber: 1 }, query: { pageId: ids[0] }, body: { editedText: "test" } }, reply);
    assert.equal(reply.statusCode, 404);
    assert.deepEqual(calls, ["lock", "resolve", "lock", "find"]);
  }
});
