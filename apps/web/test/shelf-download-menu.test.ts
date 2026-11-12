import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/features/shelf/ShelfPage.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("ShelfPage.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handler: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleDownloadAction") handler = node;
  ts.forEachChild(node, visit);
}
visit(file);

test("EPUB and image downloads toggle the format menu; PDF keeps the original download", () => {
  assert.ok(handler);
  const javascript = ts.transpileModule(handler.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  let menu: string | null = null;
  const originals: string[] = [];
  const busy = { current: false };
  const download = new Function("downloadInProgressRef", "setDownloadMenuBookId", "handleDownloadOriginal",
    `${javascript}; return handleDownloadAction;`)(busy,
    (update: (current: string | null) => string | null) => { menu = update(menu); },
    (book: { bookId: string }) => { originals.push(book.bookId); });
  let prevented = 0;
  let stopped = 0;
  const event = { preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  for (const sourceType of ["EPUB", "IMAGES"]) {
    download({ bookId: sourceType, sourceType }, event);
    assert.equal(menu, sourceType);
    download({ bookId: sourceType, sourceType }, event);
    assert.equal(menu, null);
  }
  assert.deepEqual(originals, []);
  download({ bookId: "pdf", sourceType: "PDF" }, event);
  assert.deepEqual(originals, ["pdf"]);
  busy.current = true;
  download({ bookId: "epub", sourceType: "EPUB" }, event);
  assert.equal(menu, null);
  assert.equal(prevented, 6);
  assert.equal(stopped, 6);
});

test("opening a download menu scrolls its options into the information dialog viewport", () => {
  const effect = file.statements
    .flatMap((statement) => ts.isFunctionDeclaration(statement) && statement.body ? [...statement.body.statements] : [])
    .find((statement) => ts.isExpressionStatement(statement)
      && ts.isCallExpression(statement.expression)
      && statement.expression.expression.getText(file) === "useEffect"
      && statement.expression.arguments[1]?.getText(file) === "[downloadMenuBookId]");
  assert.ok(effect);
  const javascript = ts.transpileModule(effect.getText(file), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const scrolls: unknown[] = [];
  const run = new Function("useEffect", "downloadMenuBookId", "downloadMenuRef", javascript);
  const ref = { current: { scrollIntoView(options: unknown) { scrolls.push(options); } } };
  run((callback: () => void) => callback(), null, ref);
  assert.deepEqual(scrolls, []);
  run((callback: () => void) => callback(), "epub", ref);
  assert.deepEqual(scrolls, [{ block: "nearest", inline: "nearest" }]);
  run((callback: () => void) => callback(), "epub", { current: null });
  assert.match(source, /className="book-card-download-menu" ref=\{downloadMenuRef\}/u);
});

test("the information dialog menu does not inherit the floating menu horizontal offset", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/\.shelf-book-info-content \.book-card-download-menu\s*\{([^}]+)\}/u)?.[1];
  assert.ok(rule);
  assert.match(rule, /position:\s*static/u);
  assert.match(rule, /transform:\s*none/u);
  assert.match(rule, /flex-basis:\s*100%/u);
});
