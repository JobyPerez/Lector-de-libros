import assert from "node:assert/strict";
import { test } from "node:test";
import { groupPagesByOutline, type GalleryOutlineNode } from "../src/features/book-pages/outline-groups";
import type { BookOutlineEntry } from "../src/app/api";

const pages = Array.from({ length: 10 }, (_, index) => ({ pageId: `page-${index + 1}`, pageNumber: index + 1 }));
const title = (chapterId: string, level: number, pageNumber: number, beginsPageContent = true, paragraphNumber = 1): BookOutlineEntry => ({ chapterId, level, pageNumber, paragraphNumber, beginsPageContent, title: chapterId });
const cards = (nodes: GalleryOutlineNode[]): string[] => nodes.flatMap((node) => [...node.groups.flatMap((group) => group.pageIds), ...cards(node.children)]);
const headings = (node: GalleryOutlineNode[]): BookOutlineEntry[] => node.flatMap((entry) => [...entry.headings, ...headings(entry.children)]);

test("empty outline and preamble retain all pages exactly once", () => {
  const empty = groupPagesByOutline(pages, []);
  assert.equal(empty[0]!.heading, null);
  assert.deepEqual(empty[0]!.headings, []);
  assert.deepEqual(cards(empty), pages.map((page) => page.pageId));
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 3)]);
  assert.deepEqual(roots[0]!.groups[0]!.pageIds, ["page-1", "page-2"]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("parent and only child with equal footprints flatten with original heading levels", () => {
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 2), title("section", 2, 2, false, 4)]);
  const chapter = roots[1]!;
  assert.equal(chapter.heading!.chapterId, "chapter");
  assert.deepEqual(chapter.headings.map((heading) => [heading.chapterId, heading.level]), [["chapter", 1], ["section", 2]]);
  assert.deepEqual(chapter.children, []);
  assert.deepEqual(chapter.groups[0]!.pageIds, pages.slice(1).map((page) => page.pageId));
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("page 8 starts new sibling section after peripheral blocks, never under the old branch", () => {
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 1), title("definitions", 2, 2), title("interpretations", 3, 4), title("sources", 2, 8, true, 3), title("typology", 3, 8, false, 4)]);
  const chapter = roots[0]!;
  assert.deepEqual(chapter.children.map((node) => node.id), ["definitions", "sources"]);
  assert.deepEqual(cards([chapter.children[0]!]), ["page-2", "page-3", "page-4", "page-5", "page-6", "page-7"]);
  assert.deepEqual(chapter.children[0]!.sharedPageIds, []);
  const sources = chapter.children[1]!;
  assert.deepEqual(sources.headings.map((heading) => heading.chapterId), ["sources", "typology"]);
  assert.deepEqual(sources.children, []);
  assert.deepEqual(sources.groups[0]!.pageIds, ["page-8", "page-9", "page-10"]);
  assert.deepEqual(sources.groups[0]!.sharedHeadings, []);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("genuine continuation retains membership while the single card lives in the new section", () => {
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 1), title("old", 2, 2), title("new", 2, 8, false, 5)]);
  const [oldSection, newSection] = roots[0]!.children;
  assert.deepEqual(oldSection!.sharedPageIds, ["page-8"]);
  assert.deepEqual(newSection!.groups[0]!.pageIds, ["page-8"]);
  assert.deepEqual(newSection!.groups[0]!.sharedHeadings.map((heading) => heading.chapterId), ["old", "new"]);
  assert.deepEqual(newSection!.groups[1]!.pageIds, ["page-9", "page-10"]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("equal-footprint siblings compact and old-only-shared headings are covered by the owner", () => {
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 1), title("a", 2, 2), title("b", 2, 2, false, 4), title("c", 2, 2, false, 6)]);
  assert.deepEqual(roots[0]!.children.map((node) => node.id), ["c"]);
  assert.deepEqual(roots[0]!.children[0]!.groups[0]!.sharedHeadings.map((heading) => heading.chapterId), ["a", "b", "c"]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("skipped levels and changed page order use current positions without mutating inputs", () => {
  const reversed = [...pages].reverse();
  const outline = [title("last", 2, 8), title("first", 1, 1), title("deep", 4, 4)];
  const before = structuredClone({ pages: reversed, outline });
  const roots = groupPagesByOutline(reversed, outline);
  assert.deepEqual(roots[0]!.children.map((node) => node.id), ["deep", "last"]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
  assert.equal(reversed[0]!.pageId, "page-10");
  assert.deepEqual({ pages: reversed, outline }, before);
});

test("page 32 titles compact siblings before flattening the parent into a single card cluster", () => {
  const outline = [
    title("old", 2, 32),
    title("iberians", 2, 32, false, 2),
    title("strabon", 3, 32, false, 3),
    title("elche", 3, 32, false, 4),
    title("baza", 3, 32, false, 5)
  ];
  const roots = groupPagesByOutline([{ pageId: "page-32", pageNumber: 32 }], outline);
  assert.equal(roots.length, 1);
  assert.equal(roots[0]!.heading, outline[0]);
  assert.deepEqual(roots[0]!.headings, outline);
  assert.deepEqual(roots[0]!.headings.map((heading) => heading.level), [2, 2, 3, 3, 3]);
  assert.deepEqual(roots[0]!.children, []);
  assert.deepEqual(roots[0]!.sharedPageIds, ["page-32"]);
  assert.deepEqual(cards(roots), ["page-32"]);
});

test("continuing pages 1-7 and new page 8 followed by 9-10 preserve independent branches", () => {
  const roots = groupPagesByOutline(pages, [title("old", 2, 1), title("new", 2, 8, false, 3), title("child", 3, 8, false, 4)]);
  assert.deepEqual(roots.map((node) => node.id), ["old", "new"]);
  assert.deepEqual(roots[0]!.headings.map((heading) => heading.chapterId), ["old"]);
  assert.deepEqual(roots[0]!.sharedPageIds, ["page-8"]);
  assert.deepEqual(cards([roots[0]!]), pages.slice(0, 7).map((page) => page.pageId));
  assert.deepEqual(roots[1]!.headings.map((heading) => heading.chapterId), ["new", "child"]);
  assert.deepEqual(roots[1]!.groups.map((group) => group.pageIds), [["page-8"], ["page-9", "page-10"]]);
  assert.deepEqual(roots[1]!.groups[0]!.sharedHeadings.map((heading) => heading.chapterId), ["old", "child"]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("no-card scopes are pruned only when actual shared metadata covers their headings", () => {
  const outline = [title("old", 1, 1), title("old-child", 2, 1, false, 2), title("new", 1, 1, false, 3)];
  const roots = groupPagesByOutline(pages, outline);
  assert.deepEqual(roots.map((node) => node.id), ["new"]);
  assert.deepEqual(roots[0]!.groups[0]!.sharedHeadings, outline);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));

  // The parent is active at page 2, so it is not in the new owner's shared metadata.
  const uncovered = [title("parent", 1, 1), title("old", 2, 1, false, 2), title("new", 2, 2, false)];
  const retained = groupPagesByOutline(pages, uncovered);
  assert.equal(retained[0]!.heading, uncovered[0]);
  assert.ok(headings(retained).includes(uncovered[0]!));
  assert.deepEqual(cards(retained), pages.map((page) => page.pageId));
});

test("normal branches with different footprints remain separate", () => {
  const roots = groupPagesByOutline(pages, [title("chapter", 1, 1), title("a", 2, 2), title("b", 2, 5), title("c", 2, 8)]);
  assert.deepEqual(roots[0]!.children.map((node) => node.headings.map((heading) => heading.chapterId)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(roots[0]!.children.map((node) => cards([node])), [["page-2", "page-3", "page-4"], ["page-5", "page-6", "page-7"], ["page-8", "page-9", "page-10"]]);
  assert.deepEqual(cards(roots), pages.map((page) => page.pageId));
});

test("page and title permutations compact in chronological order without mutating frozen inputs", () => {
  const chronological = [title("chapter", 1, 1), title("old", 2, 2), title("new", 2, 8, false, 3), title("child-a", 3, 8, false, 4), title("child-b", 3, 8, false, 5)];
  const permuted = [chronological[4]!, chronological[1]!, chronological[3]!, chronological[0]!, chronological[2]!];
  const reordered = [pages[9]!, ...pages.slice(0, 9).reverse()];
  for (const heading of permuted) Object.freeze(heading);
  for (const page of reordered) Object.freeze(page);
  Object.freeze(permuted);
  Object.freeze(reordered);
  assert.deepEqual(groupPagesByOutline(reordered, permuted), groupPagesByOutline(pages, chronological));
  assert.deepEqual(cards(groupPagesByOutline(reordered, permuted)), pages.map((page) => page.pageId));
});
