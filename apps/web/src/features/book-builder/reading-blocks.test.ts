import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { defaultElementMetadata, editReadingBlock, explicitReadingBlocks, joinReadingBlocks, normalizeReadingRows, pageElementsForSave, paragraphLines, parseReadingBlocks, readingElements, readingMetadata, readingBlockMarker, readingDraftSyncAction, serializeReadingBlocks, splitReadingBlock } from "./reading-blocks";
import type { ParagraphElementMetadata } from "../../app/api";
import { buildEditableTextFromHtmlContent, buildOcrPreviewHtml, compactEmbeddedImagesForSave, stabilizeEmbeddedImages } from "./ocr-preview";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { window } = new JSDOM("");
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node, Element: window.Element });

const first = "12345678-1234-4234-8234-123456789012";
const second = "12345678-1234-4234-8234-123456789013";

const headingMetadata: ParagraphElementMetadata = { role: "heading", readAloud: false, geometry: { bbox: { left: .1, top: .2, width: .3, height: .1 } } };
const captionMetadata: ParagraphElementMetadata = { role: "imageCaption", readAloud: true, geometry: null };

test("metadata is opt-in, aligned to nonblank paragraphs, never block markers", () => {
  const text = ":::block a\nA\n\n:::block b\nB";
  assert.ok(!("paragraphMetadata" in parseReadingBlocks(text)[0]!));
  const blocks = parseReadingBlocks(text, [first, second], [headingMetadata, captionMetadata]);
  assert.deepEqual(readingMetadata(blocks), [headingMetadata, captionMetadata]);
  assert.equal(readingElements(blocks).length, 2);
  assert.throws(() => parseReadingBlocks(text, [], [headingMetadata]), /metadatos.*no coinciden/);
});

test("persisted metadata count mismatch fails closed, including excluded multiline paragraphs", () => {
  const excluded: ParagraphElementMetadata = { role: "header", readAloud: false, geometry: null };
  const metadata = [excluded, captionMetadata];
  const text = ":::block heading\nHeader first line\nHeader second line\n\n:::block body\nBody";
  assert.equal(paragraphLines(text).length, 3);
  assert.throws(() => parseReadingBlocks(text, [first, second], metadata), /2 parrafos.*3 elementos/);
  assert.deepEqual(metadata, [excluded, captionMetadata]);
  assert.throws(() => parseReadingBlocks("A", [first], metadata), /2 parrafos.*1 elementos/);
  assert.throws(() => parseReadingBlocks("A", [first], []), /0 parrafos.*1 elementos/);
  assert.deepEqual(parseReadingBlocks(text, [first, second]).flatMap((block) => block.paragraphIds), [null, null, null]);
});

test("HTML br expansion cannot default persisted no-read metadata", () => {
  const text = buildEditableTextFromHtmlContent('<p class="reader-rich-node">Cabecera<br>Segunda linea</p><p class="reader-rich-node">Cuerpo</p>')!;
  const metadata: ParagraphElementMetadata[] = [{ role: "header", readAloud: false }, defaultElementMetadata()];
  assert.equal(paragraphLines(text).length, 3);
  assert.throws(() => parseReadingBlocks(text, [first, second], metadata), /no coinciden/);
  assert.equal(metadata[0]!.readAloud, false);
});

test("metadata follows moves, splitting, joining, edits and new unsaved lines", () => {
  const block = parseReadingBlocks("A\nB", [first, second], [headingMetadata, captionMetadata])[0]!;
  const split = splitReadingBlock(block, 2)!;
  assert.deepEqual(readingElements([split[1]!, split[0]!]).map((element) => element.key), [second, first]);
  assert.deepEqual(readingMetadata([split[1]!, split[0]!]), [captionMetadata, headingMetadata]);
  assert.deepEqual(joinReadingBlocks(split[0]!, split[1]!), block);
  assert.deepEqual(readingMetadata([editReadingBlock(block, "B\nA")]), [captionMetadata, headingMetadata]);
  assert.deepEqual(readingMetadata([editReadingBlock(block, "Edited A\nB")]), [headingMetadata, captionMetadata]);
  const inserted = editReadingBlock(block, "A\nNew\nB");
  assert.deepEqual(readingMetadata([inserted]), [headingMetadata, defaultElementMetadata(), captionMetadata]);
  inserted.paragraphMetadata![1] = { role: "footer", readAloud: false, geometry: null };
  assert.equal(readingMetadata([editReadingBlock(inserted, "A\nEdited new\nB")])[1]!.readAloud, false);
});

