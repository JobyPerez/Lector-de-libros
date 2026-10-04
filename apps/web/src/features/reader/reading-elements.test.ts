import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { ParagraphContent } from "../../app/api";
import { applyReadingElementLayout, buildAudioBlockTimings, findReadableParagraph, isReadable, nextAudioCursor, readingRowLayout } from "./reading-elements";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const paragraph = (sequenceNumber: number, readAloud?: boolean): ParagraphContent => ({
  paragraphId: `p-${sequenceNumber}`, paragraphNumber: sequenceNumber, sequenceNumber,
  paragraphText: "Text", characterCount: 4, wordCount: 1,
  ...(readAloud === undefined ? {} : { readAloud })
});

test("legacy flags remain readable and excluded paragraphs remain selectable data", () => {
  assert.equal(isReadable(paragraph(1)), true);
  assert.equal(isReadable(paragraph(2, false)), false);
  assert.equal(isReadable({ ...paragraph(3), paragraphText: "  " }), false);
});

test("selection advances within the page and across empty/excluded pages in both directions", async () => {
  const pages = [[paragraph(1, false), paragraph(2)], [], [paragraph(3, false)], [paragraph(4), paragraph(5, false)]];
  const visited: number[] = [];
  const load = async (page: number) => { visited.push(page); return pages[page - 1]!; };
  assert.equal((await findReadableParagraph(load, 4, 1, 1, 1, true))?.paragraph.sequenceNumber, 2);
  assert.equal((await findReadableParagraph(load, 4, 1, 2))?.pageNumber, 4);
  assert.equal((await findReadableParagraph(load, 4, 4, 4, -1))?.paragraph.sequenceNumber, 2);
  assert.equal((await findReadableParagraph(load, 4, 2, Number.MAX_SAFE_INTEGER, -1))?.paragraph.sequenceNumber, 2);
  visited.length = 0;
  assert.equal(await findReadableParagraph(load, 4, 4, 4), null);
  assert.deepEqual(visited, [4]);
});

test("no-readable EOS scans each page only once and never loops", async () => {
  const visited: number[] = [];
  assert.equal(await findReadableParagraph(async (page) => {
    visited.push(page);
    return page % 2 ? [paragraph(page, false)] : [];
  }, 6, 1, 0, 1, true), null);
  assert.deepEqual(visited, [1, 2, 3, 4, 5, 6]);
});

test("response cursors drive jumps, legacy uses actual last sequence, null is EOF", () => {
  const paragraphs = [{ sequenceNumber: 2 }, { sequenceNumber: 9 }];
  assert.equal(nextAudioCursor({ paragraphs, nextSequenceNumber: 17 }), 17);
  assert.equal(nextAudioCursor({ paragraphs }), 10);
  assert.equal(nextAudioCursor({ paragraphs, nextSequenceNumber: null }), null);
  assert.equal(nextAudioCursor({ paragraphs: [] }), null);
  const starts: number[] = [];
  let cursor: number | null = 2;
  for (const block of [{ paragraphs, nextSequenceNumber: 17 }, { paragraphs: [{ sequenceNumber: 20 }], nextSequenceNumber: null }]) {
    if (cursor === null) break;
    starts.push(cursor);
    cursor = nextAudioCursor(block);
  }
  assert.deepEqual(starts, [2, 17]);
});

test("timings retain only actual sequences across pages, not numeric spans", () => {
  const actual = [2, 9, 17].map((sequenceNumber, index) => ({
    sequenceNumber, paragraphId: `p-${sequenceNumber}`, paragraphNumber: index + 1,
    pageNumber: index + 1, textLength: 100, durationMs: (index + 1) * 1000
  }));
  const timings = buildAudioBlockTimings(actual, Number.NaN);
  assert.deepEqual(timings.map(({ sequenceNumber, startMs, endMs }) => ({ sequenceNumber, startMs, endMs })), [
    { sequenceNumber: 2, startMs: 0, endMs: 1000 },
    { sequenceNumber: 9, startMs: 1000, endMs: 3000 },
    { sequenceNumber: 17, startMs: 3000, endMs: 6000 }
  ]);
  assert.equal(timings.find((timing) => 1500 < timing.endMs)?.sequenceNumber, 9);
  assert.deepEqual(buildAudioBlockTimings([], 0), []);
  const legacy = buildAudioBlockTimings(actual.map(({ durationMs, ...rest }) => rest), 9000);
  assert.deepEqual(legacy.map((timing) => timing.endMs), [3000, 6000, 9000]);
});

test("row weights and gaps are normalized, finite and scale invariant; legacy falls back", () => {
  const boxes = [{ left: 10, top: 0, width: 20, height: 50 }, { left: 35, top: 0, width: 60, height: 50 }];
  const layout = readingRowLayout(boxes)!;
  assert.ok(layout.columns.includes(`${20 / 85}fr`));
  assert.equal(layout.gap, 5 / 85);
  assert.deepEqual(readingRowLayout(boxes.map((box) => ({ left: box.left * 10, top: 0, width: box.width * 10, height: 500 }))), layout);
  assert.equal(readingRowLayout([null]), null);
  assert.equal(readingRowLayout([{ ...boxes[0]!, width: NaN }]), null);
  assert.equal(readingRowLayout([{ ...boxes[0]!, width: 0 }]), null);
});

test("layout preserves excluded content and annotations, ignores peripheral geometry for body weights", () => {
  const document = new JSDOM(`<div class="reader-reading-row"><section class="reader-reading-block"><p data-paragraph-number="1">Header</p><p data-paragraph-number="2"><span data-highlight-id="h">Body</span></p></section><section class="reader-reading-block"><p data-paragraph-number="3">Image</p></section></div>`).window.document as Document;
  const box = (left: number, width: number) => ({ bbox: { left, top: 0, width, height: 50 } });
  applyReadingElementLayout(document, [
    { ...paragraph(1, false), role: "header", geometry: box(0, 100) },
    { ...paragraph(2), geometry: box(10, 20) },
    { ...paragraph(3), role: "image", geometry: box(35, 60) }
  ]);
  assert.equal(document.querySelectorAll("[data-paragraph-number]").length, 3);
  assert.equal(document.querySelector('[data-paragraph-number="1"]')?.getAttribute("data-read-aloud"), "false");
  assert.equal(document.querySelector('[data-paragraph-number="2"]')?.getAttribute("data-read-aloud"), "true");
  assert.equal(document.querySelector("[data-highlight-id]")?.textContent, "Body");
  assert.equal((document.querySelector(".reader-reading-row") as HTMLElement).style.getPropertyValue("--reader-row-columns"), readingRowLayout([box(10, 20).bbox, box(35, 60).bbox])?.columns);
});
