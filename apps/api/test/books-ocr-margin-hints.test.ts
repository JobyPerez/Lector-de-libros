import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { geometrySchema } from "../src/modules/books/page-elements.js";
import type { StoredOcrMarginCandidate, inferRepeatedOcrMarginHints } from "../src/modules/books/books.routes.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node);
  return ts.transpile(node.getText(source).replace(/^export /u, ""), { target: ts.ScriptTarget.ES2022 });
}
const infer: typeof inferRepeatedOcrMarginHints = new Function("geometrySchema",
  `${declaration("inferRepeatedOcrMarginHints")}; return inferRepeatedOcrMarginHints;`)(geometrySchema);
const collect = new Function("inferRepeatedOcrMarginHints",
  `${declaration("collectBookOcrMarginHints")}; return collectBookOcrMarginHints;`)(infer);
const geometry = JSON.stringify({ bbox: { left: 0.35, top: 0.07, width: 0.3, height: 0.02 } });
const row = (pageNumber: number, paragraphText = "Lara Vil\u00e1n", geometryJson: string | null = geometry): StoredOcrMarginCandidate =>
  ({ pageNumber, paragraphText, geometryJson });

test("headers require two distinct OTHER pages, exact accentless repetition and no author-name guessing", () => {
  const rows = [row(66), row(94, "LARA VILAN"), row(67, "Laura Vilan"), row(66, "Laura Vilan")];
  assert.deepEqual(infer(rows, 67, "Ef\u00edmera"), { headers: ["Lara Vil\u00e1n"], footers: ["Ef\u00edmera"] });
  assert.deepEqual(infer([row(66), row(66), row(67)], 67, "Efimera").headers, []);
  assert.deepEqual(infer([row(66, "Laura Vilan"), row(94)], 67, "Efimera").headers, []);
  assert.deepEqual(infer([row(66), row(94)], 67, "Efimera").headers, ["Lara Vil\u00e1n"]);
});

test("only isolated short lines with valid thin normalized top geometry qualify", () => {
  for (const text of ["", "x".repeat(121), "Lara\nVilan", "Lara\rVilan"])
    assert.deepEqual(infer([row(66, text), row(94, text)], 67, "Efimera").headers, []);
  const invalid = [null, "{bad json", "null", "{}", JSON.stringify({ bbox: { left: 0, top: 0.07, width: 0, height: 0.02 } }),
    JSON.stringify({ bbox: { left: 0.9, top: 0.07, width: 0.3, height: 0.02 } }),
    JSON.stringify({ bbox: { left: 0, top: 0.121, width: 0.3, height: 0.01 } }),
    JSON.stringify({ bbox: { left: 0, top: 0.12, width: 0.3, height: 0.035 } }),
    JSON.stringify({ bbox: { left: 0, top: 0.07, width: 0.3, height: 0.036 } }),
    JSON.stringify({ bbox: { left: 0, top: 0.85, width: 0.3, height: 0.02 } })];
  for (const box of invalid) assert.deepEqual(infer([row(66, "invalid", box), row(94, "invalid", box)], 67, "Efimera").headers, []);
  assert.deepEqual(infer([row(65, "invalid", "bad"), row(66), row(94)], 67, "Efimera").headers, ["Lara Vil\u00e1n"]);
  assert.deepEqual(infer([row(66, "x", JSON.stringify({ bbox: { left: 0, top: 0.115, width: 0.3, height: 0.035 } })),
    row(94, "x", JSON.stringify({ bbox: { left: 0, top: 0.115, width: 0.3, height: 0.035 } }))], 67, "Efimera").headers, ["x"]);
});

test("chapter headings are protected regardless of repetition and metadata role", () => {
  for (const text of ["CAP\u00cdTULO 1", "Pr\u00f3logo", "Ep\u00edlogo", "Primera parte", "Introducci\u00f3n", "Prefacio", "Ap\u00e9ndice", "Anexo", "Chapter 2"]) {
    const rows = [row(66, text), row(94, text)];
    assert.deepEqual(infer(rows, 67, "Efimera").headers, [], text);
  }
  for (const role of ["body", "heading", "header", "footer", "imageCaption", "pageNumber", "image"]) {
    const rows = [66, 94].map((pageNumber) => ({ ...row(pageNumber), role }));
    assert.deepEqual(infer(rows, 67, "Efimera").headers, ["Lara Vil\u00e1n"]);
  }
});

test("footer hints contain only the exact short book title; inference is read-only", () => {
  const rows = Object.freeze([Object.freeze(row(66)), Object.freeze(row(94))]);
  assert.deepEqual(infer(rows, 67, "  Ef\u00edmera  ").footers, ["Ef\u00edmera"]);
  for (const title of ["", "x".repeat(121), "Title\nSubtitle"])
    assert.deepEqual(infer(rows, 67, title).footers, []);
  assert.deepEqual(infer([], 67, "x".repeat(120)), { headers: [], footers: ["x".repeat(120)] });
});

test("collector is a bounded read scoped to the same book and other pages, without role filters or body logging", async () => {
  let calls = 0;
  const connection = { execute: async (sql: string, binds: unknown) => {
    calls++;
    assert.match(sql, /WHERE book_id = :bookId/u);
    assert.match(sql, /page_number <> :pageNumber/u);
    assert.match(sql, /DBMS_LOB.GETLENGTH\(paragraph_text\) <= 120/u);
    assert.match(sql, /FETCH FIRST 1500 ROWS ONLY/u);
    assert.doesNotMatch(sql, /element_role|UPDATE|INSERT|DELETE/u);
    assert.deepEqual(binds, { bookId: "existing-book", pageNumber: 67 });
    return { rows: [row(66), row(94), row(70, "bad", "{invalid")] };
  } };
  assert.deepEqual(await collect(connection, "existing-book", 67, "Ef\u00edmera"),
    { headers: ["Lara Vil\u00e1n"], footers: ["Ef\u00edmera"] });
  assert.equal(calls, 1);
  assert.doesNotMatch(declaration("collectBookOcrMarginHints"), /console|logger/u);
});

