import assert from "node:assert/strict";
import test from "node:test";

import { buildRichPageFromParagraphs, extractEmbeddedImageSources } from "../src/modules/books/rich-content.js";

test("conserva una imagen SVG de portada al editar la pagina", () => {
  const source = "data:image/jpeg;base64,Y292ZXI=";
  const htmlContent = `<div class="epub-page-shell"><div class="epub-page-body"><svg><image alt="Portada" xlink:href="${source}" /></svg></div></div>`;
  const embeddedImages = extractEmbeddedImageSources(htmlContent);

  assert.equal(embeddedImages.get("embedded-image-1"), source);

  const rebuiltPage = buildRichPageFromParagraphs(["::center:: ![Portada](embedded-image-1)"], { embeddedImages });
  assert.match(rebuiltPage.htmlContent ?? "", new RegExp(`src="${source}"`, "u"));
  assert.match(rebuiltPage.htmlContent ?? "", /data-text-align="center"/u);
  assert.equal(rebuiltPage.editedText, "::center:: ![Portada](embedded-image-1)");
  assert.deepEqual(rebuiltPage.paragraphs, []);
});

test("conserva enlaces internos del lector al editar texto", () => {
  const rebuiltPage = buildRichPageFromParagraphs([
    "Ir al [Capítulo 2](reader-page-19-paragraph-1)"
  ]);

  assert.match(rebuiltPage.htmlContent ?? "", /<a data-lector-page="19" data-lector-paragraph="1" href="\?page=19&amp;paragraph=1">Capítulo 2<\/a>/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Ir al Capítulo 2"]);
});
