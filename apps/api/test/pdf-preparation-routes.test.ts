import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";
import { inferPdfElement, matchPdfBlock } from "../src/modules/books/pdf-page-preparation.js";
import { buildVisualDocumentFromPage, visualPageDocumentSchema } from "../src/modules/books/visual-document.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const start = routes.indexOf('  app.post("/:bookId/pages/:pageNumber/prepare-pdf",');
const end = routes.indexOf("\n  });", start);
assert.ok(start >= 0 && end > start);
const body = routes.slice(start, end).split("async (request, reply) => {")[1];
const compiled = ts.transpile(`return async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 });

function fixture(options: { stale?: boolean; revoked?: boolean; editorial?: boolean; fail?: boolean } = {}) {
  const bookId = randomUUID(), pageId = randomUUID(), paragraphId = randomUUID(), fileId = randomUUID();
  const paragraph = { paragraphId, paragraphNumber: 1, paragraphText: "Existing editorial text stays unchanged", role: "body" as const, readAloud: true, active: true, geometry: null, includeInToc: null };
  const page = { pageId, pageNumber: 9, updatedAt: "revision-1", htmlContent: '<p data-paragraph-number="1">Existing editorial text stays unchanged</p>', rawText: paragraph.paragraphText,
    editedText: paragraph.paragraphText, sourceHtmlContent: "original-adaptable-snapshot", visualDocumentJson: options.editorial ? JSON.stringify(buildVisualDocumentFromPage(null, [paragraph])) : null };
  const calls: { sql: string; binds?: any }[] = [];
  let checks = 0;
  const connection = { execute: async (sql: string, binds?: any) => { calls.push({ sql, binds }); return { rows: [] }; },
    commit: async () => { calls.push({ sql: "COMMIT" }); }, rollback: async () => { calls.push({ sql: "ROLLBACK" }); }, close: async () => { calls.push({ sql: "CLOSE" }); } };
  const dependencies = {
    z, pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.coerce.number().int().positive() }),
    getConnection: async () => connection,
    assertBookRole: async () => { if (++checks === 2 && options.revoked) throw Object.assign(new Error("Role revoked"), { statusCode: 403 }); },
    resolveGalleryPage: async (_connection: unknown, params: { pageNumber: number }) => { params.pageNumber = 9; },
    findBookPage: async (_connection: unknown, _book: unknown, number: number) => { assert.equal(number, 9); return page; },
    findPdfPageSource: async (_connection: unknown, _book: unknown, number: number, id: string) => { assert.equal(number, 9); assert.equal(id, pageId); return { fileId }; },
    analyzePdfPageSource: async () => {
      if (options.fail) throw new Error("PDF decoding failed");
      return { number: 21, blocks: [{ text: paragraph.paragraphText, role: "footer", geometry: { bbox: { left: 0.1, top: 0.95, width: 0.7, height: 0.02 } } }], images: [] };
    },
    listPageParagraphs: async () => [paragraph], inferPdfElement, matchPdfBlock, visualPageDocumentSchema, buildVisualDocumentFromPage,
    invalidateBookAudioCache: async () => { calls.push({ sql: "invalidate-audio" }); }, recordUserActivity: async () => { calls.push({ sql: "audit" }); }
  };
  const handler = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
  const reply = { statusCode: 200, body: null as any, status(code: number) { this.statusCode = code; return this; }, send(value: unknown) { this.body = value; return this; } };
  return { calls, page, paragraph, fileId, reply, get checks() { return checks; }, run: () => handler({ currentUser: { userId: "editor" }, params: { bookId, pageNumber: 2 }, query: { pageId },
    body: { expectedUpdatedAt: options.stale ? "stale" : page.updatedAt } }, reply) };
}

test("PDF preparation resolves stable identity, preserves text/IDs/source snapshot and atomically saves zones and physical mapping", async () => {
  const context = fixture();
  await context.run();
  assert.equal(context.reply.statusCode, 200);
  assert.equal(context.reply.body.sourcePdfPageNumber, 21);
  assert.equal(context.reply.body.preparedElements, 1);
  assert.equal(context.checks, 2);
  const update = context.calls.find(({ sql }) => /UPDATE book_paragraphs/u.test(sql))!;
  assert.equal(update.binds.paragraphId, context.paragraph.paragraphId);
  assert.equal(update.binds.elementRole, "footer"); assert.equal(update.binds.readAloud, 0);
  assert.ok(context.calls.some(({ binds }) => binds?.sheet === 21 && binds?.fileId === context.fileId));
  for (const { sql } of context.calls) assert.doesNotMatch(sql, /DELETE|SET\s+(?:paragraph_text|raw_text|edited_text|html_content|source_html_content)/iu);
  assert.deepEqual(context.calls.slice(-2).map(({ sql }) => sql), ["COMMIT", "CLOSE"]);
});

test("existing visual editorial documents keep their role/narration flags while missing geometry is filled", async () => {
  const context = fixture({ editorial: true });
  const old = JSON.parse(context.page.visualDocumentJson!);
  await context.run();
  const updated = context.calls.find(({ binds }) => binds?.document);
  const document = JSON.parse(updated!.binds.document);
  assert.equal(document.blocks[0].id, old.blocks[0].id);
  assert.equal(document.blocks[0].text, old.blocks[0].text);
  assert.equal(document.blocks[0].role, old.blocks[0].role);
  assert.equal(document.blocks[0].readAloud, old.blocks[0].readAloud);
  assert.ok(document.blocks[0].geometry);
  assert.ok(!context.calls.some(({ sql }) => sql === "invalidate-audio"));
});

test("stale, failed and revoked preparations never commit; stale requests do not perform detection", async () => {
  const stale = fixture({ stale: true }); await stale.run();
  assert.equal(stale.reply.statusCode, 409);
  assert.ok(stale.calls.every(({ sql }) => !/^\s*(?:UPDATE|COMMIT)/u.test(sql)));
  for (const option of [{ revoked: true }, { fail: true }]) {
    const context = fixture(option); await assert.rejects(context.run());
    assert.ok(context.calls.some(({ sql }) => sql === "ROLLBACK"));
    assert.ok(!context.calls.some(({ sql }) => sql === "COMMIT"));
  }
  assert.match(routes.slice(start, end), /requireBookRole\("EDITOR"\)/);
});

test("historical PDF HTML numbering drift binds an image to its exact stored narration ID without inventing a duplicate", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const paragraphs = ["First half of the body.", "Second half of the body.", "Imagen. Garden photo"].map((paragraphText, index) => ({
    paragraphId: ids[index]!, paragraphNumber: index + 1, paragraphText, role: "body" as const, readAloud: true, geometry: null
  }));
  const html = '<p data-paragraph-number="1">First half of the body. Second half of the body.</p><figure data-paragraph-number="2" data-reader-text="Imagen. Garden photo"><img src="https://example.com/garden.png" alt="Garden photo"><figcaption>Garden photo</figcaption></figure>';
  const document = buildVisualDocumentFromPage(html, paragraphs);
  assert.equal(document.blocks.length, 3);
  assert.equal(document.blocks[2]!.kind, "image");
  assert.equal(document.blocks[2]!.id, ids[2]);
  assert.equal(document.blocks[2]!.source, "https://example.com/garden.png");
  assert.deepEqual(document.blocks.slice(0, 2).map((block) => block.text), paragraphs.slice(0, 2).map((paragraph) => paragraph.paragraphText));
});
