import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import type { BookPageResponse, VisualPageDocument } from "../../app/api";
import { appendVisualBlock, applyVisualPreset, createVisualBlock, flattenVisualLayout, isCenteredFooterRow, moveVisualNode, normalizeVisualDocument, orderedVisualBlocks, pushVisualHistory, redoVisualHistory, renderVisualBlockHtml, renderVisualPreviewHtml, reorderVisualBlock, undoVisualHistory, updateVisualBlock, visualDocumentFromPage, importedVisualSourceHtml, safeVisualImageSource } from "./visual-page";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { window } = new JSDOM("");
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node, Element: window.Element });

function document(): VisualPageDocument {
  const blocks = [createVisualBlock("text"), createVisualBlock("heading"), createVisualBlock("text"), createVisualBlock("image")];
  return { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "column", children: blocks.map((block) => ({ id: crypto.randomUUID(), type: "block", blockId: block.id })) } };
}

function checkLeaves(doc: VisualPageDocument) {
  const nodes = flattenVisualLayout(doc.layout);
  assert.equal(new Set(nodes.map((node) => node.id)).size, nodes.length);
  assert.deepEqual(nodes.flatMap((node) => node.type === "block" ? [node.blockId] : []).sort(), doc.blocks.map((block) => block.id).sort());
}

test("automatic footer preview preserves two real children and manual layouts opt out", () => {
  const footer = { ...createVisualBlock("text"), text: "Pie", role: "footer" as const, readAloud: false, geometry: { bbox: { left: .4, top: .92, width: .2, height: .02 } } };
  const number = { ...createVisualBlock("text"), text: "97", role: "pageNumber" as const, readAloud: false, geometry: { bbox: { left: .9, top: .925, width: .04, height: .02 } } };
  const blocks = [footer, number];
  const row = { id: crypto.randomUUID(), type: "row" as const, children: blocks.map((atom) => ({ id: crypto.randomUUID(), type: "column" as const, children: [{ id: crypto.randomUUID(), type: "block" as const, blockId: atom.id }] })) };
  const doc: VisualPageDocument = { version: 1, blocks, layout: row };
  const before = structuredClone(doc);
  assert.equal(isCenteredFooterRow(row, blocks), true);
  const html = new window.DOMParser().parseFromString(renderVisualPreviewHtml(doc), "text/html");
  const pair = html.querySelector('[data-page-footer-row="true"]')!;
  assert.equal(pair.children.length, 2);
  assert.equal(pair.style.gridTemplateColumns, "1fr auto 1fr");
  assert.equal(pair.children[0].style.gridColumn, "2");
  assert.equal(pair.children[1].style.gridColumn, "3");
  checkLeaves(doc);
  assert.deepEqual(doc, before);
  assert.equal(isCenteredFooterRow({ ...row, weights: [1, 1] }, blocks), false);
  assert.equal(isCenteredFooterRow({ ...row, type: "column" }, blocks), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, role: "body" }]), false);
  assert.equal(isCenteredFooterRow(row, [{ ...footer, geometry: { bbox: { ...footer.geometry.bbox, left: .1 } } }, number]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, geometry: { bbox: { ...number.geometry.bbox, top: .86 } } }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, geometry: null }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, geometry: { bbox: { ...number.geometry.bbox, width: NaN } } }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, active: false }]), true);
  assert.equal(isCenteredFooterRow({ ...row, children: [...row.children].reverse() }, blocks), false);
  assert.equal(isCenteredFooterRow({ ...row, content: { kind: "text", separator: "space", includeInToc: false } }, blocks), false);
  assert.equal(isCenteredFooterRow({ ...row, children: [{ ...row.children[0]!, children: [...row.children[0]!.children, ...row.children[1]!.children] }, row.children[1]!] }, blocks), false);
  assert.equal(isCenteredFooterRow(row, [{ ...footer, geometry: { bbox: { ...footer.geometry.bbox, top: .8 } } }, number]), false);
  const hidden = new window.DOMParser().parseFromString(renderVisualPreviewHtml({ ...doc, blocks: [{ ...footer, active: false }, number] }), "text/html");
  const remaining = hidden.querySelector('[data-page-footer-row="true"]')!.children;
  assert.equal(remaining.length, 2); // Transparent legacy columns remain, even when their atom is hidden.
  assert.equal(remaining[1].style.gridColumn, "3");
  const page = { visualDocument: { ...doc, layout: { ...row, type: "column" as const } } } as BookPageResponse["page"];
  assert.equal(visualDocumentFromPage(page), page.visualDocument);
  assert.doesNotMatch(renderVisualPreviewHtml(page.visualDocument!), /data-page-footer-row/);
});

test("presets preserve every atom and leaf ID once and preserve depth-first order", () => {
  const doc = document();
  for (const preset of ["one-column", "two-columns", "two-by-two", "rows"] as const) {
    const result = applyVisualPreset(doc, preset);
    checkLeaves(result);
    assert.deepEqual(orderedVisualBlocks(result).map((block) => block.id), doc.blocks.map((block) => block.id));
    assert.deepEqual(flattenVisualLayout(result.layout).filter((node) => node.type === "block"), flattenVisualLayout(doc.layout).filter((node) => node.type === "block"));
  }
});

