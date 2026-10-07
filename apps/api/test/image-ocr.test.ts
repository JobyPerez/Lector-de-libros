import assert from "node:assert/strict";
import test from "node:test";
import { TextractClient, type Block } from "@aws-sdk/client-textract";
import { load } from "cheerio";
import sharp from "sharp";
import Tesseract from "tesseract.js";

import { appEnv } from "../src/config/env.js";
import { buildStructuredVisionPage, buildTextractPage, buildVisionOcrPrompt, groupTextractLayoutBlocks, runOcrOnImage } from "../src/modules/books/image-ocr.js";
import { buildRichPageFromEditableText, hasValidReadingBlockMarkers } from "../src/modules/books/rich-content.js";
import { historyPage4Geometry } from "./fixtures/history-page4-geometry.js";
import { inferHintedMargin } from "../src/modules/books/ocr-margins.js";

function marginFixture(): Block[] {
  return [
    layout("header", "LAYOUT_SECTION_HEADER", "Author Name", 0.4196, 0.0523, 0.1164, 0.0167),
    layout("body", "LAYOUT_TEXT", "Generic body paragraph.", 0.11, 0.105, 0.78, 0.78),
    layout("footer", "LAYOUT_FOOTER", "Book Label", 0.4349, 0.9289, 0.08575, 0.0176),
    layout("number", "LAYOUT_PAGE_NUMBER", "71", 0.8483, 0.9358, 0.0274, 0.013)
  ];
}

test("hinted headers require exact normalized repetition, safe geometry and isolated substantial body", () => {
  const box = { left: 0.4196, top: 0.0523, width: 0.1164, height: 0.0167 };
  const body = [{ left: 0.11, top: 0.105, width: 0.78, height: 0.78 }];
  assert.equal(inferHintedMargin(" Author   N\u00e1me ", box, body, { headers: ["author name"] }), "header");
  assert.equal(inferHintedMargin("Author Name", box, body), undefined);
  assert.equal(inferHintedMargin("Author Name extra", box, body, { headers: ["Author Name"] }), undefined);
  for (const invalid of [null, { ...box, top: 0.4 }, { ...box, height: 0.036 }, { ...box, top: 0.13 }]) {
    assert.equal(inferHintedMargin("Author Name", invalid, body, { headers: ["Author Name"] }), undefined);
  }
  for (const invalid of [[], [{ ...body[0]!, top: 0.075 }], [{ ...body[0]!, top: 0.2 }], [{ ...body[0]!, width: 0.24 }], [{ ...body[0]!, height: 0.05 }]]) {
    assert.equal(inferHintedMargin("Author Name", box, invalid, { headers: ["Author Name"] }), undefined);
  }
  for (const text of ["Chapter 1", "Capitulo 2", "Parte I", "Prologo", "Introduccion", "Epilogo", "x".repeat(121), Array(13).fill("word").join(" ")]) {
    assert.equal(inferHintedMargin(text, box, body, { headers: [text] }), undefined);
  }
});

test("Textract classifies hinted provider titles before grouping and keeps immutable source geometry", async () => {
  for (const type of ["LAYOUT_TEXT", "LAYOUT_TITLE", "LAYOUT_SECTION_HEADER"] as const) {
    const blocks = marginFixture();
    blocks[0]!.BlockType = type;
    const original = structuredClone(blocks);
    const page = await buildTextractPage(Buffer.alloc(0), blocks, "es", { headers: ["Author Name"] });
    assert.deepEqual(blocks, original);
    assert.deepEqual(page.paragraphs, ["Author Name", "Generic body paragraph.", "Book Label", "71"]);
    assert.deepEqual(page.paragraphMetadata!.map(({ role, readAloud }) => [role, readAloud]), [["header", false], ["body", true], ["footer", false], ["pageNumber", false]]);
    const $ = load(page.htmlContent!);
    assert.equal($("h1,h2,h3,h4,h5,h6").length, 0);
    assert.equal($("section").length, 4);
    assert.equal($(".reader-reading-row > section").length, 2);
    assert.match(page.editedText, /::center:: Author Name/u);
    assert.match(page.editedText, /::center:: Book Label/u);
    assert.match(page.editedText, /::right:: 71/u);
    const reloaded = buildRichPageFromEditableText(page.editedText, { paragraphMetadata: page.paragraphMetadata! });
    assert.deepEqual({ ...reloaded, rawText: reloaded.rawText.replace(/\s+/gu, " ") }, { ...page, rawText: page.rawText.replace(/\s+/gu, " ") });
  }
  const noHint = await buildTextractPage(Buffer.alloc(0), marginFixture());
  assert.equal(noHint.paragraphMetadata![0]!.role, "heading");
  assert.equal(load(noHint.htmlContent!)("h2").text(), "Author Name");
  const bodyName = marginFixture();
  bodyName[0] = layout("header", "LAYOUT_TEXT", "Author Name", 0.1, 0.4, 0.78, 0.02);
  assert.equal((await buildTextractPage(Buffer.alloc(0), bodyName, "es", { headers: ["Author Name"] })).paragraphMetadata![0]!.role, "body");
});

test("bottom margins pair left to right only with compatible complete geometry", () => {
  const fixture = marginFixture();
  const groups = groupTextractLayoutBlocks([fixture[0]!, fixture[1]!, fixture[3]!, fixture[2]!]);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["header", "body"], ["footer"], ["number"]]);
  assert.ok(groups[1]!.readingRowId);
  assert.equal(groups[1]!.readingRowId, groups[2]!.readingRowId);
  for (const invalid of [
    layout("number", "LAYOUT_PAGE_NUMBER", "71", 0.8483, 0.98, 0.0274, 0.013),
    layout("number", "LAYOUT_PAGE_NUMBER", "71", 0.45, 0.9358, 0.0274, 0.013),
    layout("number", "LAYOUT_PAGE_NUMBER", "71", 0.8483, 0.8, 0.0274, 0.013),
    { Id: "number", BlockType: "LAYOUT_PAGE_NUMBER", Text: "71" } as Block,
    layout("number", "LAYOUT_TEXT", "Body end.", 0.8483, 0.9358, 0.0274, 0.013)
  ]) {
    const result = groupTextractLayoutBlocks([fixture[1]!, invalid, fixture[2]!]);
    assert.ok(result.every((group) => !group.readingRowId));
  }
});

