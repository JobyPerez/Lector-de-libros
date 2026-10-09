import assert from "node:assert/strict";
import { test } from "node:test";

import { filterTocByMaxLevel, parseTocMaxLevel } from "../src/app/toc-level";
import { groupPagesByOutline } from "../src/features/book-pages/outline-groups";
import type { BookOutlineEntry } from "../src/app/api";

test("parseTocMaxLevel defaults to T2 and clamps to T1-T3", () => {
  assert.equal(parseTocMaxLevel(1), 1);
  assert.equal(parseTocMaxLevel(2), 2);
  assert.equal(parseTocMaxLevel(3), 3);
  assert.equal(parseTocMaxLevel(4), 2);
  assert.equal(parseTocMaxLevel(0), 2);
  assert.equal(parseTocMaxLevel("3"), 3);
  assert.equal(parseTocMaxLevel("oops"), 2);
  assert.equal(parseTocMaxLevel(null), 2);
});

test("filterTocByMaxLevel hides deeper levels including explicit T4+", () => {
  const items = [{ level: 1 }, { level: 2 }, { level: 3 }, { level: 4 }, { level: 6 }];
  assert.deepEqual(filterTocByMaxLevel(items, 1).map((item) => item.level), [1]);
  assert.deepEqual(filterTocByMaxLevel(items, 2).map((item) => item.level), [1, 2]);
  assert.deepEqual(filterTocByMaxLevel(items, 3).map((item) => item.level), [1, 2, 3]);
});

test("gallery grouping on filtered outline keeps every page exactly once", () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({ pageId: `p${index + 1}`, pageNumber: index + 1 }));
  const outline: BookOutlineEntry[] = [
    { beginsPageContent: true, chapterId: "t1", isGenerated: true, level: 1, pageNumber: 1, paragraphNumber: 1, sequenceNumber: 1, title: "T1" },
    { beginsPageContent: true, chapterId: "t2", isGenerated: true, level: 2, pageNumber: 2, paragraphNumber: 1, sequenceNumber: 2, title: "T2" },
    { beginsPageContent: true, chapterId: "t3", isGenerated: true, level: 3, pageNumber: 3, paragraphNumber: 1, sequenceNumber: 3, title: "T3" },
    { beginsPageContent: true, chapterId: "t4", isGenerated: true, level: 4, pageNumber: 4, paragraphNumber: 1, sequenceNumber: 4, title: "T4" }
  ];
  for (const max of [1, 2, 3] as const) {
    const roots = groupPagesByOutline(pages, filterTocByMaxLevel(outline, max));
    const seen = roots.flatMap(function collect(node): string[] {
      return [...node.groups.flatMap((group) => group.pageIds), ...node.children.flatMap(collect)];
    });
    assert.deepEqual([...seen].sort(), pages.map((page) => page.pageId).sort());
    const levels = roots.flatMap(function collectLevels(node): number[] {
      return [...node.headings.map((heading) => heading.level), ...node.children.flatMap(collectLevels)];
    });
    assert.ok(levels.every((level) => level <= max));
  }
});