test("move leaves and containers across parents, reject cycles and keep weights aligned", () => {
  const doc = applyVisualPreset(document(), "two-columns");
  const root = doc.layout;
  assert.ok(root.type !== "block");
  const left = root.children[0]!;
  const right = root.children[1]!;
  assert.ok(left.type !== "block" && right.type !== "block");
  left.weights = [2, 3];
  right.weights = [4, 5];
  const before = JSON.stringify(doc);
  const moved = moveVisualNode(doc, left.children[0]!.id, right.id, 1);
  checkLeaves(moved);
  assert.equal(JSON.stringify(doc), before);
  const movedNodes = flattenVisualLayout(moved.layout);
  assert.deepEqual((movedNodes.find((node) => node.id === right.id) as typeof right).weights, [4, 2, 5]);
  assert.deepEqual((movedNodes.find((node) => node.id === left.id) as typeof left).weights, [3]);
  const containers = moveVisualNode(moved, left.id, right.id, 0);
  checkLeaves(containers);
  assert.equal(moveVisualNode(containers, right.id, left.id, 0), containers);
  assert.equal(moveVisualNode(doc, root.id, left.id, 0), doc);
});

test("number changes move the leaf deterministically, without touching geometry or atoms", () => {
  const doc = applyVisualPreset(document(), "two-by-two");
  doc.blocks[0]!.geometry = { bbox: { left: .1, top: .2, width: .3, height: .4 } };
  const reordered = reorderVisualBlock(doc, doc.blocks[0]!.id, 4);
  assert.deepEqual(orderedVisualBlocks(reordered).map((block) => block.id), [...doc.blocks.slice(1), doc.blocks[0]!].map((block) => block.id));
  assert.equal(reordered.blocks, doc.blocks);
  checkLeaves(reordered);
  assert.equal(reorderVisualBlock(doc, doc.blocks[0]!.id, NaN), doc);
});

test("normalization repairs missing and duplicate leaf references, including inactive atoms", () => {
  const doc = document();
  assert.ok(doc.layout.type !== "block");
  doc.layout.children = [doc.layout.children[0]!, doc.layout.children[0]!, { id: crypto.randomUUID(), type: "block", blockId: "missing" }];
  doc.blocks[1]!.active = false;
  checkLeaves(normalizeVisualDocument(doc));
});

test("annulled atoms are absent by default, restored with the same ID; multiline remains ONE atom", () => {
  const doc = document();
  const id = doc.blocks[0]!.id;
  const multiline = updateVisualBlock(doc, id, { text: "**Primera**\nSegunda\nTercera" });
  const html = renderVisualPreviewHtml(multiline);
  const dom = new window.DOMParser().parseFromString(html, "text/html");
  assert.equal(dom.querySelectorAll(`[data-visual-block-id="${id}"]`).length, 1);
  assert.equal(dom.querySelector(`[data-visual-block-id="${id}"]`)?.querySelectorAll("p").length, 1);
  const annulled = updateVisualBlock(multiline, id, { active: false });
  assert.ok(!renderVisualPreviewHtml(annulled).includes(id));
  assert.ok(renderVisualPreviewHtml(annulled, true).includes(id));
  assert.equal(orderedVisualBlocks(annulled, false).length, 3);
  assert.equal(updateVisualBlock(annulled, id, { active: true }).blocks[0]!.id, id);
});

test("new atoms and leaves have distinct UUIDs; structural undo/redo branches drop future", () => {
  const doc = document();
  const block = createVisualBlock("text");
  assert.match(block.id, /^[0-9a-f-]{36}$/);
  assert.ok(block.text.length > 0);
  const created = appendVisualBlock(doc, block);
  checkLeaves(created);
  let history = pushVisualHistory({ past: [], present: doc, future: [] }, created);
  history = pushVisualHistory(history, applyVisualPreset(created, "two-columns"));
  history = pushVisualHistory(history, updateVisualBlock(history.present, block.id, { active: false }));
  const latest = history.present;
  history = undoVisualHistory(history);
  assert.ok(history.present.blocks.at(-1)!.active);
  assert.deepEqual(redoVisualHistory(history).present, latest);
  history = pushVisualHistory(history, updateVisualBlock(history.present, block.id, { text: "Rama nueva" }));
  assert.equal(history.future.length, 0);
  assert.equal(redoVisualHistory(history), history);
});

