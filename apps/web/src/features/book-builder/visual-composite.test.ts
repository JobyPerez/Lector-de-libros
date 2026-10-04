import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { VisualCompositeContent, VisualPageDocument } from "../../app/api";
import { appendVisualBlock, applyVisualPreset, compositeForBlock, createVisualBlock, flattenVisualLayout, importedVisualSourceHtml, mergeVisualBlocks, moveVisualNode, normalizeVisualDocument, orderedVisualBlocks, pushVisualHistory, redoVisualHistory, renderVisualCompositeHtml, renderVisualPreviewHtml, reorderVisualBlock, separateVisualContent, undoVisualHistory, ungroupVisualNode, updateVisualBlock, updateVisualNode, visualDocumentSaveError, visualUnits } from "./visual-page";
import type { BookPageResponse } from "../../app/api";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { window } = new JSDOM("");
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node, Element: window.Element });
const title: VisualCompositeContent = { kind: "heading", separator: "space", includeInToc: true, headingLevel: 1, alignment: "center", fontScale: 1.2 };
const body: VisualCompositeContent = { kind: "text", separator: "paragraph", includeInToc: false };

function document(): VisualPageDocument {
  const blocks = Array.from({ length: 6 }, (_, index) => ({ ...createVisualBlock(index === 1 ? "heading" : "text"), id: `paragraph-${index + 1}`, text: index === 0 ? "**Titulo**" : `Texto ${index + 1}`, sourceKey: `paragraph:${index}`, readAloud: index % 2 === 0, alignment: "right" as const, fontScale: 1.1, geometry: { bbox: { left: .1, top: index / 10, width: .3, height: .1 } } }));
  return { version: 1, blocks, layout: { id: "root", type: "column", children: blocks.map((block, index) => ({ id: `leaf-${index + 1}`, type: "block", blockId: block.id })) } };
}

function nestedDocument(): VisualPageDocument {
  const doc = document();
  assert.ok(doc.layout.type !== "block");
  const leaves = doc.layout.children;
  return { ...doc, layout: { id: "root", type: "column", gap: 8, weights: [9], children: [
    { id: "row", type: "row", gap: 16, weights: [2, 3], children: [
      { id: "left", type: "column", gap: 4, weights: [2, 8, 3, 4], children: [leaves[0]!, { id: "editable-slot", type: "column", children: [] }, ...leaves.slice(1, 3)] },
      { id: "right-wrapper", type: "column", weights: [11], children: [
        { id: "right", type: "column", gap: 7, weights: [5, 6, 7], children: leaves.slice(3) },
      ] },
    ] },
  ] } };
}
const ids = (doc: VisualPageDocument) => orderedVisualBlocks(doc).map((block) => block.id);
const parse = (doc: VisualPageDocument, includeInactive = false) => new window.DOMParser().parseFromString(renderVisualPreviewHtml(doc, includeInactive), "text/html");
function checkAtoms(before: VisualPageDocument, after: VisualPageDocument) {
  assert.deepEqual(after.blocks, before.blocks);
  assert.deepEqual(flattenVisualLayout(after.layout).filter((node) => node.type === "block").sort((a, b) => a.id.localeCompare(b.id)), flattenVisualLayout(before.layout).filter((node) => node.type === "block").sort((a, b) => a.id.localeCompare(b.id)));
  const nodes = flattenVisualLayout(after.layout);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
}

test("001: two title segments have exactly one h1 footprint and retain both child IDs", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, [doc.blocks[1]!.id, doc.blocks[0]!.id], title);
  const composite = compositeForBlock(merged, doc.blocks[0]!.id)!;
  assert.match(composite.id, /^[0-9a-f-]{36}$/);
  assert.equal(composite.type, "column");
  assert.deepEqual(composite.content, { ...title, origins: [
    { leafId: "leaf-1", parentId: "root", index: 0 },
    { leafId: "leaf-2", parentId: "root", index: 1 },
  ] });
  checkAtoms(doc, merged);
  assert.deepEqual(ids(merged), ids(doc));
  const html = parse(merged);
  assert.equal(html.querySelectorAll("h1").length, 1);
  assert.equal(html.querySelectorAll("h1 span[data-visual-block-id]").length, 2);
  assert.equal(html.querySelector("h1")?.textContent, "Titulo Texto 2");
  assert.equal(html.querySelector("h1 strong")?.textContent, "Titulo");
  assert.equal(html.querySelector("h1")?.style.textAlign, "center");
  assert.equal(visualUnits(merged).length, 5);
  assert.equal(visualUnits(merged)[0], composite);
  assert.equal(visualDocumentSaveError(merged), null);
});