test("both mocked image pipelines propagate hints and produce independent footer blocks in one row", async (t) => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  const blocks = marginFixture();
  const original = structuredClone(blocks);
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: blocks }));
  const visionBlocks = blocks.map((block, index) => {
    const box = block.Geometry!.BoundingBox!;
    return { type: index === 0 ? "heading" : "paragraph", text: block.Text, role: ["heading", "body", "footer", "pageNumber"][index], readAloud: true,
      readingBlockId: index < 2 ? "shared" : "footer", bbox: { x: box.Left! * 1000, y: box.Top! * 1000, width: box.Width! * 1000, height: box.Height! * 1000 } };
  });
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(options.body as string);
    assert.match(request.instructions, /Author Name/u);
    assert.match(request.instructions, /dos readingBlockId distintos, mismo readingRowId/u);
    return Response.json({ output_text: JSON.stringify({ blocks: visionBlocks }) });
  });
  for (const ocrMode of ["TEXTRACT", "VISION"] as const) {
    const page = await runOcrOnImage(image, "page.png", "image/png", { ocrMode, marginHints: { headers: ["Author Name"] }, model: "gpt-5.4-mini", opencodeApiKey: "test-key",
      awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" } });
    assert.equal(page.paragraphMetadata![0]!.role, "header");
    assert.equal(page.paragraphMetadata![0]!.readAloud, false);
    assert.equal(page.paragraphMetadata!.length, page.paragraphs.length);
    const $ = load(page.htmlContent!);
    assert.equal($("h2").length, 0);
    assert.deepEqual($(".reader-reading-row > section").map((_, node) => $(node).text()).get(), ["Book Label", "71"]);
    assert.equal(hasValidReadingBlockMarkers(page.editedText), true);
    const reloaded = buildRichPageFromEditableText(page.editedText, { paragraphMetadata: page.paragraphMetadata! });
    assert.deepEqual({ ...reloaded, rawText: reloaded.rawText.replace(/\s+/gu, " ") }, { ...page, rawText: page.rawText.replace(/\s+/gu, " ") });
  }
  assert.deepEqual(blocks, original);
  const explicit = await buildStructuredVisionPage(Buffer.alloc(0), [{ type: "heading", text: "Chapter 1", role: "header", readAloud: true }], [], "", "es", { headers: ["Chapter 1"] });
  assert.equal(explicit.paragraphMetadata![0]!.readAloud, true);
  assert.equal(explicit.paragraphMetadata![0]!.role, "header");
  assert.equal(load(explicit.htmlContent!)("h1").length, 0);
});

test("Vision inferred footer rows avoid reserved IDs, preserve body rows and never split mixed groups", async () => {
  const footer = { type: "paragraph" as const, text: "Book Label", role: "footer" as const, bbox: { x: 434.9, y: 928.9, width: 85.75, height: 17.6 } };
  const number = { type: "paragraph" as const, text: "71", role: "pageNumber" as const, bbox: { x: 848.3, y: 935.8, width: 27.4, height: 13 } };
  const body = [
    { type: "paragraph" as const, text: "Left body.", readingBlockId: "vision-margin-block-3", readingRowId: "vision-margin-row-1" },
    { type: "paragraph" as const, text: "Right body.", readingBlockId: "right", readingRowId: "vision-margin-row-1" }
  ];
  const blocks = [...body, number, footer];
  const snapshot = structuredClone(blocks);
  const page = await buildStructuredVisionPage(Buffer.alloc(0), blocks, [], "");
  assert.deepEqual(blocks, snapshot);
  assert.deepEqual(page.paragraphs, ["Left body.", "Right body.", "Book Label", "71"]);
  assert.match(page.editedText, /row=vision-margin-row-2/u);
  assert.match(page.editedText, /:::block vision-margin-block-3-2/u);
  assert.equal(hasValidReadingBlockMarkers(page.editedText), true);
  const mixed = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "paragraph", text: "Body.", readingBlockId: "main" },
    { ...footer, readingBlockId: "main" }, { ...number, readingBlockId: "main" }
  ], [], "");
  assert.equal(load(mixed.htmlContent!)("section").length, 1);
  assert.doesNotMatch(mixed.editedText, /row=/u);
  const provider = await buildStructuredVisionPage(Buffer.alloc(0), [
    { ...footer, readingBlockId: "footer", readingRowId: "existing" }, { ...number, readingBlockId: "number", readingRowId: "existing" }
  ], [], "");
  assert.match(provider.editedText, /:::block footer row=existing/u);
  assert.match(provider.editedText, /:::block number row=existing/u);
  for (const invalid of [{ ...number, bbox: { ...number.bbox, y: 980 } }, { ...number, bbox: { ...number.bbox, x: 440 } }, { type: "paragraph" as const, text: "71", role: "pageNumber" as const }]) {
    const result = await buildStructuredVisionPage(Buffer.alloc(0), [footer, invalid], [], "");
    assert.doesNotMatch(result.editedText, /row=/u);
  }
  const hinted = await buildStructuredVisionPage(Buffer.alloc(0), [{ ...footer, role: "body", readAloud: true }], [], "", "es", { footers: ["Book Label"] });
  assert.equal(hinted.paragraphMetadata![0]!.role, "footer");
  assert.equal(hinted.paragraphMetadata![0]!.readAloud, false);
});

test("Textract hints resolve CHILD text without duplication and keep chapter keywords as headings", async () => {
  const blocks = marginFixture();
  delete blocks[0]!.Text;
  blocks[0]!.Relationships = [{ Type: "CHILD", Ids: ["line", "line"] }];
  blocks.push({ Id: "line", BlockType: "LINE", Text: "Author Name", Relationships: [{ Type: "CHILD", Ids: ["word"] }] }, { Id: "word", BlockType: "WORD", Text: "Author" });
  const page = await buildTextractPage(Buffer.alloc(0), blocks, "es", { headers: ["Author Name"] });
  assert.equal(page.paragraphMetadata![0]!.role, "header");
  assert.equal(page.paragraphs.filter((text) => text === "Author Name").length, 1);
  for (const text of ["Chapter 1", "Parte I", "Prologo"]) {
    const fixture = marginFixture();
    fixture[0]!.Text = text;
    const title = await buildTextractPage(Buffer.alloc(0), fixture, "es", { headers: [text] });
    assert.equal(title.paragraphMetadata![0]!.role, "heading");
    const vision = await buildStructuredVisionPage(Buffer.alloc(0), [
      { type: "heading", text, bbox: { x: 419.6, y: 52.3, width: 116.4, height: 16.7 } },
      { type: "paragraph", text: "Generic body.", bbox: { x: 110, y: 105, width: 780, height: 780 } }
    ], [], "", "es", { headers: [text] });
    assert.equal(vision.paragraphMetadata![0]!.role, "heading");
  }
});

function layout(id: string, type: Block["BlockType"], text: string, left: number, top: number, width = 0.35, height = 0.1): Block {
  return { Id: id, BlockType: type!, Text: text, Geometry: { BoundingBox: { Left: left, Top: top, Width: width, Height: height } } };
}

