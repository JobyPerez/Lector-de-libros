import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { z } from "zod";

const source = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("books.routes.ts", source, ts.ScriptTarget.Latest, true);
const schemaStatement = ast.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === "updateBookSchema"));
assert.ok(schemaStatement);
const schema = new Function("z", "supportedBookLanguageCodes", `${schemaStatement.getText(ast)}; return updateBookSchema;`)(z, ["es", "it"]);

function loadFunction(name: string) {
  const node = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node);
  return new Function(`${ts.transpile(node.getText(ast), { target: ts.ScriptTarget.ES2022 })}; return ${name};`)();
}

test("book dates accept optional, clearable values and reject invalid dates and years", () => {
  for (const fields of [{}, { readingDate: null, publicationYear: null }, { readingDate: "2024-02-29", publicationYear: 1984 }]) {
    assert.equal(schema.safeParse({ title: "Libro", ...fields }).success, true);
  }
  for (const readingDate of ["2025-02-29", "2024-02-30", "0000-01-01", "2024-13-01", "ayer", "2024-01-01T12:00:00Z"]) {
    assert.equal(schema.safeParse({ title: "Libro", readingDate }).success, false, readingDate);
  }
  for (const publicationYear of [0, -1, 10000, 2024.5, "2024"]) {
    assert.equal(schema.safeParse({ title: "Libro", publicationYear }).success, false);
  }
});

test("reading date writes are scoped to the current user and can be cleared", async () => {
  const upsert = loadFunction("upsertUserBookSettings");
  const calls: Array<{ sql: string; binds: Record<string, unknown> }> = [];
  const connection = { execute: async (sql: string, binds: Record<string, unknown>) => calls.push({ sql, binds }) };
  for (const [userId, readingDate] of [["owner", "2026-11-01"], ["viewer", "2026-11-04"], ["viewer", null]]) {
    await upsert(connection, { bookId: "book", userId, readingDate, notionBookUrl: null });
  }
  assert.deepEqual(calls.map(({ binds }) => [binds.userId, binds.readingDate]), [
    ["owner", "2026-11-01"], ["viewer", "2026-11-04"], ["viewer", null]
  ]);
  assert.match(calls[0].sql, /target.user_id = source.user_id AND target.book_id = source.book_id/);
  assert.match(calls[0].sql, /TO_DATE\(:readingDate, 'YYYY-MM-DD'\)/);
  assert.match(calls[2].sql, /reading_date = source.reading_date/);
});

test("book queries return a shared publication year and the user's date without timezone conversion", async () => {
  for (const name of ["findAccessibleBook", "findOwnedBook"]) {
    const find = loadFunction(name);
    await find({ execute: async (sql: string) => {
      assert.match(sql, /b.publication_year AS "publicationYear"/);
      assert.match(sql, /TO_CHAR\(us.reading_date, 'YYYY-MM-DD'\) AS "readingDate"/);
      assert.match(sql, /us.user_id = :(userId|ownerUserId)/);
      return { rows: [] };
    } }, "book", "viewer");
  }
});

test("shelf sorts dates and publication years descending with missing values last", () => {
  const shelf = readFileSync(new URL("../../web/src/features/shelf/ShelfPage.tsx", import.meta.url), "utf8");
  const shelfAst = ts.createSourceFile("ShelfPage.tsx", shelf, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let sorter = "";
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(shelfAst) === "sortBooks") sorter = node.initializer!.getText(shelfAst);
    ts.forEachChild(node, visit);
  }
  visit(shelfAst);
  assert.ok(sorter);
  const makeSort = new Function("sortMode", ts.transpile(`return (${sorter});`, { target: ts.ScriptTarget.ES2022 }));
  const books = [
    { bookId: "missing", createdAt: "2026-11-04" },
    { bookId: "older", readingDate: "2025-11-01", publicationYear: 1984 },
    { bookId: "newer", readingDate: "2026-01-02", publicationYear: 2001 }
  ];
  for (const mode of ["readingDate", "publicationYear"]) {
    assert.deepEqual(makeSort(mode)(books).map((book: { bookId: string }) => book.bookId), ["newer", "older", "missing"]);
  }
  assert.equal(books[0].bookId, "missing");
});
