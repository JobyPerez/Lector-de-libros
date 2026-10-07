import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { load } from "cheerio";
import sharp from "sharp";
import { buildVisualDocumentFromPage, cropVisualPageImage, isCenteredFooterRow, orderedVisualBlocks, renderVisualDocument,
  visualSourceHtml, visualPageDocumentSchema, type VisualBlock, type VisualLayoutNode, type VisualPageDocument } from "../src/modules/books/visual-document.js";
import { annotatePageElementHtml, paragraphElementMetadataSchema, projectActivePageHtml } from "../src/modules/books/page-elements.js";
import { buildOutlineFromTitles } from "../src/modules/books/book-outline.js";

const block = (text = "Text", extra: Partial<VisualBlock> = {}): VisualBlock => ({ id: randomUUID(), kind: "text", text,
  role: "body", active: true, readAloud: true, includeInToc: false, ...extra });
const leaf = (atom: VisualBlock): VisualLayoutNode => ({ id: randomUUID(), type: "block", blockId: atom.id });
const doc = (...blocks: VisualBlock[]): VisualPageDocument => ({ version: 1, blocks,
  layout: { id: randomUUID(), type: "column", children: blocks.map(leaf) } });
const geometry = { bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 } };

test("column weights roundtrip as metadata without imposing proportional heights; row weights remain widths", () => {
  const value = doc(block("Short"), block("Long\n\nbody"));
  assert.ok(value.layout.type !== "block");
  value.layout.weights = [100, 1];
  const before = structuredClone(value);
  const rendered = renderVisualDocument(value);
  const css = load(rendered.htmlContent)(`[data-layout-id="${value.layout.id}"]`).attr("style")!;
  assert.doesNotMatch(css, /grid-template-rows/u);
  assert.match(css, /grid-auto-rows:max-content;align-content:start/u);
  assert.match(css, /--reader-layout-weights:minmax\(0,100fr\) minmax\(0,1fr\)/u);
  const stored = rendered.paragraphIds.map((paragraphId, index) => ({ ...rendered.paragraphMetadata[index]!,
    paragraphId, paragraphNumber: index + 1, paragraphText: rendered.paragraphs[index]! }));
  const roundtrip = buildVisualDocumentFromPage(rendered.htmlContent, stored);
  assert.ok(roundtrip.layout.type !== "block");
  assert.deepEqual(roundtrip.layout.weights, [100, 1]);
  assert.deepEqual(value, before);
  value.layout.type = "row";
  assert.match(renderVisualDocument(value).htmlContent, /--reader-row-columns:minmax\(0,100fr\) minmax\(0,1fr\)/u);
});

test("image width is emitted once per CSS hook and works without reader stylesheets", () => {
  const value = doc(block("Caption", { kind: "image", source: "data:image/png;base64,YQ==", imageWidth: 42 }));
  const html = load(renderVisualDocument(value).htmlContent);
  const css = html("figure").attr("style")!;
  assert.equal(css.split("--reader-image-width:").length - 1, 1);
  assert.equal(css.split("--visual-image-width:").length - 1, 1);
  assert.match(css, /--reader-image-width:42%;--visual-image-width:42%/u);
  assert.equal(html("img").attr("style"), "width:var(--reader-image-width,var(--visual-image-width,auto));max-width:100%;height:auto");
});