for (const captionHeight of [0.02, 0.03, 0.04]) {
  test(`Textract separates short figure rows with caption height ${captionHeight} in geometric reading order`, async () => {
    const blocks = [
      layout("a", "LAYOUT_FIGURE", "", 0.1, 0.1, 0.3, 0.12),
      layout("b", "LAYOUT_FIGURE", "", 0.6, 0.1, 0.3, 0.12),
      layout("a-caption", "LAYOUT_TEXT", "Figura 1. Left upper.", 0.1, 0.23, 0.3, captionHeight),
      layout("b-caption", "LAYOUT_TEXT", "Figura 2. Right upper.", 0.6, 0.23, 0.3, captionHeight),
      layout("c", "LAYOUT_FIGURE", "", 0.1, 0.35, 0.3, 0.12),
      layout("d", "LAYOUT_FIGURE", "", 0.6, 0.35, 0.3, 0.12),
      layout("c-caption", "LAYOUT_TEXT", "Figura 3. Left lower.", 0.1, 0.48, 0.3, captionHeight),
      layout("d-caption", "LAYOUT_TEXT", "Figura 4. Right lower.", 0.6, 0.48, 0.3, captionHeight)
    ];
    const snapshot = structuredClone(blocks);
    const groups = groupTextractLayoutBlocks([...blocks].reverse());
    assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [
      ["a", "a-caption"], ["b", "b-caption"], ["c", "c-caption"], ["d", "d-caption"]
    ]);
    assert.deepEqual(groups.map((group) => group.readingRowId), ["textract-row-1", "textract-row-1", "textract-row-2", "textract-row-2"]);
    const image = await sharp({ create: { width: 500, height: 500, channels: 3, background: "white" } }).png().toBuffer();
    const page = await buildTextractPage(image, [...blocks].reverse());
    const $ = load(page.htmlContent!);
    assert.deepEqual($("section").map((_, section) => $(section).text()).get(), blocks.filter((block) => block.BlockType === "LAYOUT_TEXT").map((block) => block.Text));
    assert.equal($("figure").length, 4);
    assert.equal(page.paragraphMetadata!.filter((item) => item.role === "imageCaption").length, 4);
    assert.deepEqual(buildRichPageFromEditableText(page.editedText, { paragraphMetadata: page.paragraphMetadata! }), page);
    assert.deepEqual(blocks, snapshot);
  });
}

test("Textract embeds internal lines once and preserves exterior, partial and unknown figure text", async () => {
  const image = await sharp({ create: { width: 500, height: 500, channels: 3, background: "white" } }).png().toBuffer();
  const figure = layout("figure", "LAYOUT_FIGURE", "Parent must not resurrect internal text.", 0.1, 0.1, 0.3, 0.3);
  figure.Relationships = [{ Type: "CHILD", Ids: ["inside", "outside", "partial", "unknown"] }];
  const duplicate = layout("duplicate", "LAYOUT_TEXT", "Internal label.", 0.15, 0.15, 0.1, 0.02);
  duplicate.Relationships = [{ Type: "CHILD", Ids: ["inside"] }];
  const blocks = [figure, duplicate,
    layout("inside", "LINE", "Internal label.", 0.15, 0.15, 0.1, 0.02),
    layout("outside", "LINE", "Caption outside.", 0.1, 0.42, 0.3, 0.02),
    layout("partial", "LINE", "Crossing boundary.", 0.35, 0.2, 0.1, 0.02),
    { Id: "unknown", BlockType: "LINE", Text: "Unknown geometry." } as Block
  ];
  const page = await buildTextractPage(image, blocks);
  assert.deepEqual(page.paragraphs, ["Imagen.", "Caption outside. Crossing boundary. Unknown geometry."]);
  assert.doesNotMatch(page.rawText, /Internal label|Parent must/u);
  assert.equal(page.paragraphMetadata!.length, page.paragraphs.length);
  const internalOnly = await buildTextractPage(image, [
    { ...figure, Relationships: [{ Type: "CHILD", Ids: ["inside"] }] }, blocks[2]!
  ]);
  assert.deepEqual(internalOnly.paragraphs, ["Imagen."]);
  // A crop too small to embed cannot justify suppressing any text.
  const tiny = await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer();
  const uncropped = await buildTextractPage(tiny, [figure, blocks[2]!]);
  assert.deepEqual(uncropped.paragraphs, ["Internal label."]);
  assert.equal(load(uncropped.htmlContent!)("img").length, 0);
});

test("Textract retains parent fallback text for empty or missing CHILD responses", async () => {
  const parent = layout("parent", "LAYOUT_TEXT", "Recoverable text.", 0.1, 0.1);
  parent.Relationships = [{ Type: "CHILD", Ids: ["empty", "missing"] }];
  const page = await buildTextractPage(Buffer.alloc(0), [parent, { Id: "empty", BlockType: "LINE" }]);
  assert.deepEqual(page.paragraphs, ["Recoverable text."]);
});

