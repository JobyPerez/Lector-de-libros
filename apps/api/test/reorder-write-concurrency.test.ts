import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

// Extract handlers without importing database/env initialization or reading .env.
const sources = Object.fromEntries(["annotations/annotations.routes", "progress/progress.routes", "books/books.routes"].map((file) =>
  [file.split("/")[0]!, readFileSync(new URL(`../src/modules/${file}.ts`, import.meta.url), "utf8")])) as Record<string, string>;
const accessSource = readFileSync(new URL("../src/services/book-access.ts", import.meta.url), "utf8");
function compile(code: string, dependencies: Record<string, unknown>) {
  return new Function(...Object.keys(dependencies), ts.transpile(code, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
function declaration(source: string, name: string) {
  const tree = ts.createSourceFile("source.ts", source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name
    : ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(tree) === name));
  assert.ok(node, name);
  return node.getText(tree).replace(/^export /u, "");
}
function handler(source: string, method: string, path: string, dependencies: Record<string, unknown>) {
  const start = source.indexOf(`  app.${method}("${path}",`);
  const end = source.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start, path);
  const body = source.slice(start, end).split("async (request, reply) => {")[1];
  return compile(`return async (request, reply) => {${body}\n};`, dependencies);
}
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  return { wait, release };
}
const response = () => ({ statusCode: 200, body: undefined as any,
  status(code: number) { this.statusCode = code; return this; }, send(body?: unknown) { this.body = body; return this; } });
const bookId = randomUUID(), userId = randomUUID(), paragraphId = randomUUID(), highlightId = randomUUID();
const progressSchema = compile(`${declaration(sources.progress!, "progressSchema")}; return progressSchema;`, { z });
const accessFunctions = compile(`${["ROLE_RANK", "roleAtLeast", "rowToRole", "resolveBookAccess", "assertBookRole"].map((name) => declaration(accessSource, name)).join("\n")}
  return { resolveBookAccess, assertBookRole };`, { getConnection: async () => { assert.fail("permission rechecks must reuse the transaction connection"); } });

function progressFixture(options: { total?: number; missing?: boolean; inactive?: boolean; failWrite?: boolean; lock?: ReturnType<typeof gate> } = {}) {
  const events: string[] = [];
  const paragraph = { paragraphId, pageNumber: 4, paragraphNumber: 2, sequenceNumber: 8 };
  let pending: any, saved: any;
  const connection = { execute: async (sql: string, binds: any, executionOptions?: any) => {
    if (sql.includes("FOR UPDATE")) { events.push("lock-wait"); await options.lock?.wait; events.push("locked"); return { rows: [{ totalPages: 5, totalParagraphs: options.total ?? 10 }] }; }
    if (sql.includes("FROM book_paragraphs")) {
      assert.ok(events.includes("locked")); events.push("resolve");
      assert.match(sql, /book_id = :bookId AND is_active = 1/);
      assert.match(sql, /:paragraphId IS NULL AND page_number = :pageNumber AND paragraph_number = :paragraphNumber AND sequence_number = :sequenceNumber/);
      assert.equal(binds.bookId, bookId);
      const matches = binds.paragraphId ? binds.paragraphId === paragraphId : binds.pageNumber === paragraph.pageNumber
        && binds.paragraphNumber === paragraph.paragraphNumber && binds.sequenceNumber === paragraph.sequenceNumber;
      return { rows: matches && !options.missing && !options.inactive && options.total !== 0 ? [structuredClone(paragraph)] : [] };
    }
    assert.match(sql, /MERGE INTO user_book_progress/);
    assert.ok(!executionOptions?.autoCommit, "book lock must survive through the progress commit");
    events.push("merge"); if (options.failWrite) throw new Error("write failed"); pending = binds;
    return { rowsAffected: 1 };
  }, commit: async () => { events.push("commit"); saved = pending; },
  rollback: async () => { events.push("rollback"); pending = undefined; }, close: async () => { events.push("close"); } };
  const put = handler(sources.progress!, "put", "/books/:bookId/progress", { z, progressSchema, randomUUID, getConnection: async () => connection });
  return { events, paragraph, get saved() { return saved; }, call: async (body: unknown) => {
    const reply = response(); await put({ params: { bookId }, currentUser: { userId }, body }, reply); return reply;
  } };
}

