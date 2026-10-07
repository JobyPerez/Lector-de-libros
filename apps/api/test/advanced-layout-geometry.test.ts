import assert from "node:assert/strict";
import test from "node:test";
import { advancedLayoutSchema, buildAdvancedVisualDocument } from "../src/modules/books/advanced-layout.js";
import type { OcrPageResult } from "../src/modules/books/image-ocr.js";
import type { ParagraphElementMetadata } from "../src/modules/books/page-elements.js";
import { visualPageDocumentSchema, type VisualLayoutNode } from "../src/modules/books/visual-document.js";

const leaf = (blockIndex: number) => ({ type: "block", blockIndex });
const column = (...children: unknown[]) => ({ type: "column", children });
const row = (...children: unknown[]) => ({ type: "row", children });
const figure = (...children: unknown[]) => ({ ...column(...children), semantic: "figure" });
const box = (left: number, top: number, width: number, height = 0.1) => ({ bbox: { left, top, width, height } });
function page(metadata: ParagraphElementMetadata[]): OcrPageResult {
  const paragraphs = metadata.map((item, index) => item.role === "image" ? "Imagen. Illustration" : `Text ${index + 1}`);
  return {
    editedText: paragraphs.join("\n"), rawText: paragraphs.join("\n"), paragraphs, paragraphMetadata: metadata,
    htmlContent: metadata.map((item, index) => `<div data-reading-block-id="advanced-${index + 1}">${item.role === "image"
      ? `<figure data-paragraph-number="${index + 1}"><img src="https://example.org/image.png" alt="Illustration"></figure>`
      : `<p data-paragraph-number="${index + 1}">${paragraphs[index]}</p>`}</div>`).join("")
  };
}
const image = (geometry?: ParagraphElementMetadata["geometry"]): ParagraphElementMetadata => ({ role: "image", readAloud: false, geometry, imageWidth: 100 });
const text = (geometry?: ParagraphElementMetadata["geometry"]): ParagraphElementMetadata => ({ role: "body", readAloud: true, geometry });
function build(metadata: ParagraphElementMetadata[], layout: unknown) {
  return buildAdvancedVisualDocument(page(metadata), advancedLayoutSchema.parse(layout), metadata.length);
}
function container(node: VisualLayoutNode) {
  assert.notEqual(node.type, "block");
  if (node.type === "block") throw new Error("Expected container");
  return node;
}

test("final nested figure uses image/caption union, sidebar uses image/text union, margins do not widen them", () => {
  const document = build([
    image(box(0.15, 0.2, 0.2)), { ...text(box(0.1, 0.35, 0.4)), role: "imageCaption" },
    image(box(0.65, 0.2, 0.1)), text(box(0.6, 0.4, 0.3)),
    { ...text(box(0, 0, 1)), role: "header" }, { ...text(box(0, 0.6, 1)), active: false }
  ], column(leaf(5), row(figure(leaf(1), leaf(2)), column(leaf(3), leaf(4), leaf(6)))));
  assert.deepEqual(document.blocks.filter((block) => block.kind === "image").map((block) => block.imageWidth), [50, 33]);
  const horizontal = container(container(document.layout).children[1]!);
  assert.ok(Math.abs(horizontal.weights![0]! / horizontal.weights![1]! - 4 / 3) < 1e-10);
  visualPageDocumentSchema.parse(document);
});

test("row image leaves own their assigned area and reversed children normalize with unequal weights", () => {
  const document = build([image(box(0.1, 0.2, 0.2)), image(box(0.4, 0.2, 0.5))], { ...row(leaf(2), leaf(1)), weights: [99, 1] });
  const horizontal = container(document.layout);
  assert.deepEqual(horizontal.children.map((child) => child.type === "block" ? child.blockId : ""), document.blocks.map((block) => block.id));
  assert.deepEqual(document.blocks.map((block) => block.imageWidth), [100, 100]);
  assert.ok(Math.abs(horizontal.weights![1]! / horizontal.weights![0]! - 2.5) < 1e-10);
});

test("weights are inferred from full child unions, not just their first blocks", () => {
  const document = build([text(box(0.1, 0.1, 0.1)), text(box(0.1, 0.3, 0.3)), text(box(0.5, 0.1, 0.4))],
    row(column(leaf(1), leaf(2)), column(leaf(3))));
  const weights = container(document.layout).weights!;
  assert.ok(Math.abs(weights[0]! / weights[1]! - 0.75) < 1e-10);
});