test("body paragraphs 3/4/5 stay actual paragraphs with original IDs and flags", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 5), body);
  const html = parse(merged);
  const paragraphs = html.querySelectorAll("[data-visual-composite-id] p");
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(Array.from(paragraphs, (p: Element) => p.getAttribute("data-visual-block-id")), ids(doc).slice(2, 5));
  assert.equal(html.querySelectorAll("[data-visual-composite-id] [data-visual-block-id]").length, 3);
  assert.equal(html.querySelectorAll("[data-visual-composite-id] p p").length, 0);
  assert.deepEqual(Array.from(paragraphs, (p: Element) => p.textContent), ["Texto 3", "Texto 4", "Texto 5"]);
  checkAtoms(doc, merged);
  assert.equal(merged.blocks, doc.blocks);
});

test("merge rejects images, inactive selections, inactive DFS gaps, nonconsecutive and invalid IDs", () => {
  const doc = document();
  for (const selection of [[], [ids(doc)[0]!], [ids(doc)[0]!, ids(doc)[0]!], [ids(doc)[0]!, "missing"], [ids(doc)[0]!, ids(doc)[2]!]]) assert.throws(() => mergeVisualBlocks(doc, selection, title), /Selecciona|activos|consecutivos/);
  const image = updateVisualBlock(doc, ids(doc)[1]!, { kind: "image" });
  assert.throws(() => mergeVisualBlocks(image, ids(doc).slice(0, 2), title), /imagenes/);
  const inactive = updateVisualBlock(doc, ids(doc)[1]!, { active: false });
  assert.throws(() => mergeVisualBlocks(inactive, ids(doc).slice(0, 2), title), /activos/);
  assert.throws(() => mergeVisualBlocks(inactive, [ids(doc)[0]!, ids(doc)[2]!], title), /incluidos los inactivos/);
});

test("cross-column merge retains full DFS order, leaf geometry and empty editable slots", () => {
  const doc = applyVisualPreset(document(), "two-columns");
  assert.ok(doc.layout.type !== "block");
  const left = doc.layout.children[0]!;
  const right = doc.layout.children[1]!;
  assert.ok(left.type !== "block" && right.type !== "block");
  left.weights = [2, 3, 4];
  right.weights = [5, 6, 7];
  const snapshot = JSON.stringify(doc);
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  assert.equal(JSON.stringify(doc), snapshot);
  checkAtoms(doc, merged);
  assert.deepEqual(ids(merged), ids(doc));
  const nodes = flattenVisualLayout(merged.layout);
  const empty = nodes.find((node) => node.id === right.id)!;
  assert.ok(empty.type !== "block");
  assert.deepEqual(empty.children, []);
  assert.deepEqual(empty.weights, []);
  const parent = nodes.find((node) => node.id === left.id)!;
  assert.ok(parent.type !== "block");
  assert.equal(parent.children[2]!.id, compositeForBlock(merged, ids(doc)[2]!)!.id);
  assert.deepEqual(parent.weights, [2, 3, 4]);
  const composite = compositeForBlock(merged, ids(doc)[2]!)!;
  assert.deepEqual(composite.content!.origins, [
    { leafId: "leaf-3", parentId: left.id, index: 2, weight: 4 },
    { leafId: "leaf-4", parentId: right.id, index: 0, weight: 5 },
    { leafId: "leaf-5", parentId: right.id, index: 1, weight: 6 },
    { leafId: "leaf-6", parentId: right.id, index: 2, weight: 7 },
  ]);
  assert.deepEqual(separateVisualContent(JSON.parse(JSON.stringify(merged)), composite.id), doc);
});

test("separation after JSON reload and plain ungroup restore all atom formatting and flags", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 3), title);
  const reloaded: VisualPageDocument = JSON.parse(JSON.stringify(merged));
  const id = compositeForBlock(reloaded, ids(doc)[0]!)!.id;
  const separated = separateVisualContent(reloaded, id);
  assert.deepEqual(separated, doc);
  assert.deepEqual(ungroupVisualNode(reloaded, id), doc);
  assert.equal(compositeForBlock(separated, ids(doc)[0]!), undefined);
  assert.equal(separateVisualContent(doc, "root"), doc);
  assert.throws(() => mergeVisualBlocks(merged, ids(doc).slice(0, 2), title), /Separa primero/);
  assert.doesNotThrow(() => mergeVisualBlocks(separated, ids(doc).slice(0, 2), body));
});

