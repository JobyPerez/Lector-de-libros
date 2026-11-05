import assert from "node:assert/strict";
import test from "node:test";
import type { VisualBlock, VisualLayoutNode, VisualPageDocument } from "../src/app/api";
import { orderedVisualBlocks, placeVisualImagesFromGeometry, pushVisualHistory, undoVisualHistory } from "../src/features/book-builder/visual-page";

function block(id: string, top: number, image = false, left = .1, width = .8): VisualBlock {
  return { id, kind: image ? "image" : "text", text: id, active: true, readAloud: !image,
    role: image ? "image" : "body", geometry: { bbox: { left, top, width, height: .1 } }, ...(image ? { source: "page-crop" } : {}) };
}
const leaf = (id: string): VisualLayoutNode => ({ id: `leaf-${id}`, type: "block", blockId: id });
function document(blocks: VisualBlock[]): VisualPageDocument {
  return { version: 1, blocks, layout: { id: "root", type: "column", children: blocks.map((block) => leaf(block.id)) } };
}
test("repair moves a top image before text without changing content, IDs or metadata and supports undo", () => {
  const doc = document([block("text1", .5), block("text2", .7), block("image", .1, true)]);
  const original = JSON.stringify(doc), next = placeVisualImagesFromGeometry(doc);
  assert.deepEqual(orderedVisualBlocks(next).map((block) => block.id), ["image", "text1", "text2"]);
  assert.equal(next.blocks, doc.blocks);
  assert.equal(JSON.stringify(doc), original);
  assert.equal(placeVisualImagesFromGeometry(next), next, "repair is idempotent");
  const history = pushVisualHistory({ past: [], present: doc, future: [] }, next);
  assert.equal(undoVisualHistory(history).present, doc);
});
test("repair keeps two columns intact and inserts a local image before its caption", () => {
  const doc = document([block("left1", .1, false, .1, .3), block("left2", .6, false, .1, .3),
    block("right1", .1, false, .6, .3), block("caption", .5, false, .6, .3), block("image", .3, true, .6, .3)]);
  doc.layout = { id: "root", type: "column", children: [{ id: "columns", type: "row", weights: [2, 3], children: [
    { id: "left", type: "column", children: [leaf("left1"), leaf("left2")] },
    { id: "right", type: "column", children: [leaf("right1"), leaf("caption"), leaf("image")] }
  ] }] };
  const next = placeVisualImagesFromGeometry(doc);
  assert.deepEqual(orderedVisualBlocks(next).map((block) => block.id), ["left1", "left2", "right1", "image", "caption"]);
  assert.deepEqual(next.layout.type !== "block" && next.layout.children[0]!.type !== "block" && next.layout.children[0]!.weights, [2, 3]);
});
test("unknown/overlapping zones do not trigger a speculative reorder and joined blocks stay intact", () => {
  const image = block("image", .5, true);
  const unknown = { ...image, geometry: null };
  const doc = document([unknown, block("text", .5)]);
  assert.equal(placeVisualImagesFromGeometry(doc), doc);
  const overlapping = document([image, block("text", .5)]);
  assert.equal(placeVisualImagesFromGeometry(overlapping), overlapping);
  const joined = document([block("first", .5), block("second", .65), block("image", .1, true)]);
  const composite: VisualLayoutNode = { id: "joined", type: "column", content: { kind: "text", separator: "paragraph", includeInToc: false }, children: [leaf("first"), leaf("second")] };
  joined.layout = { id: "root", type: "column", children: [composite, leaf("image")] };
  const next = placeVisualImagesFromGeometry(joined);
  assert.deepEqual(orderedVisualBlocks(next).map((block) => block.id), ["image", "first", "second"]);
  assert.equal(next.layout.type !== "block" && next.layout.children[1], composite);
});

test("multiple pictures, footer and layout weights retain their associations", () => {
  const doc = document([block("text", .5), block("footer", .95), block("bottom", .75, true), block("top", .1, true)]);
  if (doc.layout.type !== "block") doc.layout.weights = [2, 3, 4, 5];
  const next = placeVisualImagesFromGeometry(doc);
  assert.deepEqual(orderedVisualBlocks(next).map((block) => block.id), ["top", "text", "bottom", "footer"]);
  assert.deepEqual(next.layout.type !== "block" && next.layout.weights, [5, 2, 4, 3]);
  assert.equal(placeVisualImagesFromGeometry(next), next);
});
