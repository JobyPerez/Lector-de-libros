import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import PDFDocument from "pdfkit";
import ts from "typescript";
import { z } from "zod";
import { deriveTitleFromFileName, parseUploadedBook, type ImportedDocument } from "../src/modules/books/book-import.js";
import { normalizeParagraphMetadata } from "../src/modules/books/page-elements.js";
import { calculateParagraphReadingMetrics } from "../src/services/paragraph-metrics.js";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
function declaration(name: string) {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name
    || ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => item.name.getText(source) === name));
  assert.ok(node, name);
  return node.getText(source);
}
function extract(code: string, dependencies: Record<string, unknown> = {}) {
  return new Function(...Object.keys(dependencies), ts.transpile(code, { target: ts.ScriptTarget.ES2022 }))(...Object.values(dependencies));
}
let importHandler: ts.ArrowFunction | undefined;
function visit(node: ts.Node) {
  if (ts.isCallExpression(node) && node.expression.getText(source) === "app.post"
    && ts.isStringLiteral(node.arguments[0]!) && node.arguments[0].text === "/import") {
    const callback = node.arguments.at(-1);
    assert.ok(callback && ts.isArrowFunction(callback));
    importHandler = callback;
  }
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(importHandler);
const readUploadedFile = extract(`${declaration("readUploadedFile")}\nreturn readUploadedFile;`);
const schemas = extract(`${declaration("importBookFieldsSchema")}\nreturn importBookFieldsSchema;`, {
  z, supportedBookLanguageCodes: ["es", "it"], supportedBookSourceTypes: ["PDF", "EPUB"]
});

function upload(buffer: Buffer) {
  const boundary = "pdf-upload-regression";
  return {
    method: "POST" as const,
    url: "/import",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="book.pdf"\r\nContent-Type: application/pdf\r\n\r\n`),
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
}

async function fixture(options: { smallLimit?: number; realParser?: boolean; failure?: "persist" | "connection"; afterParse?: (document: ImportedDocument) => void } = {}) {
  const app = Fastify();
  // Disable multipart's own exception so the production helper must detect truncated streams.
  await app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 }, throwFileSizeLimit: false });
  const writes: { sql: string; binds: Record<string, any> }[] = [];
  const lifecycle: string[] = [];
  const fileOptions: unknown[] = [];
  const parsedBuffers: Buffer[] = [];
  const progress: Record<string, unknown>[] = [];
  const io: string[] = [];
  const pending: typeof writes = [];
  const committed: typeof writes = [];
  let imported: ImportedDocument | undefined;
  let connections = 0;
  const connection = {
    execute: async (sql: string, binds: Record<string, any>) => {
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ coverCount: pending.filter((write) => write.sql.includes("'COVER_IMAGE'")).length }] };
      writes.push({ sql, binds });
      if (options.failure === "persist" && /INSERT INTO book_pages/.test(sql) && binds.pageNumber === 2) throw new Error("persistence fault");
      pending.push({ sql, binds });
      return { rows: [] };
    },
    commit: async () => { lifecycle.push("commit"); committed.push(...pending); pending.length = 0; },
    rollback: async () => { lifecycle.push("rollback"); pending.length = 0; },
    close: async () => { lifecycle.push("close"); }
  };
  const document: ImportedDocument = {
    pages: [{ pageNumber: 1, paragraphs: ["Readable PDF."], rawText: "Readable PDF." }],
    totalPages: 1, totalParagraphs: 1
  };
  const dependencies = {
    z, randomUUID, readUploadedFile, importBookFieldsSchema: schemas, deriveTitleFromFileName,
    normalizeParagraphMetadata, calculateParagraphReadingMetrics,
    readFile: async (filePath: string) => {
      assert.equal(typeof filePath, "string");
      io.push(`read:${filePath}`);
      return readFile(filePath);
    },
    unlink: async (filePath: string) => {
      await unlink(filePath);
      await assert.rejects(access(filePath), { code: "ENOENT" });
      io.push(`unlink:${filePath}`);
    },
    ...extract(`${declaration("readMultipartField")}\n${declaration("detectSourceType")}\nreturn { readMultipartField, detectSourceType };`, {
      inferSourceType: (fileName: string, mimeType: string) => fileName.endsWith(".pdf") || mimeType === "application/pdf" ? "PDF" : null
    }),
    parseUploadedBook: async (sourceType: "PDF" | "EPUB", buffer: Buffer) => {
      parsedBuffers.push(buffer);
      imported = options.realParser ? await parseUploadedBook(sourceType, buffer) : document;
      options.afterParse?.(imported);
      return imported;
    },
    getConnection: async () => { connections++; if (options.failure === "connection") throw new Error("connection fault"); return connection; },
    setBookImportProgress: () => {},
    updateBookImportProgress: (_id: unknown, value: Record<string, unknown>) => { progress.push(value); },
    externalizeContentImages: (contents: string[]) => ({ contents, assets: [] }),
    insertContentImageAssets: async () => {}, recordUserActivity: async () => {},
    computeChecksum: (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex")
  };
  const persist = extract(`${declaration("insertProcessedImagePages")}\nreturn insertProcessedImagePages;`, dependencies);
  Object.assign(dependencies, {
    insertProcessedImagePages: async (...args: any[]) => {
      assert.equal(args[2].length, 1, "each persistence call must contain exactly one page buffer");
      assert.ok(Buffer.isBuffer(args[2][0].buffer));
      io.push(`persist:${args[3]}`);
      const result = await persist(...args);
      io.push(`persisted:${args[3]}`);
      return result;
    }
  });
  const handler = extract(`return ${importHandler.getText(source)};`, dependencies);
  app.post("/import", {
    preHandler: async (request) => {
      Object.assign(request, { currentUser: { userId: "owner" } });
      const file = request.file.bind(request);
      request.file = (opts) => {
        fileOptions.push(opts);
        return file(options.smallLimit ? { ...opts, limits: { ...opts?.limits, fileSize: options.smallLimit } } : opts);
      };
    }
  }, handler);
  return { app, writes, lifecycle, fileOptions, parsedBuffers, progress, io, pending, committed,
    get imported() { return imported; }, get connections() { return connections; } };
}

test("readUploadedFile concatenates every chunk unchanged and reports cumulative byte counts", async () => {
  const chunks = [Buffer.from("%PDF-1.7\n"), new Uint8Array([0, 255, 13, 10]), Buffer.from("%%EOF")];
  const progress: number[] = [];
  const buffer = await readUploadedFile({ file: Readable.from(chunks) }, { onProgress: (bytes: number) => progress.push(bytes) });
  assert.deepEqual(buffer, Buffer.concat(chunks));
  assert.deepEqual(progress, [9, 13, 18]);
});

test("real multipart truncation returns 413 before parsing or opening a persistence connection", async (t) => {
  const context = await fixture({ smallLimit: 32 });
  t.after(() => context.app.close());
  t.after(() => context.imported?.cleanup?.());
  const response = await context.app.inject(upload(Buffer.from("%PDF-1.7\n" + "x".repeat(128))));
  assert.equal(response.statusCode, 413);
  assert.match(response.json().message, /Se ha recibido incompleto y no se puede importar/u);
  assert.equal(context.parsedBuffers.length, 0);
  assert.equal(context.connections, 0);
  assert.deepEqual(context.writes, []);
  assert.deepEqual(context.lifecycle, []);
  assert.ok(context.progress.some((event) => event.completedUnits === 32));
  assert.equal(context.progress.at(-1)?.stage, "failed");
});

test("POST /import effectively overrides the old 15 MiB multipart limit with 100 MiB and preserves all bytes", async (t) => {
  const context = await fixture();
  t.after(() => context.app.close());
  t.after(() => context.imported?.cleanup?.());
  const originalPdf = await new Promise<Buffer>((resolve, reject) => {
    const document = new PDFDocument({ compress: false });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    document.text("Readable PDF.");
    // An unused, uncompressed stream enlarges a valid one-page PDF without extra rendering.
    const padding = document.ref({});
    padding.write(Buffer.alloc(16 * 1024 * 1024, 32));
    padding.end();
    document.end();
  });
  const buffer = originalPdf;
  assert.ok(buffer.length > 15 * 1024 * 1024);
  const response = await context.app.inject(upload(buffer));
  assert.equal(response.statusCode, 201, response.body);
  assert.deepEqual(context.fileOptions, [{ limits: { fileSize: 100 * 1024 * 1024 } }]);
  assert.equal(context.parsedBuffers.length, 1);
  assert.deepEqual(context.parsedBuffers[0], buffer);
  const original = context.writes.find(({ binds }) => binds.fileKind === "ORIGINAL_PDF");
  assert.ok(original);
  assert.equal(original.binds.byteSize, buffer.length);
  assert.deepEqual(original.binds.contentBlob, buffer);
  assert.equal(original.binds.checksumSha256, createHash("sha256").update(buffer).digest("hex"));
  assert.equal(response.json().book.sourceType, "PDF");
  assert.deepEqual(context.lifecycle, ["commit", "close"]);
});

test("POST /import with the real parser returns Spanish 422 for a corrupt non-truncated PDF without persistence", async (t) => {
  const context = await fixture({ realParser: true });
  t.after(() => context.app.close());
  t.after(() => context.imported?.cleanup?.());
  const buffer = Buffer.from("%PDF-1.7\nThis is not a PDF object or cross-reference table.\n%%EOF");
  const response = await context.app.inject(upload(buffer));
  assert.equal(response.statusCode, 422, response.body);
  assert.match(response.json().message, /No se puede abrir el PDF: su estructura no es válida o el archivo está incompleto/u);
  assert.deepEqual(context.parsedBuffers, [buffer]);
  assert.equal(context.connections, 0);
  assert.deepEqual(context.writes, []);
  assert.equal(context.progress.at(-1)?.stage, "failed");
});

for (const failure of [undefined, "persist", "connection"] as const) {
  test(`scanned multipart import: ${failure ?? "success"} cleans temporary files and preserves transaction boundaries`, async (t) => {
    let cleanupCalls = 0;
    let cleanupCompletion: Promise<void> | undefined;
    const context = await fixture({ realParser: true, failure, afterParse(document) {
      const cleanup = document.cleanup!;
      document.cleanup = () => { cleanupCalls++; cleanupCompletion = cleanup(); return cleanupCompletion; };
      assert.ok(document.pageImages?.every((page) => !Object.hasOwn(page, "buffer")));
    } });
    t.after(() => context.app.close());
    t.after(() => context.imported?.cleanup?.());
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const document = new PDFDocument({ autoFirstPage: false });
      const chunks: Buffer[] = [];
      document.on("data", (chunk: Buffer) => chunks.push(chunk));
      document.on("error", reject);
      document.on("end", () => resolve(Buffer.concat(chunks)));
      for (const color of ["red", "blue", "green"]) {
        document.addPage({ size: [72, 72], margin: 0 });
        document.rect(0, 0, 72, 72).fill(color);
      }
      document.end();
    });
    const response = await context.app.inject(upload(buffer));
    assert.equal(response.statusCode, failure ? 500 : 201, response.body);
    assert.equal(cleanupCalls, 1, "route finally must await cleanup, including failed connection acquisition");
    // Fastify can send a successful reply before the handler's finally finishes.
    await cleanupCompletion;
    const images = context.imported!.pageImages!;
    await assert.rejects(access(dirname(images[0]!.filePath)), { code: "ENOENT" });
    assert.deepEqual(context.pending, []);
    if (failure) {
      assert.deepEqual(context.committed, [], "rollback must leave no partial book, original, cover or pages");
      assert.deepEqual(context.lifecycle, failure === "persist" ? ["rollback", "close"] : []);
      assert.equal(context.progress.at(-1)?.stage, "failed");
      assert.match(response.json().message, /fault/);
      if (failure === "connection") assert.deepEqual(context.writes, []);
      else {
        assert.ok(context.writes.some(({ sql }) => /INSERT INTO books/.test(sql)));
        assert.ok(context.writes.some(({ sql, binds }) => /INSERT INTO book_pages/.test(sql) && binds.pageNumber === 1));
        assert.deepEqual(context.io, [
          `read:${images[0]!.filePath}`, "persist:1", "persisted:1", `unlink:${images[0]!.filePath}`,
          `read:${images[1]!.filePath}`, "persist:2"
        ]);
      }
    } else {
      assert.deepEqual(context.lifecycle, ["commit", "close"]);
      assert.deepEqual(context.io, images.flatMap((image, index) => [
        `read:${image.filePath}`, `persist:${index + 1}`, `persisted:${index + 1}`, `unlink:${image.filePath}`
      ]), "no next page may be read until the previous one is persisted and unlinked");
      const saved = context.progress.filter((event) => String(event.message).startsWith("Guardando página"));
      assert.deepEqual(saved.map((event) => [event.completedUnits, event.totalUnits, event.percentage]), [[1, 3, 82], [2, 3, 90], [3, 3, 97]]);
      const covers = context.committed.filter(({ sql }) => sql.includes("'COVER_IMAGE'"));
      assert.equal(covers.length, 1);
      const first = context.committed.find(({ sql, binds }) => sql.includes("'PAGE_IMAGE'") && binds.pageNumber === 1)!;
      assert.deepEqual(covers[0]!.binds.contentBlob, first.binds.contentBlob);
      assert.equal(covers[0]!.binds.fileName, "pagina-1.jpg");
      assert.equal(covers[0]!.binds.mimeType, "image/jpeg");
    }
  });
}