test("root composite separates into an ordinary column preserving children, IDs and source anchors", () => {
  const original = document();
  const merged = mergeVisualBlocks(original, ids(original), body);
  const root = compositeForBlock(merged, ids(original)[0]!)!;
  const doc = { ...merged, layout: root };
  const separated = separateVisualContent(JSON.parse(JSON.stringify(doc)), root.id);
  assert.ok(separated.layout.type !== "block");
  assert.equal(separated.layout.id, root.id);
  assert.equal(separated.layout.type, "column");
  assert.equal(separated.layout.content, undefined);
  checkAtoms(original, separated);
  assert.deepEqual(separated.layout.children, root.children);
  const source = importedVisualSourceHtml({ paragraphs: [], htmlContent: null } as unknown as BookPageResponse["page"], doc);
  for (const id of ids(original)) assert.ok(source.includes(`data-paragraph-id="${id}"`));
});

test("normalization and append do not put unrelated blocks inside a root composite", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc), body);
  const composite = compositeForBlock(merged, ids(doc)[0]!)!;
  const rootDoc = { ...merged, layout: composite };
  assert.deepEqual(normalizeVisualDocument(rootDoc).layout, { ...composite, gap: 12 });
  const appended = appendVisualBlock(rootDoc, createVisualBlock("text"));
  assert.ok(appended.layout.type !== "block");
  assert.equal(appended.layout.content, undefined);
  assert.deepEqual(appended.layout.children[0], { ...composite, gap: 12 });
  assert.deepEqual(orderedVisualBlocks(appended).slice(0, 6), rootDoc.blocks);
  assert.equal(visualUnits(appended).length, 2);
  assert.equal(compositeForBlock(appended, ids(doc)[0]!)!.children.length, 6);
});

test("child edits and mixed read/active flags preserve composite metadata and filter preview", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 2), title);
  const composite = compositeForBlock(merged, ids(doc)[0]!)!;
  const edited = updateVisualBlock(merged, ids(doc)[0]!, { text: "*Editado*", readAloud: false, active: false });
  assert.equal(compositeForBlock(edited, ids(doc)[0]!), composite);
  assert.equal(edited.blocks[1], doc.blocks[1]);
  assert.equal(parse(edited).querySelectorAll("h1 span").length, 1);
  assert.equal(parse(edited, true).querySelectorAll("h1 span").length, 2);
  assert.equal(updateVisualBlock(edited, ids(doc)[0]!, { kind: "image" }), edited);
  const inactive = updateVisualBlock(edited, ids(doc)[1]!, { active: false });
  assert.equal(visualUnits(inactive).length, 5);
  assert.equal(visualUnits(inactive, false).length, 4);
  assert.equal(parse(inactive).querySelectorAll("h1").length, 0);
});

test("space, line and paragraph separators render safely with exactly one heading", () => {
  const doc = document();
  doc.blocks[0]!.text = '<script>alert(1)</script> **A**\nB';
  for (const separator of ["space", "line", "paragraph"] as const) {
    const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 2), { ...title, separator });
    const html = parse(merged);
    assert.equal(html.querySelectorAll("script").length, 0);
    assert.equal(html.querySelectorAll("h1").length, 1);
    assert.equal(html.querySelectorAll("h1 br").length, separator === "space" ? 1 : separator === "line" ? 2 : 3);
    assert.equal(renderVisualCompositeHtml(compositeForBlock(merged, ids(doc)[0]!)!, merged.blocks), html.querySelector("h1")!.outerHTML.replace(/<br>/g, "<br />"));
  }
});

test("all presets balance opaque units without changing DFS narrative order", () => {
  const doc = mergeVisualBlocks(document(), ["paragraph-2", "paragraph-3"], title);
  const composite = compositeForBlock(doc, "paragraph-2")!;
  for (const preset of ["one-column", "two-columns", "two-by-two", "rows"] as const) {
    const result = applyVisualPreset(doc, preset);
    checkAtoms(doc, result);
    assert.deepEqual(ids(result), ids(doc));
    assert.deepEqual(visualUnits(result), visualUnits(doc));
    assert.equal(compositeForBlock(result, "paragraph-2"), composite);
    assert.equal(visualDocumentSaveError(result), null);
    if (preset === "two-columns") {
      assert.ok(result.layout.type !== "block");
      assert.equal(flattenVisualLayout(result.layout.children[0]!).filter((node) => visualUnits(doc).includes(node)).length, 3);
    }
  }
});