test("duplicate collisions never reuse identities or metadata, unchanged duplicates retain both", () => {
  const block = parseReadingBlocks("A\nA\nB", [first, second, null], [headingMetadata, captionMetadata, { role: "footer", readAloud: false }])[0]!;
  assert.deepEqual(readingMetadata([editReadingBlock(block, block.text)]), readingMetadata([block]));
  const moved = editReadingBlock(block, "A\nB\nA");
  assert.deepEqual(moved.paragraphIds, [null, null, null]);
  assert.deepEqual(readingMetadata([moved]), [defaultElementMetadata(), { role: "footer", readAloud: false, geometry: null }, defaultElementMetadata()]);
});

test("metadata PATCH projection preserves flags and geometry and rejects missing, invalid or repeated IDs", () => {
  const blocks = parseReadingBlocks("A\nB", [first, second], [headingMetadata, captionMetadata]);
  assert.deepEqual(pageElementsForSave(blocks), [{ paragraphId: first, ...headingMetadata }, { paragraphId: second, ...captionMetadata }]);
  for (const ids of [[first, null], [first, first], [first, "invalid"]]) {
    assert.equal(pageElementsForSave(parseReadingBlocks("A\nB", ids, [headingMetadata, captionMetadata])), null);
  }
  const before = JSON.stringify(readingMetadata(blocks));
  blocks[0]!.paragraphMetadata![0] = { ...headingMetadata, role: "header", readAloud: true };
  assert.equal(serializeReadingBlocks(blocks), "A\nB");
  assert.notEqual(JSON.stringify(readingMetadata(blocks)), before);
  assert.equal(readingDraftSyncAction({ identity: "book:1", updatedAt: "v1" }, { identity: "book:1", updatedAt: "v2" }, true), "conflict");
});

test("refetch preserves initialized drafts and conflicts never initialize over dirty state", () => {
  const initialized = { identity: "book:1", updatedAt: "v1" };
  assert.equal(readingDraftSyncAction(initialized, { ...initialized }, true), "preserve");
  assert.equal(readingDraftSyncAction(initialized, { ...initialized }, false), "preserve");
  const updated = { ...initialized, updatedAt: "v2" };
  assert.equal(readingDraftSyncAction(initialized, updated, true), "conflict");
  assert.equal(readingDraftSyncAction(initialized, updated, false), "initialize");
  assert.equal(readingDraftSyncAction(initialized, { ...updated, updatedAt: "v3" }, true), "conflict");
});

test("page/book changes and successful save invalidation initialize the remote version", () => {
  const initialized = { identity: "book:1", updatedAt: "v1" };
  assert.equal(readingDraftSyncAction(initialized, { ...initialized, identity: "book:2" }, true), "initialize");
  assert.equal(readingDraftSyncAction(initialized, { ...initialized, identity: "other-book:1" }, true), "initialize");
  assert.equal(readingDraftSyncAction(null, { ...initialized, updatedAt: "saved-v2" }, true), "initialize");
  assert.equal(readingDraftSyncAction(null, initialized, false), "initialize");
});

test("legacy pages stay a single unmarked block, including image paragraphs", () => {
  const text = "# Title\n\nText\n![photo](/image.png)";
  const blocks = parseReadingBlocks(text, ["title", "text", "image"]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.id, null);
  assert.equal(serializeReadingBlocks(blocks), text);
  assert.deepEqual(blocks[0]!.paragraphIds, ["title", "text", "image"]);
});

test("markers round trip and paragraph IDs follow block reordering", () => {
  const text = `:::block ${first}\nA\n\nB\n:::block ${second}\n![photo](/image.png)`;
  const blocks = parseReadingBlocks(text, ["a", "b", "image"]);
  assert.equal(serializeReadingBlocks(blocks), text);
  const reordered = [blocks[1]!, blocks[0]!];
  assert.deepEqual(reordered.flatMap((block) => block.paragraphIds), ["image", "a", "b"]);
  assert.deepEqual(paragraphLines(serializeReadingBlocks(reordered)), ["![photo](/image.png)", "A", "B"]);
});