test("explicit atom and composite scale take precedence without duplicate or compounded declarations", () => {
  const value = doc(block("One", { fontScale: 1.2, style: { fontScale: 1.5 } }), block("Two"));
  const atom = load(renderVisualDocument(value).htmlContent)("p").first();
  assert.equal(atom.attr("data-font-scale"), "1.2");
  assert.equal((atom.attr("style")!.match(/font-size:/gu) ?? []).length, 1);
  assert.match(atom.attr("style")!, /font-size:1.2em/u);
  assert.ok(value.layout.type !== "block");
  value.layout.style = { fontScale: 1.5, color: "#123abc" };
  for (const fontScale of [undefined, 2]) {
    value.layout.content = { kind: "text", separator: "paragraph", includeInToc: false,
      ...(fontScale !== undefined ? { fontScale } : {}) };
    const html = load(renderVisualDocument(value).htmlContent);
    const sectionStyle = html(".reader-content-compound").attr("style")!;
    assert.match(sectionStyle, /color:#123abc/u);
    if (fontScale !== undefined) {
      assert.doesNotMatch(sectionStyle, /font-size|--reader-font-scale/u);
      assert.match(html(".reader-content-compound > div").attr("style")!, /font-size:2em/u);
      assert.doesNotMatch(html("p").first().attr("style") ?? "", /font-size/u);
    } else {
      assert.match(sectionStyle, /font-size:1.5em/u);
      assert.match(html("p").first().attr("style")!, /font-size:1.2em/u);
    }
  }
});
const tableDoc = (...blocks: VisualBlock[]): VisualPageDocument => ({ version: 1, blocks,
  layout: { id: randomUUID(), type: "column", semantic: "table", children: [
    { id: randomUUID(), type: "row", semantic: "tableRow", children: blocks.map((atom) => ({
      id: randomUUID(), type: "column", semantic: "tableCell", children: [leaf(atom)]
    })) }
  ] } });

test("container semantics have strict orientations, safe styles and accessible roles, compatible with version 1", () => {
  for (const semantic of ["table", "tableRow", "tableCell", "figure"] as const) {
    const value = semantic === "figure" ? doc(block()) : tableDoc(block());
    assert.ok(value.layout.type !== "block");
    let node = value.layout;
    if (semantic === "tableRow" || semantic === "tableCell") {
      const row = node.children[0]!;
      assert.ok(row.type !== "block");
      node = row;
      if (semantic === "tableCell") {
        const cell = row.children[0]!;
        assert.ok(cell.type !== "block");
        node = cell;
      }
    }
    node.semantic = semantic;
    node.style = { backgroundColor: "#fffefd", borderColor: "#123abc", borderWidth: 2, padding: 12, fontFamily: "serif" };
    const html = load(renderVisualDocument(value).htmlContent);
    const container = html(`[data-layout-semantic="${semantic}"]`);
    assert.equal(container.attr("role"), { table: "table", tableRow: "row", tableCell: "cell", figure: "group" }[semantic]);
    assert.match(container.attr("style")!, /background-color:#fffefd;border-color:#123abc;border-width:2px;border-style:solid;padding:12px;font-family:serif/u);
    assert.equal(visualPageDocumentSchema.safeParse(value).success, true);
    node.type = node.type === "row" ? "column" : "row";
    assert.equal(visualPageDocumentSchema.safeParse(value).success, false);
    node.type = semantic === "tableRow" ? "row" : "column";
    (node.style as any).color = "red;position:fixed";
    assert.throws(() => renderVisualDocument(value));
  }
  assert.equal(visualPageDocumentSchema.safeParse(doc(block())).success, true);
  const value = doc(block());
  (value.layout as any).semantic = "unknown";
  assert.equal(visualPageDocumentSchema.safeParse(value).success, false);
  (value.layout as any).children[0].semantic = "tableCell";
  assert.equal(visualPageDocumentSchema.safeParse(value).success, false);
});

test("API-generated wrappers roundtrip nested container semantics and styles without applying arbitrary CSS", () => {
  const first = block("Cell A"), second = block("Cell B");
  const value = doc(first, second);
  const cell: VisualLayoutNode = { id: randomUUID(), type: "column", semantic: "tableCell", style: { padding: 8 }, children: [leaf(first)] };
  value.layout = { id: randomUUID(), type: "column", semantic: "table", style: { borderWidth: 1, borderColor: "#123abc" }, gap: 4,
    children: [{ id: randomUUID(), type: "row", semantic: "tableRow", weights: [2, 1], style: { backgroundColor: "#fffefd" },
      children: [cell, { id: randomUUID(), type: "column", semantic: "tableCell", children: [
        { id: randomUUID(), type: "column", semantic: "figure", style: { alignment: "center" }, children: [leaf(second)] }
      ] }] }] };
  const rendered = renderVisualDocument(value, { includeInactive: true });
  const stored = rendered.paragraphIds.map((paragraphId, index) => ({ ...rendered.paragraphMetadata[index]!, paragraphId,
    paragraphNumber: index + 1, paragraphText: rendered.paragraphs[index]! }));
  const roundtrip = buildVisualDocumentFromPage(rendered.htmlContent, stored);
  assert.equal(visualPageDocumentSchema.safeParse(roundtrip).success, true);
  assert.deepEqual(orderedVisualBlocks(roundtrip).map((block) => block.id), rendered.paragraphIds);
  assert.ok(roundtrip.layout.type !== "block");
  assert.deepEqual(roundtrip.layout.style, { borderWidth: 1, borderColor: "#123abc" });
  assert.equal(roundtrip.layout.semantic, "table");
  const row = roundtrip.layout.children[0]!;
  assert.ok(row.type !== "block");
  assert.equal(row.semantic, "tableRow");
  assert.deepEqual(row.weights, [2, 1]);
  assert.deepEqual(row.style, { backgroundColor: "#fffefd" });
  assert.ok(row.children[0]!.type !== "block");
  assert.equal(row.children[0]!.semantic, "tableCell");
  assert.deepEqual(row.children[0]!.style, { padding: 8 });
  assert.ok(row.children[1]!.type !== "block");
  assert.equal(row.children[1]!.semantic, "tableCell");
  const figure = row.children[1]!.children[0]!;
  assert.ok(figure.type !== "block");
  assert.equal(figure.semantic, "figure");
  assert.deepEqual(figure.style, { alignment: "center" });
  const source = load(rendered.htmlContent);
  assert.equal(source(`[data-layout-id="${figure.id}"]`).attr("data-text-align"), "center");
  assert.equal(source(`[data-visual-block-id="${second.id}"]`).attr("data-text-align"), undefined);
});

test("table semantics reject stray rows/cells, invalid direct children and intervening generic wrappers", () => {
  const value = tableDoc(block());
  assert.ok(value.layout.type !== "block");
  const row = value.layout.children[0]!;
  assert.ok(row.type !== "block");
  const cell = row.children[0]!;
  assert.ok(cell.type !== "block");
  assert.equal(visualPageDocumentSchema.safeParse(value).success, true);
  const invalid = [
    { ...value, layout: row },
    { ...value, layout: cell },
    { ...value, layout: { ...value.layout, children: [cell] } },
    { ...value, layout: { ...value.layout, children: [{ ...row, children: cell.children }] } },
    { ...value, layout: { ...value.layout, children: [{ id: randomUUID(), type: "column", children: [row] }] } },
    { ...value, layout: { ...value.layout, children: [{ ...row, children: [{ id: randomUUID(), type: "column", children: [cell] }] }] } }
  ];
  for (const document of invalid) assert.equal(visualPageDocumentSchema.safeParse(document).success, false);
  const generic = doc(block());
  assert.ok(generic.layout.type !== "block");
  generic.layout.children = [{ id: randomUUID(), type: "row", children: generic.layout.children }];
  assert.equal(visualPageDocumentSchema.safeParse(generic).success, true);
});

test("nested aligned containers expose inheritance hooks without overriding atomic or nearer alignment", () => {
  const inherited = block("Inherited"), explicit = block("Explicit", { alignment: "right" });
  const value = doc(inherited, explicit);
  assert.ok(value.layout.type !== "block");
  value.layout.style = { alignment: "center" };
  const nested: VisualLayoutNode = { id: randomUUID(), type: "column", style: { alignment: "left" }, children: [leaf(inherited), leaf(explicit)] };
  value.layout.children = [nested];
  const html = load(renderVisualDocument(value).htmlContent);
  assert.equal(html(`[data-layout-id="${value.layout.id}"]`).attr("data-text-align"), "center");
  assert.equal(html(`[data-layout-id="${nested.id}"]`).attr("data-text-align"), "left");
  assert.equal(html(`[data-visual-block-id="${inherited.id}"]`).attr("data-text-align"), undefined);
  assert.doesNotMatch(html(`[data-visual-block-id="${inherited.id}"]`).attr("style") ?? "", /text-align/u);
  assert.equal(html(`[data-visual-block-id="${explicit.id}"]`).attr("data-text-align"), "right");
  value.layout.children = [leaf(inherited), leaf(explicit)];
  value.layout.content = { kind: "text", separator: "paragraph", includeInToc: false };
  const compound = load(renderVisualDocument(value).htmlContent);
  assert.equal(compound(".reader-content-compound").attr("data-text-align"), "center");
});

test("legacy footer pair adapts without body weights and renders centered without new leaves", () => {
  const footer = block("Pie de pagina", { role: "footer", readAloud: false, geometry: { bbox: { left: .4, top: .92, width: .2, height: .02 } } });
  const number = block("97", { role: "pageNumber", readAloud: false, geometry: { bbox: { left: .9, top: .925, width: .04, height: .02 } } });
  const stored = [footer, number].map((atom, index) => ({ ...atom, paragraphId: atom.id, paragraphNumber: index + 1, paragraphText: atom.text }));
  const source = '<div class="reader-reading-row"><div class="reader-reading-column"><p data-paragraph-number="1">Pie de pagina</p></div><div class="reader-reading-column"><p data-paragraph-number="2">97</p></div></div>';
  const value = buildVisualDocumentFromPage(source, stored);
  assert.ok(value.layout.type !== "block");
  const row = value.layout.children[0]!;
  assert.ok(row.type === "row");
  assert.equal(row.weights, undefined);
  assert.equal(isCenteredFooterRow(row, value.blocks), true);
  const before = structuredClone(value);
  const rendered = renderVisualDocument(value);
  const html = load(rendered.htmlContent);
  const pair = html('[data-page-footer-row="true"]');
  assert.equal(pair.length, 1);
  assert.equal(pair.children().length, 2);
  assert.match(pair.attr("style")!, /--reader-row-columns:1fr auto 1fr;/u);
  assert.match(pair.children().first().attr("style")!, /grid-column:2/u);
  assert.match(pair.children().last().attr("style")!, /grid-column:3/u);
  assert.equal(html('[data-element-role="footer"]').attr("data-text-align"), "center");
  assert.equal(html('[data-element-role="pageNumber"]').attr("data-text-align"), "right");
  assert.deepEqual(rendered.paragraphIds, [footer.id, number.id]);
  assert.deepEqual(rendered.paragraphMetadata.map((meta) => meta.readAloud), [false, false]);
  assert.deepEqual(value, before);
  for (const weights of [[1, 1], [2, 1]]) {
    assert.equal(isCenteredFooterRow({ ...row, weights }, value.blocks), false);
    assert.doesNotMatch(renderVisualDocument({ ...value, layout: { ...row, weights } }).htmlContent, /data-page-footer-row/u);
  }
  assert.equal(isCenteredFooterRow({ ...row, type: "column" }, value.blocks), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, role: "body" }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, geometry: { bbox: { ...number.geometry!.bbox, top: .86 } } }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, geometry: null }]), false);
  assert.equal(isCenteredFooterRow(row, [footer, { ...number, active: false }]), true);
  assert.equal(isCenteredFooterRow({ ...row, children: [...row.children].reverse() }, value.blocks), false);
  assert.equal(isCenteredFooterRow({ ...row, content: { kind: "text", separator: "space", includeInToc: false } }, value.blocks), false);
  assert.equal(isCenteredFooterRow({ ...row, children: [...row.children, leaf(footer)] }, value.blocks), false);
  assert.equal(isCenteredFooterRow(row, [{ ...footer, geometry: { bbox: { ...footer.geometry!.bbox, top: .8 } } }, number]), false);
  const onlyNumber = load(renderVisualDocument({ ...value, blocks: [{ ...value.blocks[0]!, active: false }, value.blocks[1]!] }).htmlContent);
  assert.equal(onlyNumber('[data-page-footer-row="true"]').children().length, 1);
  assert.match(onlyNumber('[data-page-footer-row="true"]').children().attr("style")!, /grid-column:3;grid-row:1;justify-self:end/u);
});