test("move guards reject leaf extraction/insertion and allow moving the whole unit", () => {
  const doc = applyVisualPreset(mergeVisualBlocks(document(), ["paragraph-2", "paragraph-3"], title), "two-columns");
  const composite = compositeForBlock(doc, "paragraph-2")!;
  assert.ok(doc.layout.type !== "block");
  const right = doc.layout.children[1]!;
  assert.ok(right.type !== "block");
  assert.equal(moveVisualNode(doc, composite.children[0]!.id, right.id, 0), doc);
  assert.equal(moveVisualNode(doc, right.children[0]!.id, composite.id, 0), doc);
  assert.equal(moveVisualNode(doc, right.id, composite.id, 0), doc);
  const moved = moveVisualNode(doc, composite.id, right.id, 0);
  assert.deepEqual(ids(moved), ["paragraph-1", "paragraph-4", "paragraph-2", "paragraph-3", "paragraph-5", "paragraph-6"]);
  checkAtoms(doc, moved);
  assert.equal(compositeForBlock(moved, "paragraph-2"), composite);
});

test("numbering reorders whole composites by unit ordinal, including ordinary blocks", () => {
  const doc = mergeVisualBlocks(document(), ["paragraph-2", "paragraph-3"], title);
  const moved = reorderVisualBlock(doc, "paragraph-3", 5);
  assert.deepEqual(ids(moved), ["paragraph-1", "paragraph-4", "paragraph-5", "paragraph-6", "paragraph-2", "paragraph-3"]);
  assert.deepEqual(ids(reorderVisualBlock(moved, "paragraph-2", 1)), ["paragraph-2", "paragraph-3", "paragraph-1", "paragraph-4", "paragraph-5", "paragraph-6"]);
  assert.deepEqual(ids(reorderVisualBlock(doc, "paragraph-6", 2)), ["paragraph-1", "paragraph-6", "paragraph-2", "paragraph-3", "paragraph-4", "paragraph-5"]);
  checkAtoms(doc, moved);
});

test("composite reshape/direct child insertion are blocked but valid content edits work", () => {
  const doc = mergeVisualBlocks(document(), ["paragraph-1", "paragraph-2"], title);
  const composite = compositeForBlock(doc, "paragraph-1")!;
  for (const update of [
    (node: typeof composite) => ({ ...node, type: "row" as const }),
    (node: typeof composite) => ({ ...node, children: [...node.children, { id: "extra", type: "column" as const, children: [] }] }),
    (node: typeof composite) => { const { content: _content, ...next } = node; return next; },
  ]) {
    const layout = updateVisualNode(doc.layout, composite.id, (node) => update(node as typeof composite));
    assert.equal(compositeForBlock({ ...doc, layout }, "paragraph-1"), composite);
  }
  const edited = updateVisualNode(doc.layout, composite.id, (node) => ({ ...node, content: body }));
  assert.deepEqual(compositeForBlock({ ...doc, layout: edited }, "paragraph-1")!.content, { ...body, origins: composite.content!.origins });
  assert.equal(compositeForBlock({ ...doc, layout: edited }, "paragraph-1")!.content!.origins, composite.content!.origins);
  assert.deepEqual(updateVisualNode(doc.layout, composite.children[0]!.id, () => ({ id: "bad", type: "row", children: [] })), doc.layout);
});

test("merge, undo/redo and separation preserve exact documents without mutating history", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 2), title);
  const history = pushVisualHistory({ past: [], present: doc, future: [] }, merged);
  assert.equal(undoVisualHistory(history).present, doc);
  assert.equal(redoVisualHistory(undoVisualHistory(history)).present, merged);
  const separated = separateVisualContent(merged, compositeForBlock(merged, ids(doc)[0]!)!.id);
  assert.deepEqual(separated, doc);
  const next = pushVisualHistory(history, separated);
  assert.equal(undoVisualHistory(next).present, merged);
  assert.equal(redoVisualHistory(undoVisualHistory(next)).present, separated);
});