test("advanced columns discard vertical weights at every depth without mutating inputs", () => {
  const source = page([image(box(0.2, 0.2, 0.2)), text(box(0.1, 0.4, 0.5))]);
  const layout = advancedLayoutSchema.parse({ ...column({ ...column(leaf(1), leaf(2)), weights: [9, 1], style: { padding: 8 } }), weights: [3] });
  const before = structuredClone({ source, layout });
  const document = buildAdvancedVisualDocument(source, layout, 2);
  assert.equal(container(document.layout).weights, undefined);
  assert.equal(container(container(document.layout).children[0]!).weights, undefined);
  assert.equal(document.blocks[0]!.imageWidth, 40);
  assert.deepEqual({ source, layout }, before);
  container(container(document.layout).children[0]!).style!.padding = 12;
  assert.deepEqual({ source, layout }, before);
});

test("overlapping horizontal extents in clearly separated vertical bands repair to a column", () => {
  const document = build([text(box(0.1, 0.1, 0.7)), text(box(0.2, 0.6, 0.6))], { ...row(leaf(2), leaf(1)), weights: [5, 1] });
  const vertical = container(document.layout);
  assert.equal(vertical.type, "column");
  assert.equal(vertical.weights, undefined);
  assert.deepEqual(vertical.children.map((child) => child.type === "block" && child.blockId), document.blocks.map((block) => block.id));
  visualPageDocumentSchema.parse(document);
});

test("broad overlapping editorial columns fail even when their union vertical bands overlap", () => {
  assert.throws(() => build([
    text(box(0.1, 0.1, 0.35)), text(box(0.1, 0.7, 0.7)),
    image(box(0.55, 0.1, 0.3)), text(box(0.5, 0.6, 0.35))
  ], row(column(leaf(1), leaf(2)), column(leaf(3), leaf(4)))), /Invalid advanced row geometry/u);
});

test("split image captions later in a column cannot hide horizontally paired image leaves", () => {
  assert.throws(() => build([
    image(box(0.1, 0.2, 0.3)), image(box(0.6, 0.2, 0.3)),
    text(box(0.1, 0.4, 0.3)), text(box(0.6, 0.4, 0.3))
  ], column(leaf(1), leaf(2), row(leaf(3), leaf(4)))), {
    message: "Invalid advanced column geometry: horizontally aligned images or figures require a row; group each image with its caption first."
  });
});

test("paired semantic figures require a row; vertically stacked images remain valid", () => {
  const metadata = [image(box(0.1, 0.1, 0.3)), text(box(0.1, 0.3, 0.3)), image(box(0.6, 0.1, 0.3)), text(box(0.6, 0.3, 0.3))];
  assert.throws(() => build(metadata, column(figure(leaf(1), leaf(2)), figure(leaf(3), leaf(4)))), /require a row/u);
  visualPageDocumentSchema.parse(build(metadata, row(figure(leaf(1), leaf(2)), figure(leaf(3), leaf(4)))));
  visualPageDocumentSchema.parse(build([image(box(0.1, 0.1, 0.3)), image(box(0.1, 0.5, 0.3))], column(leaf(1), leaf(2))));
});

test("unknown text geometry does not invent row weights/order or reject table cells", () => {
  const cell = (index: number) => ({ ...column(leaf(index)), semantic: "tableCell" });
  const document = build([text(), text()], { ...column({ ...row(cell(2), cell(1)), semantic: "tableRow", weights: [2, 3] }), semantic: "table" });
  const tableRow = container(container(document.layout).children[0]!);
  assert.deepEqual(tableRow.weights, [2, 3]);
  assert.equal(container(tableRow.children[0]!).semantic, "tableCell");
  visualPageDocumentSchema.parse(document);
  const partial = build([text(box(0.1, 0.1, 0.3)), text(), image(box(0.6, 0.1, 0.2))],
    { ...row(column(leaf(1), leaf(2)), leaf(3)), weights: [7, 2] });
  assert.deepEqual(container(partial.layout).weights, [7, 2]);
  assert.equal(partial.blocks[2]!.imageWidth, 100);
});