test("compound heading is one indexed heading with unchanged numbered atoms, formatting and metadata", () => {
  const first = block("**CAPITULO 5**", { kind: "heading", headingLevel: 3, includeInToc: false, readAloud: false, fontScale: 1.2 });
  const second = block("34 *lunas llenas*", { kind: "heading", headingLevel: 4, includeInToc: true, geometry });
  const value = doc(first, second);
  if (value.layout.type === "block") throw new Error("container expected");
  value.layout.content = { kind: "heading", separator: "space", includeInToc: true, headingLevel: 2 };
  const before = structuredClone(value);
  const rendered = renderVisualDocument(value);
  const html = load(rendered.htmlContent);
  assert.equal(html("h1,h2,h3,h4,h5,h6").length, 1);
  assert.equal(html("h2[data-paragraph-number]").length, 0);
  assert.equal(html("h2 > span[data-paragraph-number]").length, 2);
  assert.equal(html(".reader-content-compound").attr("data-composite-id"), value.layout.id);
  assert.equal(html("h2").attr("data-composite-anchor-id"), first.id);
  assert.equal(html("h2").attr("data-composite-title"), "CAPITULO 5 34 lunas llenas");
  assert.equal(html("strong").text(), "CAPITULO 5");
  assert.equal(html("em").text(), "lunas llenas");
  assert.equal(html("span").first().attr("data-font-scale"), "1.2");
  assert.deepEqual(rendered.paragraphs, ["CAPITULO 5", "34 lunas llenas"]);
  assert.deepEqual(rendered.paragraphIds, [first.id, second.id]);
  assert.equal(rendered.paragraphMetadata[0]!.readAloud, false);
  assert.equal(rendered.paragraphMetadata[0]!.includeInToc, false);
  assert.deepEqual(rendered.paragraphMetadata[1]!.geometry, geometry);
  const rows = value.blocks.map((atom, i) => ({ paragraphId: atom.id, pageNumber: 1, paragraphNumber: i + 1,
    sequenceNumber: i + 1, active: atom.active, includeInToc: atom.includeInToc, elementRole: atom.role }));
  const outline = buildOutlineFromTitles([{ pageNumber: 1, htmlContent: rendered.htmlContent }], rows);
  assert.deepEqual(outline.map((entry) => [entry.chapterId, entry.title, entry.level]), [[first.id, "CAPITULO 5 34 lunas llenas", 2]]);
  const inactive = structuredClone(value);
  inactive.blocks[0]!.active = false;
  const inactiveRows = rows.map((row, i) => ({ ...row, active: i !== 0 }));
  const currentOutline = buildOutlineFromTitles([{ pageNumber: 1, htmlContent: rendered.htmlContent,
    visualDocumentJson: JSON.stringify(inactive) }], inactiveRows);
  assert.deepEqual(currentOutline.map((entry) => [entry.chapterId, entry.title, entry.paragraphNumber]), [[second.id, "34 lunas llenas", 2]]);
  value.layout.content.includeInToc = false;
  assert.equal(buildOutlineFromTitles([{ pageNumber: 1, htmlContent: renderVisualDocument(value).htmlContent }], rows).length, 0);
  delete value.layout.content;
  assert.deepEqual(buildOutlineFromTitles([{ pageNumber: 1, htmlContent: renderVisualDocument(value).htmlContent }], rows).map((entry) => entry.chapterId), [second.id]);
  assert.deepEqual(value.blocks, before.blocks);
});