test("save guard rejects malformed composite metadata, nesting and images", () => {
  const doc = mergeVisualBlocks(document(), ["paragraph-1", "paragraph-2"], title);
  const composite = compositeForBlock(doc, "paragraph-1")!;
  for (const patch of [{ kind: "image" }, { separator: "bad" }, { includeInToc: "yes" }, { headingLevel: 0 }, { headingLevel: 1.5 }, { headingLevel: 7 }, { alignment: "justify" }, { fontScale: 0 }, { fontScale: 0.49 }, { fontScale: 3.01 }, { fontScale: Infinity }, { unknownContent: true }]) {
    const invalid = { ...title, ...patch } as VisualCompositeContent;
    assert.throws(() => mergeVisualBlocks(document(), ["paragraph-1", "paragraph-2"], invalid), /metadatos/);
    const reloaded = JSON.parse(JSON.stringify(doc)) as VisualPageDocument;
    compositeForBlock(reloaded, "paragraph-1")!.content = invalid;
    assert.match(visualDocumentSaveError(reloaded)!, /compuesto/);
  }
  for (const container of [{ ...composite, type: "row" as const }, { ...composite, children: [composite.children[0]!] }, { ...composite, children: [{ id: "nested", type: "column" as const, children: composite.children }] }]) assert.match(visualDocumentSaveError({ ...doc, layout: container })!, /compuesto/);
  const imageDoc = { ...doc, blocks: doc.blocks.map((block, i) => i === 0 ? { ...block, kind: "image" as const } : block) };
  assert.match(visualDocumentSaveError(imageDoc)!, /compuesto/);
});

test("paragraph composites preserve native UL/OL, inline formatting and one ID per atom", () => {
  const doc = document();
  doc.blocks[2]!.text = "- **Uno**\n- *Dos*\n- \\_literal\\_";
  doc.blocks[3]!.text = "1. __Tres__\n2. _Cuatro_";
  doc.blocks[4]!.text = "**A\nB**\n\n\\*literal\\* <script>";
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 5), body);
  const html = parse(merged);
  const composite = html.querySelector("[data-visual-composite-id]")!;
  assert.deepEqual(Array.from(composite.children, (node: Element) => node.tagName), ["UL", "OL", "P"]);
  assert.equal(composite.querySelectorAll("li").length, 5);
  assert.equal(composite.querySelectorAll("strong").length, 3);
  assert.equal(composite.querySelectorAll("em").length, 2);
  assert.equal(composite.querySelectorAll("p p, p ul, p ol, script").length, 0);
  assert.ok(composite.textContent.includes("_literal_"));
  assert.ok(composite.textContent.includes("*literal* <script>"));
  assert.equal(composite.querySelector("p")!.innerHTML, "<strong>A<br>B</strong><br><br>*literal* &lt;script&gt;");
  for (const id of ids(doc)) assert.equal(html.querySelectorAll(`[data-visual-block-id="${id}"]`).length, 1);
  assert.equal(composite.querySelector("ul")!.style.fontSize, "1.1em");
  assert.equal(composite.querySelector("ol")!.style.textAlign, "right");
  checkAtoms(doc, merged);
});

test("heading/space/line composites flatten list items to formatted lines without raw markers", () => {
  const doc = document();
  doc.blocks[2]!.text = "- **Uno**\n- *Dos*\n- \\_literal\\_";
  doc.blocks[3]!.text = "1. __Tres__\n2. _Cuatro_";
  for (const content of [title, { ...title, separator: "line" as const }, { ...title, separator: "paragraph" as const }, { ...body, separator: "space" as const }, { ...body, separator: "line" as const }]) {
    const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 4), content);
    const html = parse(merged);
    const composite = html.querySelector("[data-visual-composite-id]")!;
    assert.equal(composite.querySelectorAll("ul, ol, li").length, 0);
    assert.equal(composite.querySelectorAll("span[data-visual-block-id]").length, 2);
    const first = composite.querySelector('[data-visual-block-id="paragraph-3"]')!;
    assert.equal(first.innerHTML, "<strong>Uno</strong><br><em>Dos</em><br>_literal_");
    assert.equal(composite.querySelector('[data-visual-block-id="paragraph-4"]')!.innerHTML, "<strong>Tres</strong><br><em>Cuatro</em>");
    const plain = new window.DOMParser().parseFromString(first.innerHTML.replace(/<br>/g, "\n"), "text/html").body.textContent;
    assert.equal(plain, "Uno\nDos\n_literal_");
    assert.ok(!composite.textContent.includes("- ") && !composite.textContent.includes("1. "));
    assert.equal(html.querySelectorAll('[data-visual-block-id="paragraph-3"]').length, 1);
    assert.equal(html.querySelectorAll('[data-visual-block-id="paragraph-4"]').length, 1);
    checkAtoms(doc, merged);
  }
});

