import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { load } from "cheerio";
import sharp from "sharp";
import { pageStyleSchema, parsePageStyle, renderPageStyle } from "../src/modules/books/page-style.js";
import { buildStructuredVisionPage, buildVisionOcrPrompt, runOcrOnImage } from "../src/modules/books/image-ocr.js";
import { buildRichPageFromParagraphs } from "../src/modules/books/rich-content.js";
import { buildVisualDocumentFromPage, renderVisualDocument, visualPageDocumentSchema, type VisualStoredParagraph } from "../src/modules/books/visual-document.js";

const style = { color: "#123abc", backgroundColor: "#fffefd", borderColor: "#abcdef", borderWidth: 2,
  padding: 12, fontScale: 1.5, fontFamily: "serif" as const, alignment: "center" as const };
function stored(page: { paragraphs: string[]; paragraphMetadata?: object[] }): VisualStoredParagraph[] {
  return page.paragraphs.map((paragraphText, index) => ({ paragraphId: randomUUID(), paragraphNumber: index + 1,
    paragraphText, role: "body", readAloud: true, ...page.paragraphMetadata?.[index] }));
}

test("editorial style strictly validates enums, hex colors and finite bounded numbers", () => {
  assert.deepEqual(parsePageStyle(renderPageStyle(style)), style);
  assert.equal(pageStyleSchema.parse({ color: "#ABCDEF" }).color, "#abcdef");
  for (const value of [{ color: "red" }, { color: "#fff" }, { color: "#123456;background:url(x)" },
    { backgroundColor: "url(https://evil.invalid)" }, { borderWidth: 8.1 }, { borderWidth: -1 },
    { padding: 49 }, { padding: -1 }, { fontScale: .49 }, { fontScale: 3.01 }, { fontScale: Infinity },
    { fontScale: "1" }, { fontFamily: "Arial" }, { alignment: "justify" }, { position: "fixed" },
    { cssText: "color:red" }, { padding: NaN }]) {
    assert.equal(pageStyleSchema.safeParse(value).success, false, JSON.stringify(value));
    assert.throws(() => renderPageStyle(value as typeof style));
  }
  for (const value of [{ borderWidth: 0, padding: 0, fontScale: .5 }, { borderWidth: 8, padding: 48, fontScale: 3 }]) {
    assert.deepEqual(parsePageStyle(renderPageStyle(value)), value);
  }
  assert.deepEqual(parsePageStyle("position:fixed;background-image:url(x);color:#ABCDEF;padding:48px;font-family:serif;"), { color: "#abcdef", padding: 48, fontFamily: "serif" });
  for (const css of ["color:#123456 !important", "padding:4px 8px", "padding:calc(4px)", "font-size:4em", "font-family:serif,url(x)", "text-align:center evil", "border-width:99px", "color:var(--evil)"]) assert.equal(parsePageStyle(css), undefined, css);
});

test("paragraph options do not add style markers or shift past empty text and layout markers", () => {
  const plain = buildRichPageFromParagraphs([":::block intro", "", "**Original**", ":::block end", "Final"], { inferHeadings: false });
  const styled = buildRichPageFromParagraphs([":::block intro", "", "**Original**", ":::block end", "Final"], { inferHeadings: false, paragraphStyles: [style, { color: "#000000" }] });
  assert.equal(styled.editedText, plain.editedText);
  assert.deepEqual(styled.paragraphs, plain.paragraphs);
  const html = load(styled.htmlContent!);
  assert.deepEqual(parsePageStyle(html('[data-paragraph-number="1"]').attr("style")!), style);
  assert.equal(parsePageStyle(html('[data-paragraph-number="2"]').attr("style")!)?.color, "#000000");
});