test("complete table cell geometry normalizes left/right order and weights without losing semantics", () => {
  const cell = (index: number) => ({ ...column(leaf(index)), semantic: "tableCell" });
  const document = build([text(box(0.1, 0.2, 0.2)), text(box(0.5, 0.2, 0.4))],
    { ...column({ ...row(cell(2), cell(1)), semantic: "tableRow" }), semantic: "table" });
  const tableRow = container(container(document.layout).children[0]!);
  assert.equal(tableRow.semantic, "tableRow");
  assert.ok(Math.abs(tableRow.weights![1]! / tableRow.weights![0]! - 2) < 1e-10);
  visualPageDocumentSchema.parse(document);
});

test("depth-eight roots stay within canonical budgets without adding wrappers", () => {
  let layout: unknown = leaf(1);
  for (let i = 0; i < 7; i++) layout = column(layout);
  const document = build([image(box(0.1, 0.1, 0.2))], layout);
  visualPageDocumentSchema.parse(document);
  let node = document.layout;
  let depth = 1;
  while (node.type !== "block") { node = node.children[0]!; depth++; }
  assert.equal(depth, 8);
  assert.equal(document.blocks[0]!.imageWidth, 100);
});

test("adjacent horizontal areas tolerate normalized floating-point rounding", () => {
  visualPageDocumentSchema.parse(build([text(box(0.1, 0.2, 0.2)), text(box(0.3, 0.2, 0.4))], row(leaf(1), leaf(2))));
});

test("500 blocks and exactly 1000 final nodes pass canonical validation", () => {
  const children = Array.from({ length: 499 }, (_, index) => column(leaf(index + 1)));
  const document = build(Array.from({ length: 500 }, () => text()), column(...children, leaf(500)));
  assert.equal(document.blocks.length, 500);
  visualPageDocumentSchema.parse(document);
});

test("slightly overlapping predicted captions permit left/right normalization and unequal weights", () => {
  const metadata = [image(box(0.1, 0.1, 0.2)), { ...text(box(0.1, 0.3, 0.302)), role: "imageCaption" as const },
    image(box(0.42, 0.1, 0.45)), { ...text(box(0.397, 0.3, 0.5)), role: "imageCaption" as const }];
  const source = page(metadata);
  const layout = advancedLayoutSchema.parse({ ...row(figure(leaf(3), leaf(4)), figure(leaf(1), leaf(2))), weights: [1, 99] });
  const before = structuredClone({ source, layout });
  const document = buildAdvancedVisualDocument(source, layout, 4);
  const horizontal = container(document.layout);
  const left = container(horizontal.children[0]!);
  assert.equal(left.semantic, "figure");
  assert.equal(left.children[0]!.type === "block" && left.children[0]!.blockId, document.blocks[0]!.id);
  assert.ok(Math.abs(horizontal.weights![0]! / horizontal.weights![1]! - 0.302 / 0.5) < 1e-10);
  assert.deepEqual(document.blocks.filter((block) => block.kind === "image").map((block) => block.imageWidth), [66, 90]);
  assert.deepEqual({ source, layout }, before);
  visualPageDocumentSchema.parse(document);
});

test("row overlap tolerance is capped at two percent of page and fifteen percent of narrower child", () => {
  for (const overlap of [0.019, 0.02]) {
    visualPageDocumentSchema.parse(build([text(box(0.1, 0.1, 0.4)), text(box(0.5 - overlap, 0.1, 0.4))], row(leaf(1), leaf(2))));
  }
  assert.throws(() => build([text(box(0.1, 0.1, 0.4)), text(box(0.479, 0.1, 0.4))], row(leaf(1), leaf(2))), /"overlap":0.021,"allowedOverlap":0.02/u);
  visualPageDocumentSchema.parse(build([text(box(0.1, 0.1, 0.04)), text(box(0.134, 0.1, 0.4))], row(leaf(1), leaf(2))));
  assert.throws(() => build([text(box(0.1, 0.1, 0.04)), text(box(0.13, 0.1, 0.4))], row(leaf(1), leaf(2))), /"overlap":0.01,"allowedOverlap":0.006/u);
});