test("progress PUT resolves stable identity after a reorder lock wait and ignores stale numeric coordinates/percentage", async () => {
  const lock = gate(), fixture = progressFixture({ lock });
  const request = fixture.call({ paragraphId, currentPageNumber: 1, currentParagraphNumber: 1, currentSequenceNumber: 1, readingPercentage: 1, audioOffsetMs: 1234 });
  await Promise.resolve();
  assert.deepEqual(fixture.events, ["lock-wait"]);
  fixture.paragraph.pageNumber = 5; fixture.paragraph.sequenceNumber = 9;
  lock.release();
  assert.equal((await request).statusCode, 204);
  assert.deepEqual(fixture.events, ["lock-wait", "locked", "resolve", "merge", "commit", "close"]);
  assert.equal(fixture.saved.currentPageNumber, 5); assert.equal(fixture.saved.currentParagraphNumber, 2);
  assert.equal(fixture.saved.currentSequenceNumber, 9); assert.equal(fixture.saved.readingPercentage, 90);
  assert.equal(fixture.saved.audioOffsetMs, 1234);
});

test("progress accepts ID-only requests and valid shipped numeric tuples, but rejects inconsistent legacy coordinates", async () => {
  for (const body of [{ paragraphId }, { currentPageNumber: 4, currentParagraphNumber: 2, currentSequenceNumber: 8, readingPercentage: 3 }]) {
    const fixture = progressFixture(); assert.equal((await fixture.call(body)).statusCode, 204);
    assert.equal(fixture.saved.readingPercentage, 80);
  }
  for (const body of [{ currentPageNumber: 1, currentParagraphNumber: 2, currentSequenceNumber: 8 },
    { currentPageNumber: 4, currentParagraphNumber: 2, currentSequenceNumber: 2 }]) {
    const fixture = progressFixture();
    await assert.rejects(fixture.call(body), (error: any) => error.statusCode === 409 && error.code === "PROGRESS_LOCATION_CONFLICT");
    assert.equal(fixture.saved, undefined); assert.ok(!fixture.events.includes("merge")); assert.ok(fixture.events.includes("rollback"));
  }
});

test("progress rejects foreign, deleted and inactive stable IDs without falling back to valid numeric tuples", async () => {
  for (const options of [{}, { missing: true }, { inactive: true }]) {
    const fixture = progressFixture(options);
    await assert.rejects(fixture.call({ paragraphId: options.missing || options.inactive ? paragraphId : randomUUID(),
      currentPageNumber: 4, currentParagraphNumber: 2, currentSequenceNumber: 8 }),
    (error: any) => error.statusCode === 404 && error.code === "PROGRESS_PARAGRAPH_NOT_FOUND");
    assert.equal(fixture.saved, undefined); assert.ok(!fixture.events.includes("merge"));
  }
});

test("empty-book legacy placeholders are bounded and progress write failures roll back", async () => {
  const empty = progressFixture({ total: 0 });
  assert.equal((await empty.call({ currentPageNumber: 3, currentParagraphNumber: 1, currentSequenceNumber: 1 })).statusCode, 204);
  assert.equal(empty.saved.readingPercentage, 0);
  for (const currentPageNumber of [6, 99]) {
    const fixture = progressFixture({ total: 0 });
    await assert.rejects(fixture.call({ currentPageNumber, currentParagraphNumber: 1, currentSequenceNumber: 1 }), (error: any) => error.statusCode === 409);
  }
  const failure = progressFixture({ failWrite: true });
  await assert.rejects(failure.call({ paragraphId }), /write failed/);
  assert.equal(failure.saved, undefined); assert.deepEqual(failure.events.slice(-2), ["rollback", "close"]);
});