test("compound body separators preserve exact atomic text, flags and inactive filtering", () => {
  for (const separator of ["paragraph", "space", "line"] as const) {
    const value = doc(block("One\n\nline", { kind: "heading", headingLevel: 2 }), block("hidden", { active: false }), block("Three", { readAloud: false }));
    if (value.layout.type === "block") throw new Error("container expected");
    value.layout.content = { kind: "text", separator, includeInToc: true };
    const rendered = renderVisualDocument(value);
    const html = load(rendered.htmlContent);
    assert.equal(html("h1,h2,h3").length, 0);
    assert.equal(html("p").length, separator === "paragraph" ? 2 : 1);
    assert.deepEqual(html("[data-paragraph-number]").map((_, node) => html(node).attr("data-reader-text")).get(), ["One\n\nline", "Three"]);
    assert.equal(html("[data-paragraph-number]").last().attr("data-read-aloud"), "false");
    assert.equal(html("br").length, separator === "line" ? 3 : 2);
    if (separator === "space") assert.match(html("p").html()!, /<\/span> <span/u);
    if (separator === "line") assert.match(html("p").html()!, /<\/span><br>\n<span/u);
    assert.deepEqual(rendered.paragraphs, ["One\n\nline", "hidden", "Three"]);
    const full = load(renderVisualDocument(value, { includeInactive: true }).htmlContent);
    assert.equal(full("[data-paragraph-number]").length, 3);
    if (separator === "paragraph") assert.equal(full("p").length, 3);
    value.blocks.forEach((atom) => { atom.active = false; });
    assert.equal(load(renderVisualDocument(value).htmlContent)(".reader-content-compound").length, 0);
    assert.equal(load(renderVisualDocument(value, { includeInactive: true }).htmlContent)("[data-paragraph-number]").length, 3);
  }
});