test("Textract retains table CHILD content once without duplicating nested layouts or words", async () => {
  const table = layout("table", "LAYOUT_TABLE", "", 0.1, 0.2, 0.8, 0.3);
  table.Relationships = [{ Type: "CHILD", Ids: ["row", "row"] }];
  const row = layout("row", "LAYOUT_TEXT", "", 0.1, 0.2, 0.8, 0.1);
  row.Relationships = [{ Type: "CHILD", Ids: ["line"] }];
  const page = await buildTextractPage(Buffer.alloc(0), [
    layout("title", "LAYOUT_TITLE", "Table title", 0.1, 0.1, 0.3, 0.03), table, row,
    { Id: "line", BlockType: "LINE", Text: "Name Value", Relationships: [{ Type: "CHILD", Ids: ["word"] }] },
    { Id: "word", BlockType: "WORD", Text: "Name" },
    layout("end", "LAYOUT_TEXT", "After table.", 0.1, 0.6, 0.8, 0.1)
  ]);
  assert.deepEqual(page.paragraphs, ["Table title", "Name Value", "After table."]);
  assert.doesNotMatch(page.editedText, /::center::/u);
  assert.match(page.editedText, /## Table title/u);
  assert.equal(load(page.htmlContent!)("h2").attr("data-text-align"), undefined);
  assert.equal(page.paragraphMetadata!.length, 3);
});

test("Textract sends JPEG to mocked AWS but crops exact original pixels after rotation", async (t) => {
  const pixels = Buffer.from(Array.from({ length: 80 * 100 * 3 }, (_, index) => (index * 73 + Math.floor(index / 9)) % 256));
  const image = await sharp(pixels, { raw: { width: 80, height: 100, channels: 3 } }).png().toBuffer();
  const figure = layout("figure", "LAYOUT_FIGURE", "", 0.1, 0.2, 0.5, 0.5);
  t.mock.method(TextractClient.prototype, "send", async (command: { input: { Document: { Bytes: Uint8Array }; FeatureTypes: string[] } }) => {
    const metadata = await sharp(command.input.Document.Bytes).metadata();
    assert.equal(metadata.format, "jpeg");
    assert.equal(metadata.width, 100);
    assert.equal(metadata.height, 80);
    assert.deepEqual(command.input.FeatureTypes, ["LAYOUT"]);
    return { Blocks: [figure] };
  });
  const page = await runOcrOnImage(image, "page.png", "image/png", { rotation: 90, ocrMode: "TEXTRACT",
    awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" } });
  const source = load(page.htmlContent!)("img").attr("src")!;
  const actual = await sharp(Buffer.from(source.split(",")[1]!, "base64")).raw().toBuffer();
  const rotated = await sharp(image).rotate(90).png().toBuffer();
  const expected = await sharp(rotated).extract({ left: 10, top: 16, width: 50, height: 40 }).raw().toBuffer();
  assert.deepEqual(actual, expected);
});

test("Textract captured sanitized geometry forms exactly two rows of two whole sections", async () => {
  const blocks = historyPage4Geometry();
  const expected = [[766], [765, 764, 772, 773, 774, 775, 776, 777, 778], [781, 782, 783, 785, 786, 788], [784, 787, 789, 790]];
  const groups = groupTextractLayoutBlocks(blocks);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => Number(block.Id!.split("-")[1]))), expected);
  assert.deepEqual(groups.map((group) => group.readingRowId), ["textract-row-1", "textract-row-1", "textract-row-2", "textract-row-2"]);
  // Moving the section boundary and reversing AWS order must not change the quadrants.
  const moved = blocks.map((block): Block => {
    const box = block.Geometry?.BoundingBox;
    return box ? { ...block, Geometry: { BoundingBox: { ...box, Top: box.Top! * 0.85 + 0.02, Height: box.Height! * 0.85 } } } : block;
  }).reverse();
  assert.deepEqual(groupTextractLayoutBlocks(moved).map((group) => group.blocks.map((block) => Number(block.Id!.split("-")[1]))), expected);
  // Even a full-width outer header is retained inside a quadrant, not as a fifth block.
  const wideHeader = blocks.map((block): Block => block.Id === "geometry-764"
    ? { ...block, Geometry: { BoundingBox: { Left: 0.05, Top: 0.01, Width: 0.9, Height: 0.02 } } } : block);
  const withWideHeader = groupTextractLayoutBlocks(wideHeader);
  assert.equal(withWideHeader.length, 4);
  assert.ok(withWideHeader[0]!.blocks.some((block) => block.Id === "geometry-764"));
  const image = await sharp({ create: { width: 1000, height: 1400, channels: 3, background: "white" } }).png().toBuffer();
  const page = await buildTextractPage(image, blocks);
  const $ = load(page.htmlContent!);
  assert.equal($("section.reader-reading-block").length, 4);
  assert.deepEqual($(".reader-reading-row").map((_, row) => $(row).children("section").length).get(), [2, 2]);
  const sections = $("section.reader-reading-block");
  assert.equal(sections.eq(0).find("figure").length, 0);
  assert.equal(sections.eq(1).find("figure").length, 1);
  assert.equal(sections.eq(2).find("figure").length, 1);
  const bottomFigures = sections.eq(3).find("img").toArray();
  assert.equal(bottomFigures.length, 2);
  const photo = await sharp(Buffer.from($(bottomFigures[1]!).attr("src")!.split(",")[1]!, "base64")).metadata();
  assert.equal(photo.width, 299);
  assert.equal(photo.height, 426);
  for (const line of [56, 57, 58, 72, 74, 75, 76, 77]) assert.ok(sections.eq(2).text().includes(`Placeholder line ${line}.`));
  for (const line of [73, 78, 79, 80]) assert.ok(sections.eq(3).text().includes(`Placeholder line ${line}.`));
  for (const line of [1, 2, 8, 11, 40, 45, 47, 54]) assert.ok(sections.eq(1).text().includes(`Placeholder line ${line}.`));
  for (let line = 1; line <= 80; line += 1) assert.equal(page.rawText.split(`Placeholder line ${line}.`).length - 1, 1);
  assert.equal(hasValidReadingBlockMarkers(page.editedText), true);
   assert.deepEqual(buildRichPageFromEditableText(page.editedText, { paragraphMetadata: page.paragraphMetadata! }), page);
   assert.equal(page.paragraphMetadata!.length, page.paragraphs.length);
   const descriptor = (text: string) => page.paragraphMetadata![page.paragraphs.indexOf(text)];
   assert.equal(descriptor("Placeholder line 1.")!.role, "header");
   for (const line of [2, 80]) {
     assert.equal(descriptor(`Placeholder line ${line}.`)!.role, "pageNumber");
     assert.equal(descriptor(`Placeholder line ${line}.`)!.readAloud, false);
   }
   assert.equal(descriptor("Placeholder line 73.")!.role, "imageCaption");
   assert.equal(descriptor("Placeholder line 73.")!.geometry, null);
   assert.equal(descriptor("Placeholder line 78. Placeholder line 79.")!.role, "imageCaption");
   assert.deepEqual(page.paragraphMetadata![0]!.geometry!.bbox, {
     left: blocks.find((block) => block.Id === "geometry-766")!.Geometry!.BoundingBox!.Left,
     top: blocks.find((block) => block.Id === "geometry-766")!.Geometry!.BoundingBox!.Top,
     width: blocks.find((block) => block.Id === "geometry-766")!.Geometry!.BoundingBox!.Width,
     height: blocks.find((block) => block.Id === "geometry-766")!.Geometry!.BoundingBox!.Height
   });
});

test("Textract pure grouping joins each column and pairs same-top columns into a row", () => {
  const blocks = [
    layout("left", "LAYOUT_TEXT", "Left.", 0.1, 0.1),
    layout("left-2", "LAYOUT_TEXT", "Left again.", 0.1, 0.3),
    layout("figure", "LAYOUT_FIGURE", "", 0.2, 0.45, 0.1),
    layout("right", "LAYOUT_TEXT", "Right.", 0.55, 0.1),
    layout("right-2", "LAYOUT_TEXT", "Right again.", 0.55, 0.3)
  ];
  const groups = groupTextractLayoutBlocks(blocks);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["left", "left-2", "figure"], ["right", "right-2"]]);
  assert.equal(groups[0]!.readingRowId, groups[1]!.readingRowId);
  assert.ok(groups[0]!.readingRowId);
  assert.deepEqual(groupTextractLayoutBlocks([blocks[0]!, blocks[3]!]).map((group) => group.readingRowId), ["textract-row-1", "textract-row-1"]);
  assert.deepEqual(groupTextractLayoutBlocks(blocks), groups);
});

test("Textract single column is one body block with separate headers and numeric footers", async () => {
  const blocks = [layout("header", "LAYOUT_HEADER", "Header", 0.1, 0.01), layout("title", "LAYOUT_TITLE", "Title", 0.1, 0.15), layout("text", "LAYOUT_TEXT", "Paragraph.", 0.1, 0.4), layout("end", "LAYOUT_TEXT", "End.", 0.1, 0.8), layout("footer", "LAYOUT_PAGE_NUMBER", "24", 0.5, 0.95, 0.05, 0.02)];
  const groups = groupTextractLayoutBlocks(blocks);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["header"], ["title", "text", "end"], ["footer"]]);
  assert.ok(groups.every((group) => !group.readingRowId));
  const page = await buildTextractPage(Buffer.alloc(0), blocks);
  assert.deepEqual(page.paragraphs, ["Header", "Title", "Paragraph.", "End.", "24"]);
  assert.deepEqual(page.paragraphMetadata!.map(({ role, readAloud }) => ({ role, readAloud })), [
    { role: "header", readAloud: false }, { role: "heading", readAloud: true },
    { role: "body", readAloud: true }, { role: "body", readAloud: true }, { role: "pageNumber", readAloud: false }
  ]);
  assert.equal(load(page.htmlContent!)("section").length, 3);
});

test("Textract keeps a sidebar separate beside continuous text", () => {
  const groups = groupTextractLayoutBlocks([layout("text", "LAYOUT_TEXT", "Main.", 0.05, 0.1, 0.55, 0.5), layout("box-title", "LAYOUT_TITLE", "Box", 0.7, 0.15, 0.25, 0.05), layout("box-text", "LAYOUT_TEXT", "Aside.", 0.7, 0.25, 0.25, 0.2)]);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["text"], ["box-title", "box-text"]]);
  assert.equal(groups[0]!.readingRowId, groups[1]!.readingRowId);
});