function setup(options: { stale?: boolean; concurrent?: boolean; inaccessible?: boolean; sourceType?: string } = {}) {
  const events: string[] = [];
  let reads = 0;
  let paidCalls = 0;
  let replacement: any;
  const connection = { execute: async (sql: string) => {
    if (sql.includes("FOR UPDATE")) events.push(sql.includes("FROM books") ? "book-lock" : "page-lock");
    if (sql.includes("FROM book_files")) return { rows: [{ contentBlob: Buffer.from("stored-image"), fileName: "page.png", mimeType: "image/png" }] };
    if (sql.includes("FROM book_paragraphs")) { events.push("hints"); return { rows: [row(66), row(94)] }; }
    return { rows: [] };
  }, commit: async () => { events.push("commit"); }, rollback: async () => { events.push("rollback"); }, close: async () => {} };
  const dependencies = {
    assertBookRole: async () => {},
    pageParamsSchema: { parse: (value: unknown) => value }, rerunOcrPageSchema: { parse: (value: unknown) => value },
    getConnection: async () => connection,
    findAccessibleBook: async () => options.inaccessible ? null : ({ sourceType: options.sourceType ?? "IMAGES", title: "Ef\u00edmera", authorName: "Laura Vil\u00e1n", languageCode: "es" }),
    findBookPage: async () => ({ sourceFileId: "image", sourceImageRotation: 90, updatedAt: ++reads > 1 && options.concurrent ? "changed" : "original" }),
    oracledb: { BUFFER: 1 }, collectBookOcrMarginHints: collect,
    getEffectiveUserAiCredentials: async (userId: string, db: unknown) => {
      assert.equal(userId, "editor"); assert.equal(db, connection);
      return { awsAccessKeyId: "shared-key", awsSecretAccessKey: "shared-secret", awsRegion: "region", opencodeOcrApiKey: "ocr-key" };
    },
    runOcrOnImage: async (bytes: Buffer, fileName: string, mimeType: string, settings: any) => {
      paidCalls++; events.push("ocr");
      assert.equal(bytes.toString(), "stored-image"); assert.equal(fileName, "page.png"); assert.equal(mimeType, "image/png");
      assert.deepEqual(settings.marginHints, { headers: ["Lara Vil\u00e1n"], footers: ["Ef\u00edmera"] });
      assert.deepEqual(settings.awsCredentials, { accessKeyId: "shared-key", secretAccessKey: "shared-secret", region: "region" });
      assert.equal(settings.opencodeApiKey, "ocr-key"); assert.equal(settings.rotation, 90);
      return { editedText: "text", htmlContent: null, rawText: "text", paragraphs: ["text"], paragraphMetadata: [{ role: "body", readAloud: true }] };
    },
    externalizeContentImages: (contents: string[]) => ({ contents, assets: [] }), insertContentImageAssets: async () => {},
    replaceBookPageParagraphs: async (_db: unknown, value: unknown) => { events.push("replace"); replacement = value; },
    recordUserActivity: async () => {}
  };
  const start = routes.indexOf('  app.post("/:bookId/pages/:pageNumber/rerun-ocr",');
  const end = routes.indexOf("\n  });", start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  assert.ok(body);
  const handler = new Function(...Object.keys(dependencies), ts.transpile(`return async (request, reply) => {${body}\n};`,
    { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
  return { events, get paidCalls() { return paidCalls; }, get replacement() { return replacement; }, call: async () => {
    const reply = { statusCode: 200, status(code: number) { this.statusCode = code; return this; }, send() { return this; } };
    await handler({ currentUser: { userId: "editor" }, params: { bookId: "existing-book", pageNumber: 67 },
      body: { expectedUpdatedAt: options.stale ? "stale" : "original", ocrMode: "TEXTRACT" } }, reply);
    return reply;
  } };
}

test("rerun passes hints after locks and version guard, preserves credentials and writes only the target page", async () => {
  assert.match(routes, /app\.post\("\/:bookId\/pages\/:pageNumber\/rerun-ocr", \{ preHandler: \[authenticateRequest, requireBookRole\("EDITOR"\)\]/u);
  const app = setup();
  assert.equal((await app.call()).statusCode, 200);
  assert.deepEqual(app.events, ["book-lock", "page-lock", "hints", "ocr", "replace", "commit"]);
  assert.equal(app.paidCalls, 1);
  assert.equal(app.replacement.bookId, "existing-book"); assert.equal(app.replacement.pageNumber, 67);
  assert.deepEqual(app.replacement.paragraphMetadata, [{ role: "body", readAloud: true }]);
});

test("stale, inaccessible and non-image books do not collect hints or call OCR; concurrent edits are not replaced", async () => {
  for (const options of [{ stale: true }, { inaccessible: true }, { sourceType: "PDF" }]) {
    const app = setup(options);
    assert.equal((await app.call()).statusCode, options.inaccessible ? 404 : 409);
    assert.equal(app.paidCalls, 0); assert.equal(app.replacement, undefined);
    assert.ok(!app.events.includes("hints"));
  }
  const concurrent = setup({ concurrent: true });
  assert.equal((await concurrent.call()).statusCode, 409);
  assert.equal(concurrent.paidCalls, 1); assert.equal(concurrent.replacement, undefined);
  assert.ok(!concurrent.events.includes("commit"));
});
