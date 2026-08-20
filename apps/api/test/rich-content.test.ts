import assert from "node:assert/strict";
import test from "node:test";

import { buildRichPageFromEditableText, buildRichPageFromParagraphs, extractEmbeddedImageSources } from "../src/modules/books/rich-content.js";

test("conserva una imagen SVG de portada al editar la pagina", () => {
  const source = "data:image/jpeg;base64,Y292ZXI=";
  const htmlContent = `<div class="epub-page-shell"><div class="epub-page-body"><svg><image alt="Portada" xlink:href="${source}" /></svg></div></div>`;
  const embeddedImages = extractEmbeddedImageSources(htmlContent);

  assert.equal(embeddedImages.get("embedded-image-1"), source);

  const rebuiltPage = buildRichPageFromParagraphs(["::center:: ![Portada](embedded-image-1)"], { embeddedImages });
  assert.match(rebuiltPage.htmlContent ?? "", new RegExp(`src="${source}"`, "u"));
  assert.match(rebuiltPage.htmlContent ?? "", /data-text-align="center"/u);
  assert.equal(rebuiltPage.editedText, "::center:: ![Portada](embedded-image-1)");
  assert.match(rebuiltPage.htmlContent ?? "", /data-reader-text="Imagen\. Portada"/u);
  assert.deepEqual(rebuiltPage.paragraphs, ["Imagen. Portada"]);
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