test("Textract does not merge a full-width title into either column", () => {
  const groups = groupTextractLayoutBlocks([
    layout("title", "LAYOUT_TITLE", "Title", 0.05, 0.02, 0.9, 0.05),
    layout("main", "LAYOUT_TEXT", "Main.", 0.05, 0.1, 0.55, 0.5),
    layout("sidebar", "LAYOUT_TEXT", "Aside.", 0.7, 0.1, 0.25, 0.5)
  ]);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["title"], ["main"], ["sidebar"]]);
  assert.equal(groups[0]!.readingRowId, undefined);
  assert.ok(groups[1]!.readingRowId);
  assert.equal(groups[1]!.readingRowId, groups[2]!.readingRowId);
});

test("Textract spanning headings and headers are barriers between successive column rows", async () => {
  for (const type of ["LAYOUT_TITLE", "LAYOUT_SECTION_HEADER", "LAYOUT_HEADER"] as const) {
    const blocks = [
      layout("upper-left", "LAYOUT_TEXT", "Upper left.", 0.1, 0.1, 0.35, 0.1),
      layout("upper-right", "LAYOUT_TEXT", "Upper right.", 0.55, 0.1, 0.35, 0.1),
      layout("barrier", type, "Middle heading", 0.1, 0.24, 0.8, 0.05),
      layout("lower-left", "LAYOUT_TEXT", "Lower left.", 0.1, 0.32, 0.35, 0.1),
      layout("lower-right", "LAYOUT_TEXT", "Lower right.", 0.55, 0.32, 0.35, 0.1)
    ];
    const groups = groupTextractLayoutBlocks(blocks);
    assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), blocks.map((block) => [block.Id]), type);
    const columnOrdered = [blocks[0]!, blocks[3]!, blocks[1]!, blocks[4]!, blocks[2]!];
    assert.deepEqual(groupTextractLayoutBlocks(columnOrdered).map((group) => group.blocks.map((block) => block.Id)), blocks.map((block) => [block.Id]), `${type}: geometry barriers also apply outside source order`);
    assert.ok(groups[0]!.readingRowId);
    assert.equal(groups[0]!.readingRowId, groups[1]!.readingRowId);
    assert.equal(groups[2]!.readingRowId, undefined);
    assert.ok(groups[3]!.readingRowId);
    assert.equal(groups[3]!.readingRowId, groups[4]!.readingRowId);
    assert.notEqual(groups[0]!.readingRowId, groups[3]!.readingRowId);
    const page = await buildTextractPage(Buffer.alloc(0), blocks);
    assert.deepEqual(page.paragraphs, ["Upper left.", "Upper right.", "Middle heading", "Lower left.", "Lower right."]);
    const $ = load(page.htmlContent!);
    assert.deepEqual($(".reader-reading-row").map((_, row) => $(row).children("section").length).get(), [2, 2]);
    assert.equal(hasValidReadingBlockMarkers(page.editedText), true);
  }
});

test("Textract joins distant fragments of one column beside a tall column instead of inventing three columns", async () => {
  const blocks = [
    layout("left-upper", "LAYOUT_TEXT", "Left upper.", 0.1, 0.1, 0.35, 0.1),
    layout("left-lower", "LAYOUT_TEXT", "Left lower.", 0.1, 0.65, 0.35, 0.1),
    layout("right-tall", "LAYOUT_TEXT", "Right tall.", 0.55, 0.1, 0.35, 0.7)
  ];
  const groups = groupTextractLayoutBlocks(blocks);
  assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), [["left-upper", "left-lower"], ["right-tall"]]);
  assert.ok(groups[0]!.readingRowId);
  assert.equal(groups[0]!.readingRowId, groups[1]!.readingRowId);
  const page = await buildTextractPage(Buffer.alloc(0), blocks);
  assert.deepEqual(page.paragraphs, ["Left upper.", "Left lower.", "Right tall."]);
  const $ = load(page.htmlContent!);
  assert.equal($(".reader-reading-row > section").length, 2);
});

test("Textract tall columns cannot bridge a transversal heading or header", () => {
  for (const type of ["LAYOUT_TITLE", "LAYOUT_HEADER"] as const) {
    const blocks = [
      layout("left-upper", "LAYOUT_TEXT", "Upper.", 0.1, 0.1, 0.35, 0.1),
      layout("right-tall", "LAYOUT_TEXT", "Tall.", 0.55, 0.1, 0.35, 0.7),
      layout("barrier", type, "Middle", 0.1, 0.4, 0.8, 0.05),
      layout("left-lower", "LAYOUT_TEXT", "Lower.", 0.1, 0.65, 0.35, 0.1)
    ];
    const groups = groupTextractLayoutBlocks(blocks);
    assert.deepEqual(groups.map((group) => group.blocks.map((block) => block.Id)), blocks.map((block) => [block.Id]));
    assert.equal(groups[0]!.readingRowId, groups[1]!.readingRowId);
    assert.equal(groups[2]!.readingRowId, undefined);
    assert.equal(groups[3]!.readingRowId, undefined);
  }
});

test("Textract orders partial header and footer boxes using finite Top, not zero", async () => {
  const header: Block = { Id: "header", BlockType: "LAYOUT_HEADER", Text: "Header", Geometry: { BoundingBox: { Top: 0.01 } } };
  const footer: Block = { Id: "footer", BlockType: "LAYOUT_PAGE_NUMBER", Text: "25", Geometry: { BoundingBox: { Top: 0.95 } } };
  const blocks = [header, layout("left", "LAYOUT_TEXT", "Left.", 0.1, 0.1), layout("right", "LAYOUT_TEXT", "Right.", 0.55, 0.1), footer];
  assert.deepEqual(groupTextractLayoutBlocks(blocks).map((group) => group.blocks.map((block) => block.Id)), [["header"], ["left"], ["right"], ["footer"]]);
  assert.deepEqual((await buildTextractPage(Buffer.alloc(0), blocks)).paragraphs, ["Header", "Left.", "Right.", "25"]);
});

test("Textract unknown or nonfinite margin positions retain AWS order and separate adjacent runs", () => {
  for (const top of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
    const unknown: Block = { Id: "unknown", BlockType: "LAYOUT_HEADER", Text: "Unknown", ...(top === undefined ? {} : { Geometry: { BoundingBox: { Top: top } } }) };
    const blocks = [layout("right", "LAYOUT_TEXT", "Right.", 0.55, 0.2), unknown, layout("left", "LAYOUT_TEXT", "Left.", 0.1, 0.1)];
    assert.deepEqual(groupTextractLayoutBlocks(blocks).map((group) => group.blocks.map((block) => block.Id)), [["right"], ["unknown"], ["left"]]);
    const footer: Block = { ...unknown, Id: "footer", BlockType: "LAYOUT_FOOTER" };
    assert.deepEqual(groupTextractLayoutBlocks([blocks[0]!, blocks[2]!, footer]).map((group) => group.blocks.map((block) => block.Id)), [["left"], ["right"], ["footer"]]);
  }
});