test("segment fonts/alignment survive independently unless overridden by the common frame", () => {
  const doc = document();
  doc.blocks[2]!.fontScale = .75;
  doc.blocks[2]!.alignment = "left";
  doc.blocks[3]!.fontScale = 1.5;
  doc.blocks[3]!.alignment = "right";
  for (const separator of ["space", "line", "paragraph"] as const) {
    for (const overrides of [{}, { fontScale: 2 }, { alignment: "center" as const }, { fontScale: 2, alignment: "center" as const }]) {
      const content = { ...body, separator, ...overrides };
      const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 4), content);
      const composite = parse(merged).querySelector("[data-visual-composite-id]")!;
      assert.equal(composite.style.fontSize, content.fontScale === undefined ? "" : "2em");
      assert.equal(composite.style.textAlign, content.alignment ?? "");
      for (const block of doc.blocks.slice(2, 4)) {
        const segment = composite.querySelector(`[data-visual-block-id="${block.id}"]`)!;
        assert.equal(segment.style.fontSize, content.fontScale === undefined ? `${block.fontScale}em` : "");
        assert.equal(segment.style.textAlign, content.alignment === undefined ? block.alignment : "");
      }
      checkAtoms(doc, merged);
    }
  }
});

test("legacy composite headings default to h2 while explicit levels stay unchanged", () => {
  const doc = document();
  const { headingLevel: _level, ...legacyTitle } = title;
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 4), legacyTitle);
  assert.equal(parse(merged).querySelectorAll("h2[data-visual-composite-id]").length, 1);
  assert.equal(parse(merged).querySelectorAll("h1[data-visual-composite-id]").length, 0);
  for (const headingLevel of [1, 3, 6]) {
    const explicit = mergeVisualBlocks(doc, ids(doc).slice(2, 4), { ...legacyTitle, headingLevel });
    assert.equal(parse(explicit).querySelectorAll(`h${headingLevel}[data-visual-composite-id]`).length, 1);
  }
});

test("composite font bounds are inclusive and malformed root content is rejected", () => {
  const doc = document();
  for (const fontScale of [.5, 3]) {
    const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 4), { ...body, fontScale });
    assert.equal(visualDocumentSaveError(merged), null);
  }
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2, 4), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  for (const content of [null, {}, [], { ...body, extra: "unknown" }, { ...body, fontScale: "1" }]) {
    const root = { ...composite, content: content as unknown as VisualCompositeContent };
    assert.match(visualDocumentSaveError({ ...merged, layout: root })!, /compuesto/);
    assert.equal(renderVisualCompositeHtml(root, merged.blocks), "");
  }
});

test("nested weighted cross-column separation restores the exact original tree after JSON reload", () => {
  const doc = nestedDocument();
  const original = JSON.stringify(doc);
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  assert.deepEqual(composite.content!.origins, [
    { leafId: "leaf-3", parentId: "left", index: 3, weight: 4 },
    { leafId: "leaf-4", parentId: "right", index: 0, weight: 5 },
    { leafId: "leaf-5", parentId: "right", index: 1, weight: 6 },
    { leafId: "leaf-6", parentId: "right", index: 2, weight: 7 },
  ]);
  const empty = flattenVisualLayout(merged.layout).find((node) => node.id === "right")!;
  assert.ok(empty.type !== "block");
  assert.deepEqual(empty.children, []);
  assert.deepEqual(empty.weights, []);
  assert.equal(visualDocumentSaveError(merged), null);
  const reloaded: VisualPageDocument = JSON.parse(JSON.stringify(merged));
  const separated = separateVisualContent(reloaded, composite.id);
  assert.deepEqual(separated, doc);
  assert.deepEqual(ungroupVisualNode(reloaded, composite.id), doc);
  checkAtoms(doc, separated);
  assert.equal(JSON.stringify(doc), original);
  assert.equal(merged.version, 1);
  assert.deepEqual(Object.keys(composite.content!).sort(), ["includeInToc", "kind", "origins", "separator"]);
});

