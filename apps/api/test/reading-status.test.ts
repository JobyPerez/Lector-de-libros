import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { z } from "zod";

const source = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("books.routes.ts", source, ts.ScriptTarget.Latest, true);

test("book updates accept all five statuses and reject unknown statuses", () => {
  const statement = ast.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === "updateBookSchema"));
  assert.ok(statement);
  const code = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const schema = new Function("z", "supportedBookLanguageCodes", `${code}; return updateBookSchema;`)(z, ["es", "en"]);
  for (const readingStatus of ["SAVED", "READING", "WANT_TO_READ", "READ", "ABANDONED"]) {
    assert.equal(schema.parse({ title: "Libro", readingStatus }).readingStatus, readingStatus);
  }
  assert.equal(schema.safeParse({ title: "Libro", readingStatus: "UNKNOWN" }).success, false);
});

test("imports and creation default new settings to SAVED, while updates retain the stored status", async () => {
  const statement = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "upsertUserBookSettings");
  assert.ok(statement);
  const code = ts.transpileModule(statement.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const upsert = new Function(`${code}; return upsertUserBookSettings;`)();
  const calls: { sql: string; binds: Record<string, unknown> }[] = [];
  const connection = { execute: async (sql: string, binds: Record<string, unknown>) => { calls.push({ sql, binds }); } };
  await upsert(connection, { bookId: "book", userId: "user", notionBookUrl: null });
  assert.equal(calls[0]!.binds.readingStatus, null);
  assert.match(calls[0]!.sql, /NVL\(source.reading_status, 'SAVED'\)/u);
  assert.match(calls[0]!.sql, /reading_status = NVL\(source.reading_status, target.reading_status\)/u);
  await upsert(connection, { bookId: "book", userId: "user", notionBookUrl: null, readingStatus: "WANT_TO_READ" });
  assert.equal(calls[1]!.binds.readingStatus, "WANT_TO_READ");
});