test("captured top figure unions still reject substantial caption crossing despite separate source images", () => {
  // Cached AWS image geometry + predicted caption geometry from capture2, no provider or file dependency.
  const metadata = [
    image(box(0.06537890044576523, 0.09474885844748858, 0.4175334323922734, 0.21118721461187215)),
    { ...text(box(0.049, 0.293, 0.308, 0.016)), role: "imageCaption" as const },
    image(box(0.487369985141159, 0.09474885844748858, 0.41901931649331353, 0.2134703196347032)),
    { ...text(box(0.353, 0.293, 0.507, 0.016)), role: "imageCaption" as const }
  ];
  assert.throws(() => build(metadata, column(row(figure(leaf(1), leaf(2)), figure(leaf(3), leaf(4))))),
    /"path":"layout.children\[0\]".*"overlap":0.129912,"allowedOverlap":0.02/u);
});

test("captured table versus merged lower zone cannot be accepted by a caption tolerance", () => {
  assert.throws(() => build([text(box(0.049, 0.307, 0.809, 0.14)), text(box(0.049, 0.412, 0.8677904903417532, 0.5274977168949773))],
    row(column(leaf(1)), column(leaf(2)))), /"overlap":0.809,"allowedOverlap":0.02/u);
});

test("captured separate table and lower zones repair to column[table, row[sidebar, column[evolution,map]]]", () => {
  const metadata = [text(box(0.05, 0.327, 0.4, 0.118)), text(box(0.5, 0.327, 0.4, 0.118)),
    image(box(0.063893, 0.469178, 0.138187, 0.364155)),
    { ...text(box(0.06, 0.837, 0.2, 0.015)), role: "imageCaption" as const }, text(box(0.05, 0.86, 0.24, 0.07)),
    { ...text(box(0.350669, 0.488, 0.558482, 0.02)), role: "heading" as const, includeInToc: true },
    image(box(0.350669, 0.521689, 0.36107, 0.101599)),
    text(box(0.349183, 0.658, 0.567608, 0.017)), image(box(0.349183, 0.675799, 0.567608, 0.263699))];
  const cell = (index: number) => ({ ...column(leaf(index)), semantic: "tableCell" });
  const table = { ...column({ ...row(cell(1), cell(2)), semantic: "tableRow" }), semantic: "table" };
  const sidebar = { ...column(figure(leaf(3), leaf(4)), leaf(5)), style: { backgroundColor: "#abcdef", padding: 8 } };
  const evolution = { ...column(leaf(6), figure(leaf(7))), style: { padding: 4 } };
  const map = figure(leaf(8), leaf(9));
  const source = page(metadata);
  const layout = advancedLayoutSchema.parse({ ...row(row(map, sidebar, evolution), table), gap: 16, style: { padding: 12 }, weights: [1, 9] });
  const before = structuredClone({ source, layout });
  const document = buildAdvancedVisualDocument(source, layout, metadata.length);
  const root = container(document.layout);
  assert.equal(root.type, "column");
  assert.deepEqual(root.style, { padding: 12 });
  assert.equal(root.gap, 16);
  assert.equal(root.weights, undefined);
  const finalTable = container(root.children[0]!);
  assert.equal(finalTable.semantic, "table");
  const tableRow = container(finalTable.children[0]!);
  assert.equal(tableRow.type, "row");
  assert.equal(tableRow.semantic, "tableRow");
  assert.ok(tableRow.children.every((child) => container(child).semantic === "tableCell"));
  const lower = container(root.children[1]!);
  assert.equal(lower.type, "row");
  assert.equal(lower.children.length, 2);
  assert.deepEqual(container(lower.children[0]!).style, sidebar.style);
  const right = container(lower.children[1]!);
  assert.equal(right.type, "column");
  assert.equal(right.weights, undefined);
  assert.deepEqual(container(right.children[0]!).style, evolution.style);
  assert.equal(container(right.children[1]!).semantic, "figure");
  assert.ok(Math.abs(lower.weights![0]! / lower.weights![1]! - 0.24 / 0.567608) < 1e-10);
  const references: string[] = [];
  const nodeIds = new Set<string>();
  const visit = (node: VisualLayoutNode) => {
    assert.equal(nodeIds.has(node.id), false);
    nodeIds.add(node.id);
    if (node.type === "block") references.push(node.blockId);
    else node.children.forEach(visit);
  };
  visit(root);
  assert.deepEqual(references, document.blocks.map((block) => block.id));
  assert.deepEqual({ source, layout }, before);
  const correct = build(metadata, column(table, row(sidebar, column(evolution, map))));
  assert.deepEqual(document.blocks.map(({ id: _, ...block }) => block), correct.blocks.map(({ id: _, ...block }) => block));
  visualPageDocumentSchema.parse(document);
});