test("common compound typography overrides only rendered styling and source snapshots stay independent", () => {
  const value = doc(block("**One**", { fontScale: 1.5, alignment: "right" }), block("Two", { fontScale: 0.8 }));
  if (value.layout.type === "block") throw new Error("container expected");
  const original = structuredClone(value.blocks);
  const source = `<h3 data-paragraph-number="1" data-paragraph-id="${value.blocks[0]!.id}"><strong>Original</strong></h3><p data-paragraph-number="2" data-paragraph-id="${value.blocks[1]!.id}">Source</p>`;
  const snapshot = visualSourceHtml(source, [], value);
  value.layout.content = { kind: "heading", separator: "paragraph", includeInToc: false, headingLevel: 6, fontScale: 2, alignment: "center" };
  const html = load(renderVisualDocument(value).htmlContent);
  assert.equal(html("h6").attr("data-font-scale"), "2");
  assert.equal(html("h6").attr("data-text-align"), "center");
  assert.equal(html("span[data-font-scale],span[data-text-align]").length, 0);
  assert.deepEqual(value.blocks, original);
  assert.equal(visualSourceHtml(source, [], value), snapshot);
  assert.equal(source, snapshot);
});

test("compound schema is strict, flat, column-only and accepts persisted inactive members", () => {
  const value = doc(block(), block());
  const content = { kind: "text", separator: "paragraph", includeInToc: false };
  const valid: any = { ...value, layout: { ...value.layout, content } };
  assert.ok(visualPageDocumentSchema.safeParse(valid).success);
  for (const mutate of [
    (v: any) => v.layout.type = "row",
    (v: any) => v.layout.children.pop(),
    (v: any) => v.layout.children[0] = { id: randomUUID(), type: "column", children: [v.layout.children[0]] },
    (v: any) => Object.assign(v.blocks[0], { kind: "image", source: "https://example.com/a.png" }),
    (v: any) => v.layout.content.unknown = true,
    (v: any) => v.layout.content.headingLevel = 7,
    (v: any) => v.layout.content.fontScale = 3.1,
    (v: any) => v.layout.content.separator = "none",
    (v: any) => v.layout.children[1].blockId = v.layout.children[0].blockId
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.equal(visualPageDocumentSchema.safeParse(invalid).success, false);
  }
  valid.blocks.forEach((atom: any) => { atom.active = false; });
  assert.ok(visualPageDocumentSchema.safeParse(valid).success);
});

test("compound origins preserve strict historical placements without requiring current parents", () => {
  const value = doc(block("One"), block("Two"));
  if (value.layout.type === "block") throw new Error("container expected");
  value.layout.content = { kind: "heading", separator: "space", includeInToc: true };
  const before = renderVisualDocument(value);
  const parentId = randomUUID();
  value.layout.content.origins = value.layout.children.map((child, index) => ({ leafId: child.id, parentId,
    index: index === 0 ? 0 : 1000, ...(index === 0 ? { weight: 0.5 } : {}) }));
  const parsed = visualPageDocumentSchema.parse(value);
  assert.deepEqual(parsed, value);
  assert.deepEqual(visualPageDocumentSchema.parse(JSON.parse(JSON.stringify(value))), value);
  assert.deepEqual(renderVisualDocument(value), before);
  const rows = value.blocks.map((atom, index) => ({ paragraphId: atom.id, pageNumber: 1, paragraphNumber: index + 1,
    sequenceNumber: index + 1, includeInToc: atom.includeInToc }));
  assert.deepEqual(buildOutlineFromTitles([{ pageNumber: 1, htmlContent: null, visualDocumentJson: JSON.stringify(value) }], rows),
    buildOutlineFromTitles([{ pageNumber: 1, htmlContent: before.htmlContent }], rows));
  const reversed = structuredClone(value);
  if (reversed.layout.type === "block") throw new Error("container expected");
  reversed.layout.content!.origins!.reverse();
  assert.ok(visualPageDocumentSchema.safeParse(reversed).success);
  delete value.layout.content.origins;
  assert.ok(visualPageDocumentSchema.safeParse(value).success);
});

test("compound origins reject duplicates, missing leaves, invalid parents, indices, weights and extra fields", () => {
  const value = doc(block(), block());
  if (value.layout.type === "block") throw new Error("container expected");
  value.layout.content = { kind: "text", separator: "paragraph", includeInToc: false,
    origins: value.layout.children.map((child, index) => ({ leafId: child.id, parentId: randomUUID(), index })) };
  const valid: any = value;
  for (const mutate of [
    (v: any) => v.layout.content.origins[1].leafId = v.layout.content.origins[0].leafId,
    (v: any) => v.layout.content.origins.pop(),
    (v: any) => v.layout.content.origins = [],
    (v: any) => v.layout.content.origins[0].leafId = randomUUID(),
    (v: any) => v.layout.content.origins[0].leafId = v.blocks[0].id,
    (v: any) => v.layout.content.origins[0].parentId = v.layout.id,
    (v: any) => v.layout.content.origins[0].parentId = v.layout.children[1].id,
    (v: any) => v.layout.content.origins[0].parentId = "bad",
    (v: any) => v.layout.content.origins[0].leafId = "bad",
    (v: any) => v.layout.content.origins[0].unknown = true,
    (v: any) => delete v.layout.content.origins[0].index,
    ...[-1, 1001, 0.5, Infinity, "0"].map((index) => (v: any) => v.layout.content.origins[0].index = index),
    ...[0, -1, Infinity, NaN, "1", null].map((weight) => (v: any) => v.layout.content.origins[0].weight = weight)
  ]) {
    const invalid = structuredClone(valid); mutate(invalid);
    assert.equal(visualPageDocumentSchema.safeParse(invalid).success, false);
  }
  const maximum = doc(...Array.from({ length: 500 }, () => block()));
  if (maximum.layout.type === "block") throw new Error("container expected");
  maximum.layout.content = { kind: "text", separator: "paragraph", includeInToc: false,
    origins: maximum.layout.children.map((child, index) => ({ leafId: child.id, parentId: randomUUID(), index, weight: 1 })) };
  assert.ok(visualPageDocumentSchema.safeParse(maximum).success);
  maximum.layout.content.origins!.push({ leafId: randomUUID(), parentId: randomUUID(), index: 500 });
  const overflow = visualPageDocumentSchema.safeParse(maximum);
  assert.equal(overflow.success, false);
  if (!overflow.success) assert.ok(overflow.error.issues.some((issue) => issue.code === "too_big" && issue.path.includes("origins")));
});

test("strict schema validates roles, UUIDs, dimensions, sources and nonblank active atoms", () => {
  assert.ok(visualPageDocumentSchema.safeParse(doc()).success);
  assert.ok(visualPageDocumentSchema.safeParse(doc(block("", { active: false }))).success);
  for (const extra of [{ id: "bad" }, { active: true, text: "  " }, { headingLevel: 7 }, { headingLevel: 1.5 },
    { imageWidth: 0 }, { imageWidth: 101 }, { fontScale: 0.4 }, { fontScale: 3.1 }, { alignment: "justify" },
    { geometry: { bbox: { ...geometry.bbox, width: 2 } } }, { readAloud: 1 }, { unexpected: true }]) {
    assert.equal(visualPageDocumentSchema.safeParse(doc(block("Text", extra as any))).success, false, JSON.stringify(extra));
  }
  for (const source of ["javascript:alert(1)", "blob:https://site/id", "file:///a", "data:text/html;base64,YQ==", "https://x/<script>",
    "//example.com/img", "lector-content-image:bad", "https://user:pass@host/img", "data:image/png;base64,a"]) {
    assert.equal(visualPageDocumentSchema.safeParse(doc(block("Alt", { kind: "image", source }))).success, false, source);
  }
  for (const source of [`lector-content-image:${randomUUID()}`, "data:image/png;base64,YQ==", "https://example.com/a.png", "http://example.com/a.png"]) {
    assert.ok(visualPageDocumentSchema.safeParse(doc(block("", { kind: "image", source }))).success, source);
  }
  assert.equal(visualPageDocumentSchema.safeParse(doc(block("", { kind: "image", source: "page-crop" }))).success, false);
  assert.ok(visualPageDocumentSchema.safeParse(doc(block("", { kind: "image", source: "page-crop", geometry }))).success);
  assert.equal(visualPageDocumentSchema.safeParse({ ...doc(), unknown: true }).success, false);
});

test("schema rejects cycles, duplicates, missing/repeated references, weights and budgets before recursion", () => {
  const atom = block();
  const original = doc(atom);
  for (const mutate of [
    (value: any) => value.blocks.push({ ...atom }),
    (value: any) => value.layout.children.push(leaf(atom)),
    (value: any) => value.layout.children[0].blockId = randomUUID(),
    (value: any) => value.layout.children = [],
    (value: any) => value.layout.id = atom.id,
    (value: any) => value.layout.weights = [1, 2],
    (value: any) => value.layout.weights = [0],
    (value: any) => value.layout.gap = 49,
    (value: any) => value.layout.children[0].unknown = true
  ]) {
    const value = structuredClone(original); mutate(value); assert.equal(visualPageDocumentSchema.safeParse(value).success, false);
  }
  const cycle: any = { id: randomUUID(), type: "column", children: [] }; cycle.children.push(cycle);
  assert.equal(visualPageDocumentSchema.safeParse({ ...doc(), layout: cycle }).success, false);
  const shared = { id: randomUUID(), type: "column", children: [] };
  assert.equal(visualPageDocumentSchema.safeParse({ ...doc(), layout: { id: randomUUID(), type: "row", children: [shared, shared] } }).success, false);
  assert.equal(visualPageDocumentSchema.safeParse(doc(...Array.from({ length: 501 }, () => block()))).success, false);
  const budget = doc();
  (budget.layout as any).children = Array.from({ length: 1000 }, () => ({ id: randomUUID(), type: "column", children: [] }));
  assert.equal(visualPageDocumentSchema.safeParse(budget).success, false);
  let deep: VisualLayoutNode = leaf(atom);
  for (let i = 0; i < 7; i++) deep = { id: randomUUID(), type: "column", children: [deep] };
  assert.ok(visualPageDocumentSchema.safeParse({ ...original, layout: deep }).success);
  assert.equal(visualPageDocumentSchema.safeParse({ ...original, layout: { id: randomUUID(), type: "row", children: [deep] } }).success, false);
});

test("nested render preserves full DFS numbers and atomic multiline Markdown, even with hidden atoms", () => {
  const first = block("hidden", { active: false });
  const heading = block("**Title**\n*Second line*", { kind: "heading", role: "heading", headingLevel: 4, includeInToc: true });
  const multiline = block("**One**\n\n*Two* <script>", { fontScale: 1.5, alignment: "right" });
  const image = block("Caption", { kind: "image", role: "image", source: `lector-content-image:${randomUUID()}`, imageWidth: 42 });
  const document = doc(image, multiline, first, heading);
  document.layout = { id: randomUUID(), type: "row", weights: [2, 1], gap: 12, children: [
    { id: randomUUID(), type: "column", children: [leaf(first), leaf(heading)] },
    { id: randomUUID(), type: "row", children: [leaf(multiline), leaf(image)] }
  ] };
  const rendered = renderVisualDocument(document);
  const html = load(rendered.htmlContent);
  assert.deepEqual(rendered.paragraphIds, [first.id, heading.id, multiline.id, image.id]);
  assert.deepEqual(rendered.paragraphs, ["hidden", "Title\nSecond line", "One\n\nTwo <script>", "Imagen. Caption"]);
  assert.deepEqual(html("[data-paragraph-number]").map((_, node) => html(node).attr("data-paragraph-number")).get(), ["2", "3", "4"]);
  assert.equal(html("h4 br").length, 1);
  assert.equal(html("p").length, 1);
  assert.equal(html("p br").length, 2);
  assert.equal(html("h4").attr("data-include-in-toc"), "true");
  assert.equal(html("figure").attr("data-image-width"), "42");
  assert.match(html("figure").attr("style")!, /--reader-image-width:42%/u);
  assert.equal(html(".reader-reading-row").length, 2);
  assert.equal(html(".reader-reading-column").length, 1);
  assert.match(html("[data-layout-id]").first().attr("style")!, /minmax\(0,2fr\) minmax\(0,1fr\)/u);
  assert.doesNotMatch(rendered.htmlContent, /data-reading-block-number|<script>/u);
  assert.doesNotMatch(rendered.rawText + rendered.editedText, /hidden/u);
  assert.equal(load(renderVisualDocument(document, { includeInactive: true }).htmlContent)("[data-paragraph-number]").length, 4);
  const excludedHeading = renderVisualDocument(doc(block("Title", { kind: "heading", includeInToc: false })));
  assert.equal(load(excludedHeading.htmlContent)("h2").attr("data-include-in-toc"), "false");
  const literal = renderVisualDocument(doc(block("# Literal"), block(":::block literal")));
  assert.deepEqual(literal.paragraphs, ["# Literal", ":::block literal"]);
  assert.equal(load(literal.htmlContent)("p").length, 2);
});

test("legacy adapter preserves IDs, inline format, raw image references and nested row/group structure without mutation", () => {
  const ids = [randomUUID(), randomUUID(), randomUUID()];
  const source = `lector-content-image:${randomUUID()}`;
  const paragraphs = ids.map((paragraphId, index) => ({ paragraphId, paragraphNumber: index + 1,
    paragraphText: ["Title", "Bold italic", "Imagen. Caption"][index]!, role: "body" as const, readAloud: false,
    active: index !== 1, includeInToc: index === 0, imageWidth: index === 2 ? 35 : null, geometry }));
  const page = { htmlContent: `<div class="reader-reading-row"><section data-reading-block-id="oldA"><h4 data-paragraph-number="1">Title</h4><p data-paragraph-number="2"><strong>Bold</strong> <em>italic</em></p></section><section data-reading-block-id="oldB"><figure data-paragraph-number="3" data-reader-text="Imagen. Caption"><img src="${source}" alt="Caption"><figcaption>Caption</figcaption></figure></section></div>` };
  const before = structuredClone({ page, paragraphs });
  const adapted = buildVisualDocumentFromPage(page, paragraphs);
  assert.ok(visualPageDocumentSchema.safeParse(adapted).success);
  assert.deepEqual(orderedVisualBlocks(adapted).map((block) => block.id), ids);
  assert.equal(adapted.blocks[1]!.text, "**Bold** *italic*");
  assert.equal(adapted.blocks[2]!.source, source);
  assert.equal(adapted.blocks[2]!.imageWidth, 35);
  assert.equal(adapted.blocks[1]!.active, false);
  assert.deepEqual({ page, paragraphs }, before);
  assert.equal(load(renderVisualDocument(adapted, { includeInactive: true }).htmlContent)(".reader-reading-row > .reader-reading-column").length, 2);
});

test("15 stored paragraphs against 14 HTML atoms never lose IDs, metadata or DB text", () => {
  const paragraphs = Array.from({ length: 15 }, (_, i) => ({ paragraphId: randomUUID(), paragraphNumber: i + 1,
    paragraphText: `DB paragraph ${i + 1}`, role: "footer" as const, readAloud: false, active: false, includeInToc: true, imageWidth: 30, geometry }));
  const htmlContent = paragraphs.slice(0, 14).map((paragraph) => `<h2 data-paragraph-number="${paragraph.paragraphNumber}">Different HTML</h2>`).join("");
  const adapted = buildVisualDocumentFromPage({ htmlContent }, paragraphs);
  assert.equal(adapted.blocks.length, 15);
  for (const [index, atom] of adapted.blocks.entries()) {
    assert.equal(atom.id, paragraphs[index]!.paragraphId);
    assert.equal(atom.text, paragraphs[index]!.paragraphText);
    assert.equal(atom.role, "footer"); assert.equal(atom.readAloud, false); assert.equal(atom.active, false);
    assert.equal(atom.includeInToc, true); assert.equal(atom.imageWidth, 30); assert.deepEqual(atom.geometry, geometry);
  }
  const wrong = buildVisualDocumentFromPage({ htmlContent: '<h2 data-paragraph-number="1"><strong>wrong</strong></h2>' }, [paragraphs[0]!]);
  assert.equal(wrong.blocks[0]!.kind, "text"); assert.equal(wrong.blocks[0]!.text, "DB paragraph 1");
});

test("legacy unformatted fallback and matched literal punctuation do not introduce Markdown formatting or links", () => {
  const paragraphText = "_identifier_ **literal** [go](reader-page-1-paragraph-2)";
  const paragraph = { paragraphId: randomUUID(), paragraphNumber: 1, paragraphText, role: "body" as const, readAloud: true };
  for (const html of [null, `<p data-paragraph-number="1">${paragraphText}</p>`]) {
    const adapted = buildVisualDocumentFromPage(html, [paragraph]);
    const rendered = renderVisualDocument(adapted);
    assert.deepEqual(rendered.paragraphs, [paragraphText]);
    const document = load(rendered.htmlContent);
    assert.equal(document("strong, em, a").length, 0);
    assert.equal(document("p").text(), paragraphText);
  }
});

test("legacy adaptation preserves matched multiline format and explicit scale/alignment/width without inferred defaults", () => {
  const paragraph = { paragraphId: randomUUID(), paragraphNumber: 1, paragraphText: "First\nSecond", role: "body" as const, readAloud: true };
  const adapted = buildVisualDocumentFromPage('<p data-paragraph-number="1" style="font-size:1.4em;text-align:right"><strong>First</strong><br><em>Second</em></p>', [paragraph]);
  assert.equal(adapted.blocks[0]!.text, "**First**\n*Second*");
  assert.equal(adapted.blocks[0]!.fontScale, 1.4);
  assert.equal(adapted.blocks[0]!.alignment, "right");
  assert.equal(adapted.blocks[0]!.imageWidth, undefined);
  assert.deepEqual(renderVisualDocument(adapted).paragraphs, ["First\nSecond"]);
});

test("projection removes inactive numbered nodes and empty nested containers but leaves full source untouched", () => {
  const html = '<div class="reader-reading-row"><section class="reader-reading-block"><p data-paragraph-number="1">secret</p></section><div class="reader-reading-column"><p data-paragraph-number="2">visible</p></div></div>';
  assert.equal(projectActivePageHtml(html, [{ paragraphNumber: 1, active: true }]), html);
  const projected = projectActivePageHtml(html, [{ paragraphNumber: 1, active: false }, { paragraphNumber: 2, active: true }])!;
  assert.doesNotMatch(projected, /secret|reader-reading-block/u);
  assert.match(projected, /data-paragraph-number="2"/u);
  assert.match(html, /secret/u);
  const meta = { role: "image" as const, readAloud: false, active: false, includeInToc: null, imageWidth: 35, paragraphNumber: 2 };
  const annotated = annotatePageElementHtml(projected, [meta])!;
  assert.equal(annotatePageElementHtml(annotated, [meta]), annotated);
  assert.deepEqual(paragraphElementMetadataSchema.parse({ role: "body", readAloud: true }), { role: "body", readAloud: true });
});

test("sharp crops a new asset at normalized geometry, handles rotation and leaves source bytes intact", async () => {
  const buffer = await sharp({ create: { width: 100, height: 80, channels: 3, background: "red" } }).png().toBuffer();
  const before = Buffer.from(buffer);
  const cropped = await cropVisualPageImage(buffer, geometry);
  const metadata = await sharp(cropped).metadata();
  assert.equal(metadata.width, 30); assert.equal(metadata.height, 32);
  assert.deepEqual(buffer, before);
  const rotated = await cropVisualPageImage(buffer, { bbox: { left: 0, top: 0, width: 0.5, height: 0.5 } }, 90);
  assert.equal((await sharp(rotated).metadata()).width, 40);
  assert.equal((await sharp(rotated).metadata()).height, 50);
});

test("mixed paragraphs and unnumbered images survive adaptation without losing SQL text or source bindings", () => {
  const source = `lector-content-image:${randomUUID()}`;
  const paragraphs = [{ paragraphId: randomUUID(), paragraphNumber: 1, paragraphText: "Before after.", role: "body" as const, readAloud: true }];
  const original = `<p data-paragraph-number="1">Before <img src="${source}" alt="Inline"> after.</p><img src="${source}" alt="Standalone">`;
  const adapted = buildVisualDocumentFromPage(original, paragraphs);
  assert.equal(adapted.blocks[0]!.kind, "text");
  assert.equal(adapted.blocks[0]!.id, paragraphs[0]!.paragraphId);
  assert.equal(adapted.blocks[0]!.text, "Before  after.");
  const images = adapted.blocks.filter((atom) => atom.kind === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(images.map((atom) => atom.sourceKey), ["image:0", "image:1"]);
  assert.ok(images.every((atom) => atom.readAloud === false));
  images[0]!.source = `lector-content-image:${randomUUID()}`;
  const snapshot = load(visualSourceHtml(original, paragraphs, adapted)!);
  assert.equal(snapshot("img").first().attr("src"), source);
  assert.equal(snapshot("img").first().attr("data-visual-block-id"), images[0]!.id);
  const rendered = load(renderVisualDocument(adapted).htmlContent);
  assert.equal(rendered("img").length, 2);
  assert.ok(rendered.text().includes("Before  after."));
});

test("image captions keep brackets and lists remain atomic with plain narration and stable text offsets", () => {
  const image = block("Foto [1]\nSegunda linea", { kind: "image", source: `lector-content-image:${randomUUID()}` });
  const rendered = renderVisualDocument(doc(image, block("* **Uno**\n* *Dos*"), block("1. Uno\n2. Dos")));
  const html = load(rendered.htmlContent);
  assert.equal(html("img").attr("alt"), image.text);
  assert.equal(html("figcaption").text(), "Foto [1]Segunda linea");
  assert.equal(rendered.paragraphs[0], "Imagen. Foto [1]\nSegunda linea");
  assert.deepEqual(rendered.paragraphs.slice(1), ["Uno\nDos", "Uno\nDos"]);
  assert.equal(html("ul li").length, 2);
  assert.equal(html("ol li").length, 2);
  assert.equal(html("[data-paragraph-number]").length, 3);
  assert.equal(html("ul").attr("data-reader-text"), "Uno\nDos");
});