test("invalid progress payloads return 400 before acquiring a connection", async () => {
  for (const body of [{}, { paragraphId: "bad" }, { currentPageNumber: 1 }, { paragraphId, audioOffsetMs: -1 }]) {
    const fixture = progressFixture(); assert.equal((await fixture.call(body)).statusCode, 400); assert.deepEqual(fixture.events, []);
  }
});

const annotationSchemas = compile(`${["highlightColors", "sharedWithSchema", "createBookmarkSchema", "createHighlightSchema", "createNoteSchema"].map((name) => declaration(sources.annotations!, name)).join("\n")}
  return { createBookmarkSchema, createHighlightSchema, createNoteSchema };`, { z });
function annotationFixture(kind: "bookmarks" | "highlights" | "notes", options: { lock?: ReturnType<typeof gate>; failAudit?: boolean; highlight?: boolean } = {}) {
  const events: string[] = [];
  const location = { paragraphId, pageNumber: 1, paragraphNumber: 2, sequenceNumber: 2, paragraphText: "Annotation text" };
  let pending: any, saved: any;
  const connection = { execute: async (sql: string, binds: any, executionOptions?: any) => {
    if (sql.includes("FOR UPDATE")) { events.push("lock-wait"); await options.lock?.wait; events.push("locked"); return { rows: [{ bookId }] }; }
    assert.ok(events.includes("locked")); assert.ok(!executionOptions?.autoCommit);
    assert.match(sql, /INSERT INTO user_(?:bookmarks|highlights|notes)/);
    events.push("insert"); pending = binds; return { rowsAffected: 1 };
  }, commit: async () => { events.push("commit"); saved = pending; },
  rollback: async () => { events.push("rollback"); pending = undefined; }, close: async () => { events.push("close"); } };
  const dependencies = { ...annotationSchemas, randomUUID, bookParamsSchema: z.object({ bookId: z.string().uuid() }), getConnection: async () => connection,
    findAccessibleBook: async () => { assert.ok(events.includes("locked")); events.push("book"); return { totalPages: 10, title: "Book" }; },
    findParagraphLocation: async () => { assert.ok(events.includes("locked")); events.push("paragraph"); return structuredClone(location); },
    findOwnedHighlight: async () => { assert.ok(events.includes("locked")); events.push("highlight"); return { ...location, highlightId }; },
    listBookmarks: async () => [], recordUserActivity: async () => { assert.ok(events.includes("locked")); assert.ok(!events.includes("commit")); events.push("audit"); if (options.failAudit) throw new Error("audit failed"); } };
  const post = handler(sources.annotations!, "post", `/books/:bookId/${kind}`, dependencies);
  const body = kind === "bookmarks" ? { paragraphId } : kind === "highlights" ? { paragraphId, charStart: 0, charEnd: 3, color: "YELLOW", highlightedText: "Ann" }
    : { noteText: "Note", ...(options.highlight ? { highlightId } : { paragraphId }) };
  return { location, events, get saved() { return saved; }, call: async () => {
    const reply = response(); await post({ params: { bookId }, currentUser: { userId }, body }, reply); return reply;
  } };
}

for (const kind of ["bookmarks", "highlights", "notes"] as const) {
  test(`${kind} POST waits for book lock before resolving and commits post-reorder coordinates`, async () => {
    const lock = gate(), fixture = annotationFixture(kind, { lock });
    const request = fixture.call(); await Promise.resolve();
    assert.deepEqual(fixture.events, ["lock-wait"]);
    fixture.location.pageNumber = 7; fixture.location.sequenceNumber = 12; lock.release();
    assert.equal((await request).statusCode, 201);
    assert.equal(fixture.saved.pageNumber, 7); assert.equal(fixture.saved.sequenceNumber, 12); assert.equal(fixture.saved.paragraphId, paragraphId);
    assert.deepEqual(fixture.events, ["lock-wait", "locked", "book", "paragraph", "insert", "audit", "commit", "close"]);
  });
  test(`${kind} POST keeps creation and audit in one transaction with rollback`, async () => {
    const fixture = annotationFixture(kind, { failAudit: true });
    await assert.rejects(fixture.call(), /audit failed/); assert.equal(fixture.saved, undefined);
    assert.ok(!fixture.events.includes("commit")); assert.deepEqual(fixture.events.slice(-2), ["rollback", "close"]);
  });
}

