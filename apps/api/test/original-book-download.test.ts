import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
const names = ["assembleOriginalBookDownload", "buildAccessibleOriginalBookDownload"];
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text ?? ""));
assert.equal(functions.length, names.length);
const compiled = ts.transpile(functions.map((node) => node.getText(ast)).join("\n"), { target: ts.ScriptTarget.ES2022 });

function fixture(sourceType: "PDF" | "EPUB" | "IMAGES", file: { contentBlob?: Buffer | null; fileName?: string | null; mimeType?: string | null } | null, accessible = true) {
  const connection = {};
  const calls: string[] = [];
  const download = new Function("findAccessibleBook", "findBookFileByKind", "buildDownloadFileName", `${compiled}; return buildAccessibleOriginalBookDownload;`)(
    async (db: unknown, bookId: string, userId: string) => {
      assert.equal(db, connection);
      assert.equal(bookId, "book");
      assert.equal(userId, "viewer");
      return accessible ? { bookId, title: "Title", sourceType } : null;
    },
    async (db: unknown, bookId: string, kind: string) => {
      assert.equal(db, connection);
      assert.equal(bookId, "book");
      calls.push(kind);
      return file;
    },
    (title: string, extension: string) => `${title}.${extension}`
  );
  return { calls, download: () => download(connection, "book", "viewer") };
}

test("IMAGES downloads its preserved ORIGINAL_PDF with stored metadata and unchanged bytes", async () => {
  const contentBlob = Buffer.from("original PDF bytes");
  const app = fixture("IMAGES", { contentBlob, fileName: " original.pdf ", mimeType: " application/pdf " });
  assert.deepEqual(await app.download(), { buffer: contentBlob, fileName: "original.pdf", mimeType: "application/pdf" });
  assert.deepEqual(app.calls, ["ORIGINAL_PDF"]);
});

test("IMAGES without original PDF retains IMAGES_SOURCE", async () => {
  for (const file of [null, {}, { contentBlob: null }]) {
    const app = fixture("IMAGES", file);
    assert.equal(await app.download(), "IMAGES_SOURCE");
    assert.deepEqual(app.calls, ["ORIGINAL_PDF"]);
  }
});

test("original downloads retain PDF/EPUB kinds, missing-file behavior and metadata fallbacks", async () => {
  for (const sourceType of ["IMAGES", "PDF", "EPUB"] as const) {
    const contentBlob = Buffer.from(sourceType);
    const app = fixture(sourceType, { contentBlob, fileName: " ", mimeType: null });
    const epub = sourceType === "EPUB";
    assert.deepEqual(await app.download(), { buffer: contentBlob, fileName: epub ? "Title.epub" : "Title.pdf", mimeType: epub ? "application/epub+zip" : "application/pdf" });
    assert.deepEqual(app.calls, [epub ? "ORIGINAL_EPUB" : "ORIGINAL_PDF"]);
    if (sourceType !== "IMAGES") assert.equal(await fixture(sourceType, null).download(), null);
  }
});

test("inaccessible books return null without looking up original files", async () => {
  const app = fixture("IMAGES", { contentBlob: Buffer.from("private PDF") }, false);
  assert.equal(await app.download(), null);
  assert.deepEqual(app.calls, []);
});