test("canonical document bypasses legacy mismatch; fallback preserves SQL atoms and flags", () => {
  const doc = document();
  const page = { visualDocument: doc, htmlContent: "<p>15 lineas</p>", paragraphs: [] } as unknown as BookPageResponse["page"];
  assert.equal(visualDocumentFromPage(page), doc);
  page.visualDocument = null;
  page.paragraphs = [{ paragraphId: doc.blocks[0]!.id, paragraphNumber: 1, paragraphText: "A\nB", active: false, role: "header", readAloud: false }] as BookPageResponse["page"]["paragraphs"];
  const derived = visualDocumentFromPage(page);
  assert.equal(derived.blocks.length, 1);
  assert.equal(derived.blocks[0]!.text, "A\nB");
  assert.equal(derived.blocks[0]!.active, false);
  assert.equal(derived.blocks[0]!.readAloud, false);
});

test("HTML fallback resolves images by paragraph ID safely and imported source retains anchors", () => {
  const doc = document();
  const id = doc.blocks[0]!.id;
  const page = { htmlContent: `<figure data-paragraph-number="1"><img src="https://example.test/a.png" alt="Foto" onerror="alert(1)"></figure><script>alert(1)</script>`, paragraphs: [{ paragraphId: id, paragraphNumber: 1, paragraphText: "Foto", role: "image" }] } as unknown as BookPageResponse["page"];
  const derived = visualDocumentFromPage(page);
  assert.equal(derived.blocks[0]!.source, "https://example.test/a.png");
  const source = importedVisualSourceHtml(page, derived);
  assert.ok(source.includes(`data-paragraph-id="${id}"`));
  assert.ok(!source.includes("onerror"));
  assert.ok(!source.includes("<script"));
});

test("atom rendering never interprets reading-block metadata and lists remain inside one atom", () => {
  const block = createVisualBlock("text");
  const marker = `:::block ${crypto.randomUUID()}`;
  assert.ok(renderVisualBlockHtml({ ...block, text: `${marker}\n**Texto**` }).includes(marker));
  const html = renderVisualBlockHtml({ ...block, text: "- **Uno**\n- *Dos*" });
  assert.equal((html.match(/<li>/g) ?? []).length, 2);
  assert.ok(html.includes("<strong>Uno</strong>"));
  assert.ok(html.includes("<em>Dos</em>"));
  assert.equal(renderVisualBlockHtml({ ...block, kind: "heading", text: "A\nB", headingLevel: 6 }), "<h6>A<br />B</h6>");
});

test("image sources reject unsafe protocols and credentials but retain imported supported images", () => {
  for (const source of ["blob:temporary", "javascript:alert(1)", "data:text/html;base64,PHN2Zz4=", "https://user:secret@example.com/image.png", "https://example.com/<script>"]) assert.equal(safeVisualImageSource(source), false);
  assert.ok(safeVisualImageSource("data:image/png;base64,AAAA"));
  assert.ok(safeVisualImageSource("data:image/svg+xml;base64,PHN2Zz4="));
  assert.ok(safeVisualImageSource("data:image/png;base64," + "A".repeat(1024 * 1024)));
  assert.ok(safeVisualImageSource("lector-content-image:12345678-1234-4234-8234-123456789012"));
});

test("HTML identity wins over coincident paragraph numbers and fallback source is keyboard accessible", () => {
  const doc = document();
  const [first, second] = doc.blocks;
  const page = { htmlContent: `<p data-paragraph-id="${second!.id}" data-paragraph-number="1">Otro parrafo</p><p data-paragraph-id="${first!.id}">Parrafo correcto</p>`, paragraphs: [{ paragraphId: first!.id, paragraphNumber: 1, paragraphText: "Original" }] } as unknown as BookPageResponse["page"];
  assert.equal(visualDocumentFromPage(page).blocks[0]!.text, "Parrafo correcto");
  const source = importedVisualSourceHtml({ ...page, htmlContent: null }, doc);
  assert.ok(source.includes(`tabindex="0" role="button" data-paragraph-id="${first!.id}"`));
});

test("preview matches escaped punctuation, multiline emphasis and empty lines without splitting an atom", () => {
  const block = createVisualBlock("text");
  assert.equal(renderVisualBlockHtml({ ...block, text: "\\_literal\\_" }), "<p>_literal_</p>");
  assert.equal(renderVisualBlockHtml({ ...block, text: "A\n\nB" }), "<p>A<br /><br />B</p>");
  assert.equal(renderVisualBlockHtml({ ...block, text: "**A\nB**" }), "<p><strong>A<br />B</strong></p>");
  assert.equal(renderVisualBlockHtml({ ...block, text: "* **Uno**\n* *Dos*" }), "<ul><li><strong>Uno</strong></li><li><em>Dos</em></li></ul>");
});

test("kind changes clear image-only fields while keeping stable source bindings", () => {
  const page = document();
  const image = { ...page.blocks[0]!, kind: "image" as const, source: "https://example.com/image.png", sourceKey: "image:0", imageWidth: 40 };
  const changed = updateVisualBlock({ ...page, blocks: [image, ...page.blocks.slice(1)] }, image.id, { kind: "text" });
  assert.equal(changed.blocks[0]!.source, undefined);
  assert.equal(changed.blocks[0]!.imageWidth, undefined);
  assert.equal(changed.blocks[0]!.sourceKey, "image:0");
  assert.equal(changed.blocks[0]!.id, image.id);
});