test("highlight-backed note resolution waits for the book lock; sharing inserts never implicitly release it", async () => {
  const lock = gate(), fixture = annotationFixture("notes", { lock, highlight: true });
  const request = fixture.call(); await Promise.resolve();
  assert.deepEqual(fixture.events, ["lock-wait"]); fixture.location.pageNumber = 6; fixture.location.sequenceNumber = 20; lock.release();
  assert.equal((await request).statusCode, 201); assert.equal(fixture.saved.pageNumber, 6); assert.equal(fixture.saved.sequenceNumber, 20);
  assert.ok(fixture.events.includes("highlight"));
  const share = compile(`${declaration(sources.annotations!, "insertAnnotationShares")}; return insertAnnotationShares;`, {});
  let inserts = 0;
  await share({ execute: async () => ({ rows: [{ userId: "recipient" }] }), executeMany: async (_sql: string, _binds: any, options: any) => {
    inserts++; assert.ok(!options?.autoCommit);
  } }, "note", "note", bookId, ["recipient"]);
  assert.equal(inserts, 1);
});

function ocrFixture(options: { revokeAt?: "lock" | "provider" | "commit"; lock?: ReturnType<typeof gate> } = {}) {
  const events: string[] = [];
  let role = "editor", checks = 0, committed = false;
  const page = { pageId: randomUUID(), sourceFileId: randomUUID(), updatedAt: "v1", sourceImageRotation: 0 };
  const connection = { execute: async (sql: string) => {
    if (sql.includes("FROM books") && sql.includes("FOR UPDATE")) { events.push("lock-wait"); await options.lock?.wait; events.push("locked"); if (options.revokeAt === "lock") role = "viewer"; return { rows: [{ bookId }] }; }
    if (sql.includes('AS "shareRole"')) { assert.ok(events.includes("locked")); checks++; events.push("permission"); return { rows: [{ ownerUserId: "owner", shareRole: role, shareUserAnnotations: "N" }] }; }
    if (sql.includes("FROM book_files")) return { rows: [{ contentBlob: Buffer.from("image"), mimeType: "image/png" }] };
    if (/^\s*(INSERT|UPDATE|DELETE)/u.test(sql)) events.push("write");
    return { rows: [] };
  }, commit: async () => { committed = true; events.push("commit"); }, rollback: async () => { events.push("rollback"); }, close: async () => { events.push("close"); } };
  const dependencies = { assertBookRole: accessFunctions.assertBookRole,
    pageParamsSchema: z.object({ bookId: z.string().uuid(), pageNumber: z.number() }), rerunOcrPageSchema: z.object({ advancedLayout: z.boolean().default(false) }),
    getConnection: async () => connection, findAccessibleBook: async () => ({ sourceType: "IMAGES", languageCode: "es", title: "Book" }),
    findBookPage: async () => { events.push("page"); return structuredClone(page); }, resolveGalleryPage: async () => { assert.ok(events.includes("locked")); },
    getEffectiveUserAiCredentials: async () => ({}), getSharedOcrModelViolation: () => null, getSharedSummaryModelViolation: () => null, collectBookOcrMarginHints: async () => ({}), oracledb: { BUFFER: 1 },
    runOcrOnImage: async () => { events.push("provider"); if (options.revokeAt === "provider") role = "viewer";
      return { editedText: "OCR", htmlContent: "<p>OCR</p>", rawText: "OCR", paragraphs: ["OCR"] }; },
    externalizeContentImages: (contents: string[]) => ({ contents, assets: [] }),
    insertContentImageAssets: async () => { events.push("assets"); }, replaceBookPageParagraphs: async () => { events.push("replace"); page.updatedAt = "v2"; },
    recordUserActivity: async () => { events.push("audit"); if (options.revokeAt === "commit") role = "viewer"; }
  };
  const rerun = handler(sources.books!, "post", "/:bookId/pages/:pageNumber/rerun-ocr", dependencies);
  const tree = ts.createSourceFile("books.ts", sources.books!, ts.ScriptTarget.Latest, true);
  let workerNode: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "registerGalleryOcrJobs") {
      const object = node.arguments[1]; assert.ok(object && ts.isObjectLiteralExpression(object));
      const property = object.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText(tree) === "runPage") as ts.PropertyAssignment;
      workerNode = property.initializer;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree); assert.ok(workerNode);
  const worker = compile(`return ${workerNode.getText(tree)};`, { rerunOcrHandler: rerun, app: {} });
  return { events, get checks() { return checks; }, get committed() { return committed; },
    call: async (useWorker = false) => {
      if (useWorker) return worker(bookId, userId, { pageId: page.pageId, expectedUpdatedAt: "v1" }, {});
      return rerun({ params: { bookId, pageNumber: 1 }, currentUser: { userId }, body: {} }, response());
    } };
}