test("unaligned initial paragraph counts never assign positional IDs", () => {
  assert.deepEqual(parseReadingBlocks("A\nB", ["a"])[0]!.paragraphIds, [null, null]);
});

test("line insertions/deletions keep only unchanged edges and null new lines", () => {
  const block = parseReadingBlocks("A\nB\nC", ["a", "b", "c"])[0]!;
  assert.deepEqual(editReadingBlock(block, "A\nNew\nB\nC").paragraphIds, ["a", null, "b", "c"]);
  assert.deepEqual(editReadingBlock(block, "A\nChanged\nNew\nC").paragraphIds, ["a", null, null, "c"]);
  assert.deepEqual(editReadingBlock(block, "A\nC").paragraphIds, ["a", "c"]);
  assert.deepEqual(editReadingBlock(block, "A\nEdited B\nC").paragraphIds, ["a", "b", "c"]);
});

test("same-length unique swaps carry IDs with content", () => {
  const block = parseReadingBlocks("A\nB\nC", ["a", "b", "c"])[0]!;
  assert.deepEqual(editReadingBlock(block, "B\nA\nC").paragraphIds, ["b", "a", "c"]);
  assert.deepEqual(editReadingBlock(block, "B\nEdited A\nC").paragraphIds, ["b", null, "c"]);
});

test("duplicate swaps do not guess paragraph identities", () => {
  const block = parseReadingBlocks("A\nA\nB", ["a1", "a2", "b"])[0]!;
  assert.deepEqual(editReadingBlock(block, "A\nB\nA").paragraphIds, [null, "b", null]);
  assert.deepEqual(editReadingBlock(block, block.text).paragraphIds, ["a1", "a2", "b"]);
});

test("modified lines without movement preserve positional IDs", () => {
  const block = parseReadingBlocks("A\nB\nC", ["a", "b", "c"])[0]!;
  assert.deepEqual(editReadingBlock(block, "Edited A\nB\nEdited C").paragraphIds, ["a", "b", "c"]);
});

test("split at selected paragraph preserves IDs, and union is lossless", () => {
  const block = explicitReadingBlocks(parseReadingBlocks("A\n\nB\nC", ["a", "b", "c"]))[0]!;
  const split = splitReadingBlock(block, block.text.indexOf("B"))!;
  assert.equal(split[0]!.id, block.id);
  assert.notEqual(split[1]!.id, block.id);
  assert.deepEqual(split.map((item) => item.paragraphIds), [["a"], ["b", "c"]]);
  assert.deepEqual(paragraphLines(split.map((item) => item.text).join("\n")), ["A", "B", "C"]);
  assert.equal(splitReadingBlock(block, 0), null);
});

test("preview hides markers, numbers sections and preserves inline formatting/images", () => {
  const html = buildOcrPreviewHtml(`:::block ${first}\n# **Title**\n*Text*\n:::block ${second}\n![photo](/real-image.png)`)!;
  assert.ok(!html.includes(":::block"));
  assert.ok(html.includes(`data-reading-block-id="${second}"`));
  assert.ok(html.includes('data-reading-block-number="2"'));
  assert.ok(html.includes('data-paragraph-number="3"'));
  assert.ok(html.includes("<strong>Title</strong>"));
  assert.ok(html.includes("<em>Text</em>"));
  assert.ok(html.includes('src="/real-image.png"'));
});

test("empty marked blocks stay serialized but do not render literal markers", () => {
  const text = `:::block ${first}\n\n:::block ${second}\nText`;
  assert.equal(parseReadingBlocks(text).length, 2);
  assert.ok(buildOcrPreviewHtml(text)!.includes('data-reading-block-number="2"'));
  assert.equal(buildOcrPreviewHtml(`:::block ${first}`), null);
});

test("temporary or unresolved image URLs cannot be saved", () => {
  assert.throws(() => stabilizeEmbeddedImages("![photo](blob:temporary)"), /blob/);
  assert.throws(() => stabilizeEmbeddedImages("![photo](embedded-image-1)"), /HTML persistido/);
  assert.equal(stabilizeEmbeddedImages("![photo](/real-image.png)"), "![photo](/real-image.png)");
  assert.equal(buildOcrPreviewHtml("![photo](blob:temporary)"), null);
});