test("Textract traverses nested CHILD lists and figures once, ignoring WORD duplication", async () => {
  const list = layout("list", "LAYOUT_LIST", "", 0.1, 0.1);
  list.Relationships = [{ Type: "CHILD", Ids: ["nested", "line-2", "nested"] }];
  const nested = layout("nested", "LAYOUT_TEXT", "", 0.1, 0.1);
  nested.Relationships = [{ Type: "CHILD", Ids: ["line-1"] }];
  const figure = layout("figure", "LAYOUT_FIGURE", "", 0.1, 0.3, 0.35, 0.3);
  figure.Relationships = [{ Type: "CHILD", Ids: ["caption"] }];
  const image = await sharp({ create: { width: 200, height: 200, channels: 3, background: "white" } }).png().toBuffer();
  const page = await buildTextractPage(image, [list, nested,
    { Id: "line-1", BlockType: "LINE", Text: "First item.", Relationships: [{ Type: "CHILD", Ids: ["word"] }] },
    { Id: "word", BlockType: "WORD", Text: "First" },
    { Id: "line-2", BlockType: "LINE", Text: "Second item." }, figure,
    { Id: "caption", BlockType: "LINE", Text: "Figure label." },
    layout("right", "LAYOUT_TEXT", "Right.", 0.55, 0.1, 0.35, 0.5)
  ], "it");
  assert.deepEqual(page.paragraphs, ["First item. Second item.", "Immagine.", "Figure label.", "Right."]);
  assert.doesNotMatch(page.rawText, /!\[|embedded-image|:::block/u);
  const $ = load(page.htmlContent!);
  assert.equal($("section").eq(0).find("figure").length, 1);
  assert.equal($("figure").attr("data-reader-text"), "Immagine.");
  assert.equal($(".reader-reading-row > section").length, 2);
  const reloaded = buildRichPageFromEditableText(page.editedText, { languageCode: "it", paragraphMetadata: page.paragraphMetadata! });
  assert.deepEqual(reloaded, page);
});

test("Vision normalizes recurring rows without changing order or reserving duplicate block IDs", async () => {
  const row = "r".repeat(80);
  const page = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "paragraph", text: "Left.", readingBlockId: "left", readingRowId: row },
    { type: "paragraph", text: "Right.", readingBlockId: "right", readingRowId: row },
    { type: "paragraph", text: "Outside.", readingBlockId: "right" },
    { type: "paragraph", text: "Another.", readingBlockId: "left", readingRowId: row },
    { type: "paragraph", text: "Reserved.", readingBlockId: "reserved", readingRowId: `${row.slice(0, 78)}-2` },
    { type: "paragraph", text: "Row only.", readingRowId: "last" }
  ], [], "");
  assert.equal(hasValidReadingBlockMarkers(page.editedText), true);
  assert.deepEqual(page.paragraphs, ["Left.", "Right.", "Outside.", "Another.", "Reserved.", "Row only."]);
  assert.match(page.editedText, new RegExp(`:::block left-2 row=${row.slice(0, 78)}-3`, "u"));
  assert.equal(load(page.htmlContent!)(".reader-reading-row").length, 4);
});

test("Vision pide bloques semanticos consecutivos y conserva margenes en ambos idiomas", () => {
  for (const language of ["es", "it"] as const) {
    const prompt = buildVisionOcrPrompt(language, "Instruccion personalizada");
    assert.match(prompt.system, /readingBlockId/u);
    assert.match(prompt.system, /readingRowId/u);
    assert.match(prompt.system, /imageCaption/u);
    assert.match(prompt.system, /readAloud/u);
    assert.match(prompt.system, /pageNumber/u);
    assert.match(prompt.system, /titulos de capitulo|titoli di capitolo/u);
    assert.ok(prompt.system.includes("^[a-zA-Z0-9_-]{1,80}$"));
    assert.match(prompt.system, /mismo id|stesso id/u);
    assert.match(prompt.system, /texto corrido|testo continuo/u);
    assert.match(prompt.system, /columnas, recuadros|colonne, riquadri/u);
    assert.match(prompt.system, /vocabulario|vocabolario/u);
    assert.match(prompt.system, /consecutivos|consecutivi/u);
    assert.match(prompt.system, /orden de lectura|ordine di lettura/u);
    assert.match(prompt.system, /No confundas los tamaños|Non confondere le dimensioni/u);
    assert.match(prompt.system, /cabeceras y pies|intestazioni e piè/u);
    assert.doesNotMatch(prompt.system, /página recortada|pagina ritagliata/u);
    assert.equal(prompt.user, "Instruccion personalizada");
  }
});

test("Vision agrupa titulos, parrafos e imagenes sin perder formato ni orden", async () => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  const result = await buildStructuredVisionPage(image, [
    { type: "heading", text: "Titulo", level: 2, alignment: "center", readingBlockId: "main" },
    { type: "paragraph", text: "Texto **importante**.", alignment: "right", readingBlockId: "main" },
    { type: "image", altText: "Ilustracion", bbox: { x: 0, y: 0, width: 500, height: 500 }, readingBlockId: "main" },
    { type: "paragraph", text: "Continuacion.", readingBlockId: "main" },
    { type: "heading", text: "Vocabulario", level: 3, readingBlockId: "vocab_2" },
    { type: "paragraph", text: "Palabra: significado.", readingBlockId: "vocab_2" }
  ], [], "");
  assert.deepEqual(result.editedText.match(/^:::block .+$/gm), [":::block main", ":::block vocab_2"]);
  assert.match(result.editedText, /::center:: ## Titulo/u);
  assert.match(result.editedText, /::right:: Texto \*\*importante\*\*\./u);
  assert.match(result.editedText, /!\[Ilustracion\]\(data:image\/png;base64,/u);
  const $ = load(result.htmlContent!);
  const sections = $("section.reader-reading-block");
  assert.deepEqual(sections.map((_, node) => $(node).attr("data-reading-block-id")).get(), ["main", "vocab_2"]);
  assert.equal(sections.eq(0).find("h2").attr("data-text-align"), "center");
  assert.equal(sections.eq(0).find("p").first().attr("data-text-align"), "right");
  assert.equal(sections.eq(0).find("strong").text(), "importante");
  assert.match(sections.eq(0).find("img").attr("src")!, /^data:image\/png;base64,/u);
  assert.equal(sections.eq(1).find("h3").text(), "Vocabulario");
  assert.deepEqual(result.paragraphs, ["Titulo", "Texto importante.", "Imagen. Ilustracion", "Continuacion.", "Vocabulario", "Palabra: significado."]);
  assert.doesNotMatch(result.rawText, /:::block/u);
});

test("Vision conserva fallback sin IDs y sin elementos estructurados", async () => {
  const legacy = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "heading", text: "Titulo", level: 2 },
    { type: "paragraph", text: "Texto." }
  ], [], "");
  assert.equal(legacy.editedText, "## Titulo\nTexto.");
  assert.doesNotMatch(legacy.editedText, /:::block/u);
  const fallback = await buildStructuredVisionPage(Buffer.alloc(0), [], ["Primer parrafo.", "Segundo parrafo."], "Texto alternativo.");
  assert.deepEqual(fallback.paragraphs, ["Primer parrafo.", "Segundo parrafo."]);
  assert.doesNotMatch(fallback.editedText, /:::block/u);
});

