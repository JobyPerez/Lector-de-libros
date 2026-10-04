import assert from "node:assert/strict";
import test from "node:test";
import { load } from "cheerio";
import { externalizeContentImages } from "../src/modules/books/content-images.js";
import type { ParagraphElementMetadata } from "../src/modules/books/page-elements.js";

import { buildRichPageFromEditableText, buildRichPageFromParagraphs, extractEmbeddedImageSources, hasValidReadingBlockMarkers } from "../src/modules/books/rich-content.js";

test("row markers survive saving and reload without entering narration or paragraph counts", () => {
  const text = ":::block left row=spread_1\nLeft.\n![Figure](data:image/png;base64,YQ==)\n:::block right row=spread_1\nRight.\n:::block footer\n23\n:::block single row=single-row\nSingle.";
  const page = buildRichPageFromEditableText(text);
  const saved = externalizeContentImages([page.editedText, page.htmlContent!]);
  const reloaded = buildRichPageFromEditableText(saved.contents[0]!);
  assert.equal(reloaded.editedText, saved.contents[0]);
  assert.deepEqual(reloaded.paragraphs, ["Left.", "Imagen. Figure", "Right.", "23", "Single."]);
  assert.doesNotMatch(reloaded.rawText, /:::block|row=/u);
  const $ = load(reloaded.htmlContent!);
  const rows = $("div.reader-reading-row");
  assert.deepEqual(rows.map((_, node) => $(node).attr("data-reading-row-id")).get(), ["spread_1", "single-row"]);
  assert.equal(rows.eq(0).children("section").length, 2);
  assert.equal(rows.eq(1).children("section").length, 1);
  assert.equal(rows.eq(0).children().eq(1).attr("data-reading-row-id"), "spread_1");
  assert.equal($("section[data-reading-block-id=footer]").parent().hasClass("reader-reading-row"), false);
  assert.deepEqual($(".reader-rich-node").map((_, node) => $(node).attr("data-paragraph-number")).get(), ["1", "2", "3", "4", "5"]);
});

test("row validation uses exact ID syntax and forbids nonconsecutive recurrence", () => {
  for (const text of [
    ":::block a row=", ":::block a row=bad id", ":::block a row=<unsafe>",
    `:::block a row=${"r".repeat(81)}`, ":::block a row=r extra=x",
    ":::block a row=r\n:::block b row=s\n:::block c row=r",
    ":::block a row=r\n:::block b\n:::block c row=r",
    ":::block a row=r\n:::block a row=r"
  ]) {
    assert.equal(hasValidReadingBlockMarkers(text), false, text);
    assert.throws(() => buildRichPageFromEditableText(text), /Invalid or duplicate/u);
  }
  assert.equal(hasValidReadingBlockMarkers(`:::block ${"b".repeat(80)} row=${"r".repeat(80)}\nText.\n:::block other row=${"r".repeat(80)}`), true);
});

