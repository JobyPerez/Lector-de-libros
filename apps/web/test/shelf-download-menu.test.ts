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