test("Vision without provider block IDs isolates a hinted header from the body and pairs the footer", async () => {
  const result = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "heading", text: "Author Name", bbox: { x: 420, y: 52, width: 116, height: 17 } },
    { type: "paragraph", text: "Body paragraph one.", bbox: { x: 100, y: 112, width: 790, height: 200 } },
    { type: "paragraph", text: "Body paragraph two.", bbox: { x: 100, y: 320, width: 790, height: 200 } },
    { type: "paragraph", text: "Book title", role: "footer", bbox: { x: 435, y: 929, width: 86, height: 18 } },
    { type: "paragraph", text: "71", role: "pageNumber", bbox: { x: 848, y: 936, width: 27, height: 13 } }
  ], [], "", "es", { headers: ["Author Name"] });
  const $ = load(result.htmlContent!);
  const sections = $("section.reader-reading-block");
  assert.equal(sections.eq(0).text(), "Author Name");
  assert.equal(sections.eq(1).find("p").length, 2);
  assert.equal(sections.eq(1).text(), "Body paragraph one.Body paragraph two.");
  assert.equal(result.paragraphMetadata![0]!.role, "header");
  assert.equal(result.paragraphMetadata![0]!.readAloud, false);
  assert.equal($("h1,h2,h3").length, 0);
  assert.equal($(".reader-reading-row").length, 1);
  assert.deepEqual($(".reader-reading-row").children("section").map((_, node) => $(node).text()).get(), ["Book title", "71"]);
});

test("Vision mantiene el orden con IDs repetidos no consecutivos y parciales", async () => {
  const id = "a".repeat(80);
  const result = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "paragraph", text: "Sin ID inicial." },
    { type: "paragraph", text: "Primero.", readingBlockId: id },
    { type: "paragraph", text: "Sin ID intermedio." },
    { type: "paragraph", text: "Segundo.", readingBlockId: "otro" },
    { type: "paragraph", text: "Tercero.", readingBlockId: id },
    { type: "paragraph", text: "Cuarto.", readingBlockId: `${id.slice(0, 78)}-2` }
  ], [], "");
  assert.deepEqual(result.editedText.match(/^:::block .+$/gm), [
    `:::block ${id}`, ":::block otro", `:::block ${id.slice(0, 78)}-3`, `:::block ${id.slice(0, 78)}-2`
  ]);
  assert.deepEqual(result.paragraphs, ["Sin ID inicial.", "Primero.", "Sin ID intermedio.", "Segundo.", "Tercero.", "Cuarto."]);
});

test("Vision valida readingBlockId por tipo y envia la pagina completa tambien al optimizar", async (t) => {
  const previousKey = appEnv.opencodeGoApiKey;
  appEnv.opencodeGoApiKey = "test-key";
  t.after(() => { appEnv.opencodeGoApiKey = previousKey; });
  const image = await sharp({ create: { width: 200, height: 1000, channels: 3, background: "white" } }).png().toBuffer();
  let blocks: unknown[] = [];
  let rejectFirstRequest = false;
  const mock = t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    const imageUrl = body.input[0].content[1].image_url as string;
    const sentImage = Buffer.from(imageUrl.split(",")[1]!, "base64");
    const metadata = await sharp(sentImage).metadata();
    assert.equal(metadata.height, 1000);
    assert.equal(metadata.width, 200);
    if (rejectFirstRequest) {
      rejectFirstRequest = false;
      assert.deepEqual(sentImage, image);
      return new Response("image_too_large", { status: 400 });
    }
    return Response.json({ output_text: JSON.stringify({ blocks, paragraphs: ["Fallback."] }) });
  });
  for (const block of [
    { type: "heading", text: "Titulo" },
    { type: "paragraph", text: "Texto." },
    { type: "image", bbox: { x: 0, y: 0, width: 500, height: 100 }, altText: "Cabecera" }
  ]) {
    for (const field of ["readingBlockId", "readingRowId"]) {
      for (const id of ["valid-ID_1", "a".repeat(80)]) {
        blocks = [{ ...block, [field]: id }];
        const result = await runOcrOnImage(image, "page.png", "image/png", { ocrMode: "VISION", model: "gpt-5.4-mini" });
        assert.ok(result.editedText.startsWith(field === "readingBlockId" ? `:::block ${id}\n` : `:::block vision-1 row=${id}\n`));
      }
      for (const id of ["", "a".repeat(81), "con espacios", "a\nb", "<script>", "acentó", 42, null]) {
        blocks = [{ ...block, [field]: id }];
        await assert.rejects(runOcrOnImage(image, "page.png", "image/png", { ocrMode: "VISION", model: "gpt-5.4-mini" }), { code: "OCR_INVALID_RESPONSE" });
      }
    }
  }
  blocks = [{ type: "paragraph", text: "Legacy." }];
  rejectFirstRequest = true;
  const before = mock.mock.callCount();
  const result = await runOcrOnImage(image, "page.png", "image/png", { ocrMode: "VISION", model: "gpt-5.4-mini" });
  assert.equal(mock.mock.callCount() - before, 2);
  assert.equal(result.editedText, "Legacy.");
});

test("Textract respeta el orden Layout por columnas en lugar de ordenar por altura", async (t) => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [
    { Id: "left-top", BlockType: "LAYOUT_TEXT", Text: "Izquierda arriba.", Geometry: { BoundingBox: { Top: 0.1, Left: 0.1 } } },
    { Id: "left-bottom", BlockType: "LAYOUT_TEXT", Text: "Izquierda abajo.", Geometry: { BoundingBox: { Top: 0.8, Left: 0.1 } } },
    { Id: "right-top", BlockType: "LAYOUT_TEXT", Text: "Derecha arriba.", Geometry: { BoundingBox: { Top: 0.1, Left: 0.6 } } }
  ] }));
  const result = await runOcrOnImage(image, "page.png", "image/png", {
    ocrMode: "TEXTRACT", awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" }
  });
  assert.deepEqual(result.paragraphs, ["Izquierda arriba.", "Izquierda abajo.", "Derecha arriba."]);
  assert.doesNotMatch(result.editedText, /row=/u);
  assert.equal(load(result.htmlContent!)("section").length, 1);
});