test("whole vertical cuts group multiple children into rows and retain singleton subtrees", () => {
  const document = build([text(box(0.1, 0.1, 0.8)), text(box(0.1, 0.4, 0.2)), text(box(0.5, 0.4, 0.4))],
    { ...row(column(leaf(3)), column(leaf(1)), column(leaf(2))), style: { padding: 6 }, gap: 20 });
  const root = container(document.layout);
  assert.equal(root.type, "column");
  assert.deepEqual(root.style, { padding: 6 });
  const first = container(root.children[0]!);
  assert.equal(first.type, "column");
  assert.equal(first.children.length, 1);
  const second = container(root.children[1]!);
  assert.equal(second.type, "row");
  assert.equal(second.style, undefined);
  assert.equal(second.gap, 20);
  assert.ok(Math.abs(second.weights![1]! / second.weights![0]! - 2) < 1e-10);
  visualPageDocumentSchema.parse(document);
});

test("semantic table rows never repair vertically separated cells into columns", () => {
  const cell = (index: number) => ({ ...column(leaf(index)), semantic: "tableCell" });
  assert.throws(() => build([text(box(0.1, 0.1, 0.5)), text(box(0.1, 0.5, 0.5))],
    { ...column({ ...row(cell(1), cell(2)), semantic: "tableRow" }), semantic: "table" }), /Invalid advanced row geometry/u);
});

test("unknown geometry or insufficient vertical gap cannot trigger deterministic repair", () => {
  assert.throws(() => build([text(box(0.1, 0.1, 0.5)), text(box(0.1, 0.203, 0.5))], row(leaf(1), leaf(2))), /Invalid advanced row geometry/u);
  const document = build([text(box(0.1, 0.1, 0.5)), text()], row(leaf(1), leaf(2)));
  assert.equal(container(document.layout).type, "row");
  assert.equal(container(document.layout).weights, undefined);
  // Known boxes alone cannot authorize repair of a subtree whose geometry is incomplete.
  assert.throws(() => build([text(box(0.1, 0.1, 0.5)), text(), text(box(0.1, 0.5, 0.5))],
    row(column(leaf(1), leaf(2)), leaf(3))), /Invalid advanced row geometry/u);
});

test("horizontal overlap clusters with mutually overlapping vertical intervals remain ambiguous", () => {
  assert.throws(() => build([text(box(0.05, 0.1, 0.2, 0.8)), text(box(0.35, 0.1, 0.5, 0.2)),
    text(box(0.35, 0.25, 0.5, 0.2)), text(box(0.35, 0.6, 0.5, 0.2))], row(leaf(1), leaf(2), leaf(3), leaf(4))),
  /Invalid advanced row geometry/u);
});

test("repair-created containers cannot bypass canonical depth or node budgets", () => {
  const metadata = [text(box(0.05, 0.1, 0.2, 0.8)), text(box(0.35, 0.1, 0.5, 0.2)), text(box(0.35, 0.6, 0.5, 0.2))];
  let layout: unknown = row(leaf(1), leaf(2), leaf(3));
  for (let i = 0; i < 6; i++) layout = column(layout);
  assert.throws(() => build(metadata, layout), /1000 nodos, profundidad 8/u);
  const others = Array.from({ length: 496 }, (_, i) => column(leaf(i + 4)));
  // Use exactly 500 blocks / 1000 original nodes: the extra wrapper exhausts the node budget.
  const bounded = column(row(leaf(1), leaf(2), leaf(3)), ...others, column(column(leaf(500))));
  assert.equal(advancedLayoutSchema.safeParse(bounded).success, true);
  assert.throws(() => build([...metadata, ...Array.from({ length: 497 }, () => text())], bounded), /1000 nodos, profundidad 8/u);
});