for (const worker of [false, true]) {
  const label = worker ? "selection worker" : "single-page handler";
  test(`${label} rejects EDITOR loss during lock wait before reading the page or paying OCR`, async () => {
    const lock = gate(), fixture = ocrFixture({ revokeAt: "lock", lock });
    const request = fixture.call(worker); await Promise.resolve(); await Promise.resolve();
    assert.deepEqual(fixture.events, ["lock-wait"]); lock.release();
    await assert.rejects(request, (error: any) => error.statusCode === 403);
    assert.ok(!fixture.events.includes("provider")); assert.ok(!fixture.events.includes("page")); assert.equal(fixture.committed, false);
    assert.deepEqual(fixture.events.slice(-2), ["rollback", "close"]);
  });
  test(`${label} rechecks EDITOR after provider completion and rejects before OCR output writes`, async () => {
    const fixture = ocrFixture({ revokeAt: "provider" });
    await assert.rejects(fixture.call(worker), (error: any) => error.statusCode === 403);
    assert.equal(fixture.checks, 2); assert.ok(fixture.events.includes("provider")); assert.ok(!fixture.events.includes("assets"));
    assert.ok(!fixture.events.includes("replace")); assert.equal(fixture.committed, false);
  });
  test(`${label} rolls back if EDITOR is revoked before commit and otherwise checks three times`, async () => {
    const revoked = ocrFixture({ revokeAt: "commit" });
    await assert.rejects(revoked.call(worker), (error: any) => error.statusCode === 403);
    assert.equal(revoked.checks, 3); assert.ok(revoked.events.includes("replace")); assert.equal(revoked.committed, false);
    const allowed = ocrFixture(); await allowed.call(worker); assert.equal(allowed.checks, 3); assert.equal(allowed.committed, true);
    assert.deepEqual(allowed.events.slice(-3), ["permission", "commit", "close"]);
  });
}

test("permission rechecks use current book-scoped roles on the supplied connection without closing it", async () => {
  for (const role of ["owner", "editor", "commenter", "viewer", null]) {
    const connection = { execute: async (sql: string, binds: any) => {
      assert.match(sql, /s.book_id = b.book_id\s+AND s.user_id = :userId/); assert.deepEqual(binds, { bookId, userId });
      return { rows: [{ ownerUserId: role === "owner" ? userId : "owner", shareRole: role === "owner" ? null : role, shareUserAnnotations: "N" }] };
    }, close: async () => { assert.fail("must not close caller transaction"); } };
    if (role === "owner" || role === "editor") await accessFunctions.assertBookRole(connection, bookId, userId, "EDITOR");
    else await assert.rejects(accessFunctions.assertBookRole(connection, bookId, userId, "EDITOR"), (error: any) => error.statusCode === (role ? 403 : 404));
  }
});