test("weighted sibling separation restores each weight without distributing the first weight", () => {
  const doc = document();
  assert.ok(doc.layout.type !== "block");
  doc.layout.weights = [2, 3, 5, 7, 11, 13];
  const merged = mergeVisualBlocks(doc, ids(doc).slice(1, 5), title);
  const composite = compositeForBlock(merged, "paragraph-2")!;
  assert.deepEqual(separateVisualContent(JSON.parse(JSON.stringify(merged)), composite.id), doc);
});

test("mixed weighted/unweighted parents retain optional weights exactly on restoration", () => {
  const doc = nestedDocument();
  const right = flattenVisualLayout(doc.layout).find((node) => node.id === "right")!;
  assert.ok(right.type !== "block");
  delete right.weights;
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  assert.equal(composite.content!.origins![0]!.weight, 4);
  for (const origin of composite.content!.origins!.slice(1)) assert.equal(Object.hasOwn(origin, "weight"), false);
  assert.deepEqual(separateVisualContent(JSON.parse(JSON.stringify(merged)), composite.id), doc);
});

test("historical restoration preserves later atom edits, unrelated weights and parent settings", () => {
  const doc = nestedDocument();
  let edited = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(edited, "paragraph-3")!;
  edited = updateVisualBlock(edited, "paragraph-4", { text: "Cambio posterior", active: false, readAloud: false });
  edited = { ...edited, layout: updateVisualNode(edited.layout, "left", (node) => {
    assert.ok(node.type !== "block");
    return { ...node, gap: 20, weights: [12, 8, 13, 99] };
  }) };
  const separated = separateVisualContent(JSON.parse(JSON.stringify(edited)), composite.id);
  const left = flattenVisualLayout(separated.layout).find((node) => node.id === "left")!;
  assert.ok(left.type !== "block");
  assert.deepEqual(left.weights, [12, 8, 13, 4]);
  assert.equal(left.gap, 20);
  assert.equal(separated.blocks[3]!.text, "Cambio posterior");
  assert.equal(separated.blocks[3]!.active, false);
  assert.equal(separated.blocks[3]!.readAloud, false);
  const right = flattenVisualLayout(separated.layout).find((node) => node.id === "right")!;
  assert.ok(right.type !== "block");
  assert.deepEqual(right.weights, [5, 6, 7]);
  assert.deepEqual(ids(separated), ids(doc));
});

test("merge regenerates origins instead of trusting supplied history; normalization/rendering preserve it", () => {
  const doc = document();
  const expected = mergeVisualBlocks(doc, ids(doc).slice(0, 2), body);
  const expectedOrigins = compositeForBlock(expected, "paragraph-1")!.content!.origins;
  for (const origins of [[{ leafId: "spoofed", parentId: "obsolete", index: 99, weight: 100 }], null, [{ unexpected: true }]]) {
    const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 2), { ...body, origins } as unknown as VisualCompositeContent);
    const composite = compositeForBlock(merged, "paragraph-1")!;
    assert.deepEqual(composite.content!.origins, expectedOrigins);
    assert.deepEqual(compositeForBlock(normalizeVisualDocument(merged), "paragraph-1")!.content, composite.content);
    const html = renderVisualCompositeHtml(composite, merged.blocks);
    const { origins: _origins, ...legacyContent } = composite.content!;
    assert.equal(renderVisualCompositeHtml({ ...composite, content: legacyContent }, merged.blocks), html);
    assert.equal(visualDocumentSaveError(merged), null);
  }
});

test("moved composites or shifted first boundaries separate in place and do not undo layout changes", () => {
  const doc = nestedDocument();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  for (const moved of [moveVisualNode(merged, composite.id, "right", 0), moveVisualNode(merged, composite.id, "left", 0)]) {
    const parent = flattenVisualLayout(moved.layout).find((node) => node.type !== "block" && node.children.some((child) => child.id === composite.id))!;
    assert.ok(parent.type !== "block");
    const index = parent.children.findIndex((child) => child.id === composite.id);
    const separated = separateVisualContent(JSON.parse(JSON.stringify(moved)), composite.id);
    const resultParent = flattenVisualLayout(separated.layout).find((node) => node.id === parent.id)!;
    assert.ok(resultParent.type !== "block");
    const expected = [...parent.children];
    expected.splice(index, 1, ...composite.children);
    assert.deepEqual(resultParent.children, expected);
    assert.deepEqual(ids(separated), ids(moved));
    checkAtoms(doc, separated);
    assert.deepEqual(flattenVisualLayout(separated.layout).filter((node) => node.type !== "block").map((node) => node.id), flattenVisualLayout(moved.layout).filter((node) => node.type !== "block" && node.id !== composite.id).map((node) => node.id));
  }
});