test("AI semantic block IDs survive HTML, preview and reordered paragraphs", () => {
  const text = ":::block heading_1\n# Title\n:::block body-main\nText\n:::block image_2\n![photo](/image.png)";
  const blocks = parseReadingBlocks(text, ["title", "text", "photo"]);
  assert.deepEqual(blocks.map((block) => block.id), ["heading_1", "body-main", "image_2"]);
  const html = buildOcrPreviewHtml(text)!;
  assert.ok(!html.includes(":::block"));
  assert.equal(stabilizeEmbeddedImages(buildEditableTextFromHtmlContent(html)!, html), text);
  const reordered = [blocks[2]!, blocks[0]!, blocks[1]!];
  assert.deepEqual(reordered.flatMap((block) => block.paragraphIds), ["photo", "title", "text"]);
  assert.ok(buildOcrPreviewHtml(serializeReadingBlocks(reordered))!.includes('data-reading-block-id="image_2"'));
});

test("save compacts only persisted data sources in original order, not preview or IDs", () => {
  const largeSource = `data:image/png;base64,${"A".repeat(60000)}`;
  const secondSource = "data:image/png;base64,BBBB";
  const html = `<div class="epub-page-body"><img src="/existing.png"><img src="${largeSource}"><img src="${secondSource}"></div>`;
  const text = `:::block image_main\n![second](${secondSource})\n![first](${largeSource})\n![new](data:image/png;base64,NEW)\n![url](/existing.png)\n![uuid](embedded-image-${first})`;
  const blocks = parseReadingBlocks(text, ["second", "first", "new", "url", "uuid"]);
  const compact = compactEmbeddedImagesForSave(text, html);
  assert.ok(text.length > 50000);
  assert.ok(compact.length < 50000);
  assert.equal(compact, `:::block image_main\n![second](embedded-image-3)\n![first](embedded-image-2)\n![new](data:image/png;base64,NEW)\n![url](/existing.png)\n![uuid](embedded-image-${first})`);
  assert.equal(stabilizeEmbeddedImages(compact, html), text);
  assert.ok(buildOcrPreviewHtml(text, html)!.includes(`src="${largeSource}"`));
  assert.deepEqual(blocks[0]!.paragraphIds, ["second", "first", "new", "url", "uuid"]);
  assert.equal(serializeReadingBlocks(blocks), text);
  assert.equal(compactEmbeddedImagesForSave(text, null), text);
});

test("optional row markers round trip without consuming paragraph IDs", () => {
  const text = ":::block a row=row_1\nA\n\n:::block b row=row_1\n![photo](/image.png)\n:::block c\nC";
  const blocks = parseReadingBlocks(text, ["a", "photo", "c"]);
  assert.equal(serializeReadingBlocks(blocks), text);
  assert.deepEqual(blocks.map((block) => block.rowId), ["row_1", "row_1", undefined]);
  assert.deepEqual(blocks.flatMap((block) => block.paragraphIds), ["a", "photo", "c"]);
  assert.deepEqual(paragraphLines(text), ["A", "![photo](/image.png)", "C"]);
  for (const id of ["a", "A_0-", "x".repeat(80)]) {
    assert.ok(readingBlockMarker.test(`:::block ${id} row=${id}`));
    assert.ok(readingBlockMarker.test(`:::block ${id}`));
  }
  for (const id of ["", "x".repeat(81), "a.b", "a b", "\u00f1"]) {
    assert.ok(!readingBlockMarker.test(`:::block a row=${id}`));
    assert.ok(!readingBlockMarker.test(`:::block ${id} row=r`));
  }
  assert.ok(!readingBlockMarker.test(":::block a row=r extra=metadata"));
});

test("preview groups only contiguous rows and numbers paragraphs across wrappers", () => {
  const text = ":::block a row=r\n# **Title**\n:::block b row=r\n![photo](/image.png)\n:::block c\nText\n:::block d row=r\nLast";
  const html = buildOcrPreviewHtml(text)!;
  const document = new window.DOMParser().parseFromString(html, "text/html");
  const rows = Array.from(document.querySelectorAll("div.reader-reading-row")) as Element[];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.children.length), [2, 1]);
  assert.deepEqual(rows.map((row) => row.getAttribute("data-reading-row-id")), ["r", "r"]);
  assert.deepEqual((Array.from(document.querySelectorAll("section")) as Element[]).map((node) => node.getAttribute("data-reading-row-id")), ["r", "r", null, "r"]);
  assert.deepEqual((Array.from(document.querySelectorAll("[data-paragraph-number]")) as Element[]).map((node) => node.getAttribute("data-paragraph-number")), ["1", "2", "3", "4"]);
  assert.ok(!html.includes(":::block"));
  assert.equal(stabilizeEmbeddedImages(buildEditableTextFromHtmlContent(html)!, html), text);
});

