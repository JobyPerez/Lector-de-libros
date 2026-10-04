import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { matchParagraphsWithExplicitIds } from "../src/modules/books/paragraph-ids.js";

const source = ts.createSourceFile("books.routes.ts", readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const replacementFunction = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === "replaceBookPageParagraphs");
assert.ok(replacementFunction?.body);
const compiled = ts.transpile(`async function replaceBookPageParagraphs(connection, options) ${replacementFunction.body.getText(source)}`, { target: ts.ScriptTarget.ES2022 });

type Paragraph = { paragraphId: string; paragraphNumber: number };
type Replacement = Paragraph & { sequenceNumber: number };

async function replacePage(existing: Paragraph[], paragraphIds: (string | null)[], inferredIds: string[] = []) {
  const statements: { sql: string; binds: Record<string, string | number> }[] = [];
  const replace = new Function(
    "listPageParagraphs", "listPageBookmarks", "listPageHighlights", "listPageNotes",
    "calculateParagraphReadingMetrics", "randomUUID", "matchParagraphsWithExplicitIds", "matchReplacementParagraphs",
    "invalidateBookAudioCache", "shiftSubsequentSequenceNumbers", "shiftSubsequentAnnotationSequenceNumbers",
    `${compiled}; return replaceBookPageParagraphs;`
  )(
    async () => existing, async () => [], async () => [], async () => [],
    () => ({ characterCount: 1, wordCount: 1 }), randomUUID, matchParagraphsWithExplicitIds,
    (_existing: Paragraph[], replacements: Replacement[]) => new Map(inferredIds.map((id, index) => [id, replacements[index]!])),
    async () => undefined, async () => undefined, async () => undefined
  );
  await replace({
    async execute(sql: string, binds: Record<string, string | number>) {
      statements.push({ sql, binds });
      return { rows: sql.includes('COUNT(*) AS "paragraphCount"') ? [{ paragraphCount: 10 }] : [] };
    }
  }, {
    bookId: "book", pageNumber: 3, page: { pageId: "page" },
    editedText: "edited", htmlContent: null, ocrStatus: "DONE", rawText: "raw",
    paragraphs: paragraphIds.map(() => "text"),
    ...(inferredIds.length === 0 ? { paragraphIds } : {})
  });
  const progress = statements.find(({ sql }) => sql.includes("SET current_paragraph_number = CASE"));
  assert.ok(progress);
  assert.match(progress.sql, /audio_offset_ms = 0/);
  assert.match(progress.sql, /WHERE book_id = :bookId\s+AND current_page_number = :pageNumber/);
  assert.equal(progress.binds.bookId, "book");
  assert.equal(progress.binds.pageNumber, 3);
  assert.equal(progress.binds.previousParagraphCount, 10);
  assert.equal(progress.binds.replacementCount, paragraphIds.length);
  assert.match(progress.sql, /WHEN :replacementCount = 0 THEN 1/);
  assert.match(progress.sql, /WHEN :replacementCount = 0 THEN GREATEST\(/);
  assert.match(progress.sql, /GREATEST\(1, LEAST\(current_paragraph_number, :replacementCount\)\)/);

  const mappings = [...progress.sql.matchAll(/WHEN :(oldParagraph\d+) THEN :(newParagraph\d+)/g)];
  // Each mapping must appear in both assignments, evaluated against the old row.
  assert.equal(mappings.length % 2, 0);
  const remap = new Map<number, number>();
  for (const [, oldBind, newBind] of mappings) {
    remap.set(Number(progress.binds[oldBind!]), Number(progress.binds[newBind!]));
  }
  const paragraphExpression = progress.sql.match(/ELSE (.+)\n\s+END,/)?.[1];
  assert.ok(paragraphExpression);
  assert.ok(progress.sql.includes(`ELSE :previousParagraphCount + (${paragraphExpression})`));
  const inserted = statements.filter(({ sql }) => sql.includes("INSERT INTO book_paragraphs"));
  return { remap, inserted, statements };
}

const existing = [
  { paragraphId: "a", paragraphNumber: 1 },
  { paragraphId: "b", paragraphNumber: 2 },
  { paragraphId: "c", paragraphNumber: 3 }
];

test("page progress follows explicit IDs after reorder and recomputes their sequences", async () => {
  const { remap, inserted } = await replacePage(existing, ["c", "a", "b"]);
  assert.deepEqual([...remap], [[1, 2], [2, 3], [3, 1]]);
  for (const old of existing) {
    const paragraph = inserted.find(({ binds }) => binds.paragraphId === old.paragraphId);
    assert.ok(paragraph);
    assert.equal(paragraph.binds.paragraphNumber, remap.get(old.paragraphNumber));
    assert.equal(paragraph.binds.sequenceNumber, 10 + remap.get(old.paragraphNumber)!);
  }
});

test("insertion before an existing paragraph moves progress with that paragraph", async () => {
  const { remap } = await replacePage(existing, [null, "a", "b", "c"]);
  assert.deepEqual([...remap], [[1, 2], [2, 3], [3, 4]]);
});

test("removed paragraphs use the clamp while surviving paragraphs follow their IDs", async () => {
  const { remap } = await replacePage(existing, ["c", "a"]);
  assert.deepEqual([...remap], [[1, 2], [3, 1]]);
  assert.equal(remap.has(2), false);
});

test("heuristic matches also remap the original local paragraph numbers", async () => {
  const { remap } = await replacePage([
    { paragraphId: "a", paragraphNumber: 2 },
    { paragraphId: "b", paragraphNumber: 5 }
  ], [null, null], ["b", "a"]);
  assert.deepEqual([...remap], [[2, 2], [5, 1]]);
});

test("no matches and empty replacements retain the existing fallback without an empty CASE", async () => {
  for (const ids of [[null, null], []]) {
    const { remap, statements } = await replacePage(existing, ids);
    assert.equal(remap.size, 0);
    const progress = statements.find(({ sql }) => sql.includes("SET current_paragraph_number = CASE"))!;
    assert.ok(!progress.sql.includes("CASE current_paragraph_number"));
  }
});