test("conserva una imagen SVG de portada al editar la pagina", () => {
  const source = "data:image/jpeg;base64,Y292ZXI=";
  const htmlContent = `<div class="epub-page-shell"><div class="epub-page-body"><svg><image alt="Portada" xlink:href="${source}" /></svg></div></div>`;
  const embeddedImages = extractEmbeddedImageSources(htmlContent);

  assert.equal(embeddedImages.get("embedded-image-1"), source);

  const rebuiltPage = buildRichPageFromParagraphs(["::center:: ![Portada](embedded-image-1)"], { embeddedImages });
  assert.match(rebuiltPage.htmlContent ?? "", new RegExp(`src="${source}"`, "u"));
  assert.match(rebuiltPage.htmlContent ?? "", /data-text-align="center"/u);
  assert.equal(rebuiltPage.editedText, `::center:: ![Portada](${source})`);
  assert.match(rebuiltPage.htmlContent ?? "", /data-reader-text="Imagen\. Portada"/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Imagen. Portada"]);
});

test("reading blocks preserve markers and keep narration flat and sequential", () => {
  const text = ":::block 68f3030b-92ee-41a6-a281-f1c08a0fbfaa\nFirst paragraph.\nSecond paragraph.\n:::block group_2\n![Figure](https://example.com/image.png)\n# Heading";
  const page = buildRichPageFromEditableText(text);
  assert.equal(page.editedText, text);
  assert.deepEqual(page.paragraphs, ["First paragraph.", "Second paragraph.", "Imagen. Figure", "Heading"]);
  assert.equal(page.rawText, page.paragraphs.join("\n"));
  const document = load(page.htmlContent!);
  const sections = document("section.reader-reading-block");
  assert.equal(sections.length, 2);
  assert.equal(sections.eq(0).attr("data-reading-block-number"), "1");
  assert.equal(sections.eq(1).attr("data-reading-block-id"), "group_2");
  assert.equal(sections.eq(1).find("figure").length, 1);
  assert.deepEqual(document(".reader-rich-node").toArray().map((node) => document(node).attr("data-paragraph-number")), ["1", "2", "3", "4"]);
  assert.doesNotMatch(document("body").text(), /:::block|group_2|68f3030b/);
});

test("legacy text renders as one implicit reading block without adding a marker", () => {
  const page = buildRichPageFromEditableText("First.\nSecond.");
  assert.equal(page.editedText, "First.\nSecond.");
  const document = load(page.htmlContent!);
  assert.equal(document("section.reader-reading-block").length, 1);
  assert.equal(document("section").attr("data-reading-block-id"), "page");
  assert.deepEqual(page.paragraphs, ["First.", "Second."]);
});

test("invalid and duplicate block markers are rejected", () => {
  for (const marker of [":::block", ":::block bad id", ":::block <unsafe>", `:::block ${"a".repeat(81)}`, ":::block same\nText.\n:::block same"]) {
    assert.throws(() => buildRichPageFromEditableText(`${marker}\nText.`), /Invalid or duplicate/);
  }
  assert.equal(buildRichPageFromEditableText(":::block empty").htmlContent, null);
});

test("text before the first marker has a non-colliding implicit block", () => {
  const page = buildRichPageFromEditableText("Introduction.\n:::block page\nContent.");
  const document = load(page.htmlContent!);
  assert.deepEqual(document("section").toArray().map((node) => document(node).attr("data-reading-block-id")), ["page-1", "page"]);
  assert.deepEqual(page.paragraphs, ["Introduction.", "Content."]);
});

test("two reordered saves stabilize legacy image placeholders to real asset references", () => {
  const oldHtml = '<div class="epub-page-body"><img src="data:image/png;base64,YQ=="><img src="data:image/png;base64,Yg=="></div>';
  const first = buildRichPageFromEditableText(":::block images\n![B](embedded-image-2)\n![A](embedded-image-1)", { embeddedImages: extractEmbeddedImageSources(oldHtml) });
  const saved = externalizeContentImages([first.editedText, first.htmlContent!]);
  assert.equal(saved.assets.length, 2);
  assert.doesNotMatch(saved.contents[0]!, /embedded-image-/);
  const lines = saved.contents[0]!.split("\n");
  const secondText = [lines[0], lines[2], lines[1]].join("\n");
  const second = buildRichPageFromEditableText(secondText, { embeddedImages: extractEmbeddedImageSources(saved.contents[1]) });
  const savedAgain = externalizeContentImages([second.editedText, second.htmlContent!]);
  assert.equal(savedAgain.assets.length, 0);
  assert.equal(savedAgain.contents[0], secondText);
  const document = load(savedAgain.contents[1]!);
  assert.deepEqual(document("img").toArray().map((node) => document(node).attr("src")), [saved.assets[1]!.reference, saved.assets[0]!.reference]);
});

test("narra una imagen sin comentario sin mostrar un pie", () => {
  const rebuiltPage = buildRichPageFromEditableText("![](https://example.com/image.jpg)");

  assert.match(rebuiltPage.htmlContent ?? "", /data-paragraph-number="1"/u);
  assert.match(rebuiltPage.htmlContent ?? "", /data-reader-text="Imagen\."/u);
  assert.doesNotMatch(rebuiltPage.htmlContent ?? "", /<figcaption>/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Imagen."]);
});

test("narra el texto de una imagen en el idioma del libro", () => {
  const rebuiltPage = buildRichPageFromEditableText("![Copertina](https://example.com/cover.jpg)", { languageCode: "it" });

  assert.match(rebuiltPage.htmlContent ?? "", /<figcaption>Copertina<\/figcaption>/u);
  assert.match(rebuiltPage.htmlContent ?? "", /data-reader-text="Immagine\. Copertina"/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Immagine. Copertina"]);
});

test("conserva enlaces internos del lector al editar texto", () => {
  const rebuiltPage = buildRichPageFromParagraphs([
    "Ir al [Capítulo 2](reader-page-19-paragraph-1)"
  ]);

  assert.match(rebuiltPage.htmlContent ?? "", /<a data-lector-page="19" data-lector-paragraph="1" href="\?page=19&amp;paragraph=1">Capítulo 2<\/a>/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Ir al Capítulo 2"]);
});

test("metadata is opt-in and aligned with paragraphs, never with row markers", () => {
  const text = ":::block left row=r\n# Heading\n![](https://example.com/image.png)\n:::block right row=r\nBody.\n:::block footer\n42\n:::block empty";
  const legacy = buildRichPageFromEditableText(text);
  assert.deepEqual(Object.keys(legacy).sort(), ["editedText", "htmlContent", "paragraphs", "rawText"]);
  const paragraphMetadata: ParagraphElementMetadata[] = [
    { role: "heading", readAloud: true, geometry: { bbox: { left: 0.1, top: 0.1, width: 0.3, height: 0.1 } } },
    { role: "image", readAloud: true, geometry: null },
    { role: "body", readAloud: true },
    { role: "pageNumber", readAloud: false, geometry: null }
  ];
  const page = buildRichPageFromEditableText(text, { paragraphMetadata });
  assert.deepEqual(page, { ...legacy, paragraphMetadata });
  assert.deepEqual(page.paragraphs, ["Heading", "Imagen.", "Body.", "42"]);
  assert.doesNotMatch(page.rawText, /:::block|row=/u);
  assert.throws(() => buildRichPageFromEditableText(text, { paragraphMetadata: [] }), /corresponder exactamente/u);
  assert.deepEqual(buildRichPageFromParagraphs([], { paragraphMetadata: [] }), {
    editedText: "", htmlContent: null, paragraphs: [], rawText: "", paragraphMetadata: []
  });
});