test("Vision styles and independent image alt/caption survive HTML adaptation, edits and render", async () => {
  const buffer = await sharp({ create: { width: 200, height: 200, channels: 3, background: "white" } }).png().toBuffer();
  const input = [{ type: "heading" as const, text: "**Original title**", level: 2, readingBlockId: "title", style },
    { type: "paragraph" as const, text: "Original *body*.", readingBlockId: "body", style: { color: "#654321" } },
    { type: "image" as const, bbox: { x: 100, y: 100, width: 500, height: 500 }, altText: "A portrait", caption: "Printed caption", style: { padding: 4 } }];
  const before = structuredClone(input);
  const page = await buildStructuredVisionPage(buffer, input, [], "");
  assert.equal(page.paragraphs[2], "Imagen. A portrait Printed caption");
  assert.deepEqual(input, before);
  const doc = buildVisualDocumentFromPage(page.htmlContent, stored(page));
  assert.deepEqual(doc.blocks[0]!.style, style);
  assert.equal(doc.blocks[0]!.text, "**Original title**");
  assert.equal(doc.blocks[2]!.text, "Printed caption");
  assert.equal(doc.blocks[2]!.altText, "A portrait");
  doc.blocks[1]!.text = "Edited **body**.";
  const rendered = renderVisualDocument(doc);
  const roundtrip = buildVisualDocumentFromPage(rendered.htmlContent, stored(rendered));
  assert.deepEqual(roundtrip.blocks.map((block) => block.style), doc.blocks.map((block) => block.style));
  assert.deepEqual(roundtrip.blocks.map((block) => block.text), doc.blocks.map((block) => block.text));
  assert.equal(roundtrip.blocks[2]!.altText, "A portrait");
  const html = load(rendered.htmlContent);
  assert.equal(html("figcaption").text(), "Printed caption");
  assert.equal(html("img").attr("alt"), "A portrait");
  const multiline = structuredClone(doc);
  multiline.blocks[2]!.text = "Printed & literal <caption>\nSecond line";
  const multilineRendered = renderVisualDocument(multiline);
  assert.equal(buildVisualDocumentFromPage(multilineRendered.htmlContent, stored(multilineRendered)).blocks[2]!.text, multiline.blocks[2]!.text);
  assert.equal(visualPageDocumentSchema.safeParse({ ...doc, blocks: [{ ...doc.blocks[0], style: { position: "fixed" } }, ...doc.blocks.slice(1)] }).success, false);
  const noCaption = await buildStructuredVisionPage(buffer, [{ ...input[2]!, caption: "" }], [], "");
  assert.equal(load(noCaption.htmlContent!)("figcaption").length, 0);
  for (const language of ["es", "it"] as const) assert.match(buildVisionOcrPrompt(language).system, /#RRGGBB.*0-8.*0-48.*0\.5-3/u);
});

test("legacy images keep caption semantics and hostile source CSS cannot escape whitelist", () => {
  const page = buildRichPageFromParagraphs(["![Legacy caption](https://example.com/image.png)"]);
  const doc = buildVisualDocumentFromPage(page.htmlContent, stored(page));
  assert.equal(doc.blocks[0]!.altText, undefined);
  assert.equal(load(renderVisualDocument(doc).htmlContent)("figcaption").text(), "Legacy caption");
  const hostile = '<p data-paragraph-number="1" style="position:fixed;background-image:url(https://evil.invalid);color:#123456;padding:999px;font-family:serif">Original</p>';
  const safe = buildVisualDocumentFromPage(hostile, stored({ paragraphs: ["Original"] }));
  assert.deepEqual(safe.blocks[0]!.style, { color: "#123456", fontFamily: "serif" });
  assert.doesNotMatch(renderVisualDocument(safe).htmlContent, /evil|position:|999px/u);
});

test("all three Vision transports use the same style contract and reject hostile model output before rendering", async (t) => {
  const buffer = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  let blocks: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    const prompt = body.instructions ?? body.contents?.[0]?.parts?.[0]?.text ?? body.messages?.[0]?.content;
    assert.match(prompt, /No arbitrary CSS/);
    const response = JSON.stringify({ blocks });
    if (body.contents) return Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: response }] } }] });
    if (body.input) return Response.json({ output_text: response });
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: response } }] });
  });
  for (const model of ["gpt-5.4-mini", "gemini-3.5-flash-lite", "mock-chat-model"]) {
    const options = { ocrMode: "VISION" as const, model, opencodeApiKey: "mock-key" };
    for (const block of [{ type: "paragraph", text: "Original." }, { type: "heading", text: "Title", level: 2 },
      { type: "image", altText: "Portrait", caption: "Printed text", bbox: { x: 0, y: 0, width: 500, height: 500 } }]) {
      blocks = [{ ...block, style }];
      const page = await runOcrOnImage(buffer, "page.png", "image/png", options);
      assert.deepEqual(parsePageStyle(load(page.htmlContent!)(".reader-rich-node").attr("style")!), style);
      for (const unsafe of [{ color: "url(x)" }, { backgroundColor: "#123456;position:fixed" }, { padding: 99 }, { fontFamily: "Arial" }, { cssText: "color:red" }]) {
        blocks = [{ ...block, style: unsafe }];
        await assert.rejects(runOcrOnImage(buffer, "page.png", "image/png", options), { code: "OCR_INVALID_RESPONSE" });
      }
    }
  }
});