test("separation after presets never resurrects obsolete containers and keeps current unit order", () => {
  const doc = nestedDocument();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), title);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  for (const preset of ["one-column", "two-columns", "two-by-two", "rows"] as const) {
    const presetDoc = reorderVisualBlock(applyVisualPreset(merged, preset), "paragraph-3", 1);
    const currentContainers = flattenVisualLayout(presetDoc.layout).filter((node) => node.type !== "block" && node.id !== composite.id).map((node) => node.id);
    const separated = separateVisualContent(JSON.parse(JSON.stringify(presetDoc)), composite.id);
    assert.deepEqual(flattenVisualLayout(separated.layout).filter((node) => node.type !== "block").map((node) => node.id), currentContainers);
    assert.deepEqual(ids(separated), ids(presetDoc));
    assert.deepEqual(ids(separated).slice(0, 4), ["paragraph-3", "paragraph-4", "paragraph-5", "paragraph-6"]);
    checkAtoms(doc, separated);
    assert.equal(visualDocumentSaveError(separated), null);
  }
});

test("legacy composites without origins unwrap in place after JSON reload", () => {
  const doc = nestedDocument();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  const legacy: VisualPageDocument = JSON.parse(JSON.stringify(merged));
  delete compositeForBlock(legacy, "paragraph-3")!.content!.origins;
  assert.equal(visualDocumentSaveError(legacy), null);
  const separated = separateVisualContent(legacy, composite.id);
  const left = flattenVisualLayout(separated.layout).find((node) => node.id === "left")!;
  const right = flattenVisualLayout(separated.layout).find((node) => node.id === "right")!;
  assert.ok(left.type !== "block" && right.type !== "block");
  assert.deepEqual(left.children.slice(3), composite.children);
  assert.deepEqual(right.children, []);
  assert.deepEqual(ids(separated), ids(doc));
  checkAtoms(doc, separated);
});

test("removing one empty original parent forces in-place fallback without resurrecting it", () => {
  const doc = nestedDocument();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(2), body);
  const composite = compositeForBlock(merged, "paragraph-3")!;
  const changed = ungroupVisualNode(merged, "right");
  assert.ok(!flattenVisualLayout(changed.layout).some((node) => node.id === "right"));
  const separated = separateVisualContent(JSON.parse(JSON.stringify(changed)), composite.id);
  assert.ok(!flattenVisualLayout(separated.layout).some((node) => node.id === "right"));
  const left = flattenVisualLayout(separated.layout).find((node) => node.id === "left")!;
  assert.ok(left.type !== "block");
  assert.deepEqual(left.children.slice(3), composite.children);
  assert.deepEqual(ids(separated), ids(changed));
  checkAtoms(doc, separated);
});

test("origins must be strict, unique, valid and cover exactly the direct leaf IDs in order", () => {
  const doc = document();
  const merged = mergeVisualBlocks(doc, ids(doc).slice(0, 2), body);
  const composite = compositeForBlock(merged, "paragraph-1")!;
  const origins = composite.content!.origins!;
  for (const invalid of [null, {}, [null], [], origins.slice(0, 1), [...origins, { leafId: "extra", parentId: "root", index: 2 }], [origins[0], origins[0]], [...origins].reverse(),
    ...[{ leafId: " " }, { parentId: "" }, { index: -1 }, { index: 1.5 }, { weight: 0 }, { weight: Infinity }, { extra: true }, { leafId: "paragraph-1" }].map((patch) => [{ ...origins[0], ...patch }, origins[1]]),
  ]) {
    const reloaded: VisualPageDocument = JSON.parse(JSON.stringify(merged));
    compositeForBlock(reloaded, "paragraph-1")!.content!.origins = invalid as NonNullable<VisualCompositeContent["origins"]>;
    assert.match(visualDocumentSaveError(reloaded)!, /compuesto/);
  }
});