test("HTML row wrappers supply row metadata when sections omit it", () => {
  const html = '<div class="reader-reading-row" data-reading-row-id="r"><section class="reader-reading-block" data-reading-block-id="a"><p class="reader-rich-node">A</p></section><section class="reader-reading-block" data-reading-block-id="b" data-reading-row-id="s"><p class="reader-rich-node">B</p></section></div>';
  assert.equal(buildEditableTextFromHtmlContent(html), ":::block a row=r\nA\n:::block b row=s\nB");
});

test("row normalization splits recurring segments without moving content or identities", () => {
  const text = ":::block a row=r\nA\n:::block b row=r\n![photo](/image.png)\n:::block c\nC\n:::block d row=r\nD\n:::block e row=r\nE\n:::block f row=s\nF\n:::block g row=r\nG";
  const blocks = parseReadingBlocks(text, ["a", "photo", "c", "d", "e", "f", "g"]);
  const normalized = normalizeReadingRows(blocks);
  assert.equal(normalized[0]!.rowId, "r");
  assert.equal(normalized[1]!.rowId, "r");
  assert.equal(normalized[2]!.rowId, undefined);
  assert.notEqual(normalized[3]!.rowId, "r");
  assert.equal(normalized[3]!.rowId, normalized[4]!.rowId);
  assert.equal(normalized[5]!.rowId, "s");
  assert.notEqual(normalized[6]!.rowId, normalized[3]!.rowId);
  assert.notEqual(normalized[6]!.rowId, "r");
  assert.deepEqual(normalizeReadingRows(normalized), normalized);
  assert.deepEqual(normalized.map(({ rowId: _rowId, ...block }) => block), blocks.map(({ rowId: _rowId, ...block }) => block));
  assert.deepEqual(normalizeReadingRows([blocks[0]!, blocks[2]!, blocks[1]!]).map((block) => block.paragraphIds), [["a"], ["c"], ["photo"]]);
  const reordered = normalizeReadingRows([blocks[0]!, blocks[2]!, blocks[1]!]);
  assert.notEqual(reordered[2]!.rowId, "r");
  assert.equal(reordered[2]!.text, "![photo](/image.png)");
  const deleted = normalizeReadingRows(normalized.filter((block) => block.id !== "c"));
  assert.notEqual(deleted[1]!.rowId, deleted[2]!.rowId);
});

test("splitting inherits rows and joining keeps the preceding row without losing images or IDs", () => {
  const block = parseReadingBlocks(":::block a row=r\nA\n![photo](/image.png)\nB", ["a", "photo", "b"])[0]!;
  const split = normalizeReadingRows(splitReadingBlock(block, block.text.indexOf("!["))!);
  assert.deepEqual(split.map((item) => item.rowId), ["r", "r"]);
  assert.equal(split[0]!.id, "a");
  assert.notEqual(split[1]!.id, "a");
  assert.deepEqual(split.flatMap((item) => item.paragraphIds), ["a", "photo", "b"]);
  assert.deepEqual(joinReadingBlocks(split[0]!, { ...split[1]!, rowId: "other" }), block);
  const vertical = { ...split[0]! };
  delete vertical.rowId;
  assert.equal(joinReadingBlocks(vertical, split[1]!).rowId, undefined);
  const following = parseReadingBlocks(":::block c row=other\nC\n:::block d row=r\nD", ["c", "d"]);
  const joined = normalizeReadingRows([joinReadingBlocks(block, following[0]!), following[1]!]);
  assert.deepEqual(joined.map((item) => item.rowId), ["r", "r"]);
  assert.deepEqual(joined.flatMap((item) => item.paragraphIds), ["a", "photo", "b", "c", "d"]);
  const html = buildOcrPreviewHtml(serializeReadingBlocks(joined))!;
  assert.equal(stabilizeEmbeddedImages(buildEditableTextFromHtmlContent(html)!, html), serializeReadingBlocks(joined));
});
