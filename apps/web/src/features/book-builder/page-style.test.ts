import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createVisualBlock, updateVisualBlock, applyVisualPreset, pushVisualHistory, undoVisualHistory, redoVisualHistory,
  renderVisualBlockHtml, renderVisualStyle, renderVisualCompositeHtml, mergeVisualBlocks, importedVisualSourceHtml, visualDocumentSaveError, visualDocumentFromPage } from "./visual-page";
import type { BookPageResponse, PageStyle, VisualPageDocument } from "../../app/api";

const { JSDOM } = createRequire(import.meta.url)("jsdom");
const { window } = new JSDOM("");
Object.assign(globalThis, { DOMParser: window.DOMParser, Node: window.Node, Element: window.Element });
const style = { color: "#123abc", backgroundColor: "#fffefd", borderColor: "#abcdef", borderWidth: 2, padding: 12,
  fontScale: 1.5, fontFamily: "serif" as const, alignment: "center" as const };

test("frontend style renderer only emits bounded whitelist declarations", () => {
  assert.match(renderVisualStyle(style), /color:#123abc.*border-width:2px.*padding:12px.*font-size:1.5em.*font-family:serif.*text-align:center/);
  for (const unsafe of [{ color: "#123456;background:url(x)" }, { padding: 49 }, { padding: -1 }, { borderWidth: 9 },
    { fontScale: Infinity }, { fontScale: .49 }, { fontScale: 3.1 }, { fontFamily: "serif;position:fixed" }, { alignment: "center evil" }, { position: "fixed" }]) {
    assert.equal(renderVisualStyle(unsafe as unknown as PageStyle), "");
  }
});

test("editing, layout changes, history and composites preserve editorial style without changing content", () => {
  const blocks = [{ ...createVisualBlock("text"), text: "Original **body**", style }, createVisualBlock("text")];
  const doc: VisualPageDocument = { version: 1, blocks, layout: { id: crypto.randomUUID(), type: "column", children: blocks.map((block) => ({ id: crypto.randomUUID(), type: "block", blockId: block.id })) } };
  const before = structuredClone(doc);
  const edited = applyVisualPreset(updateVisualBlock(doc, blocks[0]!.id, { text: "Edited *body*", readAloud: false }), "two-columns");
  assert.deepEqual(edited.blocks[0]!.style, style);
  assert.equal(edited.blocks[0]!.text, "Edited *body*");
  assert.deepEqual(doc, before);
  const history = pushVisualHistory({ past: [], present: doc, future: [] }, edited);
  assert.deepEqual(redoVisualHistory(undoVisualHistory(history)).present, edited);
  const html = new window.DOMParser().parseFromString(renderVisualBlockHtml(edited.blocks[0]!), "text/html");
  assert.equal(html.querySelector("p").style.fontSize, "1.5em");
  assert.equal(html.querySelector("em").textContent, "body");
  const joined = mergeVisualBlocks(edited, blocks.map((block) => block.id), { kind: "text", separator: "paragraph", includeInToc: false, fontScale: 2 });
  // Find the compound independent of its former parents.
  const find = (node: VisualPageDocument["layout"]): typeof node | undefined => node.type === "block" ? undefined : node.content ? node : node.children.map(find).find(Boolean);
  const compound = find(joined.layout)!;
  assert.ok(compound.type !== "block");
  const composite = new window.DOMParser().parseFromString(renderVisualCompositeHtml(compound, joined.blocks), "text/html");
  assert.equal(composite.querySelector("div").style.fontSize, "2em");
  assert.equal(composite.querySelector("p").style.fontSize, "");
  assert.equal(composite.querySelector("p").style.padding, "12px");
  assert.deepEqual(joined.blocks[0]!.style, style);
  assert.equal(visualDocumentSaveError(edited), null);
  assert.ok(visualDocumentSaveError({ ...edited, blocks: [{ ...edited.blocks[0]!, style: { padding: 99 } }, edited.blocks[1]!] }));
});

test("images separate alt from visible caption and imported HTML only retains safe editorial CSS", () => {
  const image = { ...createVisualBlock("image"), source: "https://example.com/image.png", text: "Printed caption", altText: "A portrait", style };
  const html = new window.DOMParser().parseFromString(renderVisualBlockHtml(image), "text/html");
  assert.equal(html.querySelector("img").alt, "A portrait");
  assert.equal(html.querySelector("figcaption").textContent, "Printed caption");
  assert.doesNotMatch(renderVisualBlockHtml({ ...image, text: "" }), /figcaption/);
  const multiline = { ...image, text: "Printed & literal <caption>\nSecond line" };
  const source = renderVisualBlockHtml(multiline).replace("<figure", '<figure data-paragraph-number="1" data-image-alt-separated="true"');
  const adapted = visualDocumentFromPage({ paragraphs: [{ paragraphId: image.id, paragraphNumber: 1, paragraphText: "Imagen. A portrait", role: "image", readAloud: true }], htmlContent: source } as BookPageResponse["page"]);
  assert.equal(adapted.blocks[0]!.text, multiline.text);
  assert.equal(adapted.blocks[0]!.altText, multiline.altText);
  assert.deepEqual(adapted.blocks[0]!.style, style);
  const page = { paragraphs: [{ paragraphId: "original", paragraphNumber: 1 }], htmlContent: '<p data-paragraph-number="1" onclick="evil()" style="position:fixed;color:#123abc;padding:12px;background-image:url(https://evil.invalid)">Original</p>' } as BookPageResponse["page"];
  const doc = { version: 1, blocks: [], layout: { id: crypto.randomUUID(), type: "column", children: [] } } as VisualPageDocument;
  const imported = importedVisualSourceHtml(page, doc);
  assert.match(imported, /color:#123abc;padding:12px/);
  assert.doesNotMatch(imported, /evil|position|background-image/);
  assert.match(imported, />Original</);
});