test("Textract forwards the book language to image narration with mocked AWS", async (t) => {
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  t.mock.method(TextractClient.prototype, "send", async () => ({ Blocks: [layout("figure", "LAYOUT_FIGURE", "", 0.1, 0.1, 0.5, 0.5)] }));
  const page = await runOcrOnImage(image, "page.png", "image/png", { ocrMode: "TEXTRACT", language: "it", awsCredentials: { accessKeyId: "test", secretAccessKey: "test", region: "eu-west-1" } });
  assert.deepEqual(page.paragraphs, ["Immagine."]);
  assert.match(page.editedText, /^:::block textract-1\n!\[\]\(data:image\/png;base64,/u);
});

test("Textract handles line-only legacy responses without rearranging or filtering footer numbers", async () => {
  const page = await buildTextractPage(Buffer.alloc(0), [
    { Id: "line-1", BlockType: "LINE", Text: "First", Geometry: { BoundingBox: { Top: 0.8 } } },
    { Id: "line-2", BlockType: "LINE", Text: "then second", Geometry: { BoundingBox: { Top: 0.1 } } },
    { Id: "line-3", BlockType: "LINE", Text: "12" }
  ]);
  assert.deepEqual(page.paragraphs, ["First then second 12"]);
  assert.deepEqual(page.paragraphMetadata, [{ role: "body", readAloud: true, geometry: null }]);
});

test("Textract keeps footer roles, exact image crops and source caption geometry outside the image", async () => {
  const image = await sharp({ create: { width: 101, height: 203, channels: 3, background: "white" } }).png().toBuffer();
  const figure = layout("figure", "LAYOUT_FIGURE", "", 0.103, 0.204, 0.307, 0.302);
  figure.Relationships = [{ Type: "CHILD", Ids: ["caption"] }];
  const caption = layout("caption", "LINE", "Caption outside the image.", 0.1, 0.52, 0.31, 0.02);
  const footer = layout("footer", "LAYOUT_FOOTER", "Footer label", 0.1, 0.95, 0.4, 0.02);
  const page = await buildTextractPage(image, [figure, caption, footer]);
  assert.deepEqual(page.paragraphs, ["Imagen.", "Caption outside the image.", "Footer label"]);
  assert.deepEqual(page.paragraphMetadata, [
    { role: "image", readAloud: true, geometry: { bbox: { left: 10 / 101, top: 41 / 203, width: 31 / 101, height: 61 / 203 } } },
    { role: "imageCaption", readAloud: true, geometry: { bbox: { left: 0.1, top: 0.52, width: 0.31, height: 0.02 } } },
    { role: "footer", readAloud: false, geometry: { bbox: { left: 0.1, top: 0.95, width: 0.4, height: 0.02 } } }
  ]);
  const invalid = { ...caption, Geometry: { BoundingBox: { Left: 1.1, Top: 0.52, Width: 0.3, Height: 0.02 } } };
  assert.equal((await buildTextractPage(image, [figure, invalid])).paragraphMetadata![1]!.geometry, null);
  assert.equal(page.rawText.includes("Footer label"), true);
});

test("Textract detects nearby labeled captions but not distant labels or body text beside icons", async () => {
  const image = await sharp({ create: { width: 500, height: 500, channels: 3, background: "white" } }).png().toBuffer();
  const page = await buildTextractPage(image, [
    layout("figure", "LAYOUT_FIGURE", "", 0.1, 0.2, 0.3, 0.3),
    layout("caption", "LAYOUT_TEXT", "Figura 2. Example.", 0.1, 0.51, 0.3, 0.02),
    layout("distant", "LAYOUT_TEXT", "Figura 3. Far away.", 0.1, 0.8, 0.3, 0.02),
    layout("body", "LAYOUT_TEXT", "Ordinary prose.", 0.6, 0.2, 0.3, 0.2)
  ]);
  const roles = new Map(page.paragraphs.map((text, index) => [text, page.paragraphMetadata![index]!.role]));
  assert.equal(roles.get("Figura 2. Example."), "imageCaption");
  assert.equal(roles.get("Figura 3. Far away."), "body");
  assert.equal(roles.get("Ordinary prose."), "body");
});

test("Vision accepts optional metadata through its JSON schema and honors explicit readAloud", async (t) => {
  const previousKey = appEnv.opencodeGoApiKey;
  appEnv.opencodeGoApiKey = "test-key";
  t.after(() => { appEnv.opencodeGoApiKey = previousKey; });
  const image = await sharp({ create: { width: 101, height: 203, channels: 3, background: "white" } }).png().toBuffer();
  let blocks: unknown[] = [
    { type: "heading", text: "Running header", role: "header", bbox: { x: 100, y: 10, width: 800, height: 30 }, readingBlockId: "header" },
    { type: "heading", text: "Chapter 2", readingBlockId: "main", readingRowId: "row" },
    { type: "paragraph", text: "Body.", readAloud: false, bbox: { x: 100, y: 200, width: 300, height: 400 }, readingBlockId: "main", readingRowId: "row" },
    { type: "image", bbox: { x: 103, y: 204, width: 307, height: 302 }, readingBlockId: "right", readingRowId: "row" },
    { type: "paragraph", text: "Caption.", role: "imageCaption", readingBlockId: "right", readingRowId: "row" },
    { type: "paragraph", text: "Footer.", role: "footer", readAloud: true, readingBlockId: "footer" },
    { type: "paragraph", text: "42", role: "pageNumber", readingBlockId: "footer" }
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json({ output_text: JSON.stringify({ blocks }) }));
  const result = await runOcrOnImage(image, "page.png", "image/png", { ocrMode: "VISION", model: "gpt-5.4-mini" });
  assert.equal(result.paragraphMetadata!.length, result.paragraphs.length);
  assert.deepEqual(result.paragraphMetadata!.map(({ role, readAloud }) => ({ role, readAloud })), [
    { role: "header", readAloud: false }, { role: "heading", readAloud: true }, { role: "body", readAloud: false },
    { role: "image", readAloud: true }, { role: "imageCaption", readAloud: true },
    { role: "footer", readAloud: true }, { role: "pageNumber", readAloud: false }
  ]);
  assert.deepEqual(result.paragraphMetadata![0]!.geometry, { bbox: { left: 0.1, top: 0.01, width: 0.8, height: 0.03 } });
  assert.deepEqual(result.paragraphMetadata![2]!.geometry, { bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 } });
  assert.deepEqual(result.paragraphMetadata![3]!.geometry, { bbox: { left: 10 / 101, top: 41 / 203, width: 31 / 101, height: 61 / 203 } });
  assert.equal(result.paragraphs.at(-1), "42");
  assert.doesNotMatch(result.rawText, /:::block|row=/u);
  for (const metadata of [{ role: "invalid" }, { readAloud: "false" }, { bbox: { x: -1, y: 0, width: 50, height: 50 } }]) {
    blocks = [{ type: "paragraph", text: "Invalid.", ...metadata }];
    await assert.rejects(runOcrOnImage(image, "page.png", "image/png", { ocrMode: "VISION", model: "gpt-5.4-mini" }), { code: "OCR_INVALID_RESPONSE" });
  }
});

test("LOCAL emits body defaults without inventing geometry", async (t) => {
  t.mock.method(Tesseract, "recognize", async () => ({ data: { text: "First paragraph.\nSecond paragraph." } }));
  const image = await sharp({ create: { width: 100, height: 100, channels: 3, background: "white" } }).png().toBuffer();
  const result = await runOcrOnImage(image, "page.png", "image/png", { ocrMode: "LOCAL" });
  assert.deepEqual(result.paragraphMetadata, result.paragraphs.map(() => ({ role: "body", readAloud: true, geometry: null })));
});

test("fallbacks and empty inputs never misalign paragraph metadata", async () => {
  const vision = await buildStructuredVisionPage(Buffer.alloc(0), [
    { type: "paragraph", text: " ", role: "header", readingBlockId: "empty" }
  ], ["", "Fallback.", " "], "Fallback.");
  assert.deepEqual(vision.paragraphs, ["Fallback."]);
  assert.deepEqual(vision.paragraphMetadata, [{ role: "body", readAloud: true, geometry: null }]);
  const textract = await buildTextractPage(Buffer.alloc(0), [layout("empty", "LAYOUT_HEADER", " ", 0.1, 0.1)]);
  assert.deepEqual(textract.paragraphs, []);
  assert.deepEqual(textract.paragraphMetadata, []);
  const lines = await buildTextractPage(Buffer.alloc(0), [
    layout("line", "LINE", "Source text.", 0.1, 0.2, 0.3, 0.04)
  ]);
  assert.deepEqual(lines.paragraphMetadata, [{ role: "body", readAloud: true,
    geometry: { bbox: { left: 0.1, top: 0.2, width: 0.3, height: 0.04 } } }]);
});
