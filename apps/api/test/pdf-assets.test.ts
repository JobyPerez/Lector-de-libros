import assert from "node:assert/strict";
import { constants } from "node:buffer";
import { randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";

import { preparePdfAssets } from "../src/modules/books/pdf-assets.js";
import { buildPdfExport } from "../src/modules/books/book-export.js";

test("large books keep binary assets separate even when inline HTML would exceed V8's string limit", () => {
  const assetId = randomUUID();
  const buffer = Buffer.alloc(2 * 1024 * 1024);
  const sheets = Array.from({ length: 338 }, (_, index) => `<section>Page ${index}<img src="lector-content-image:${assetId}"></section>`);
  assert.ok(Math.ceil(buffer.length / 3) * 4 * sheets.length > constants.MAX_STRING_LENGTH);
  const prepared = preparePdfAssets(sheets, new Map([[assetId, { buffer, mimeType: "image/png" }]]));
  assert.equal(prepared.resources.size, 1);
  assert.equal([...prepared.resources.values()][0]!.buffer, buffer, "do not duplicate binary image buffers");
  const document = prepared.sheets.join("");
  assert.ok(document.length < 100_000);
  assert.doesNotMatch(document, /base64|lector-content-image:/u);
  assert.equal((document.match(/https:\/\/lector-pdf-assets.invalid\//gu) ?? []).length, 338);
});

test("legacy inline images and covers are externalized and deduplicated across PDF sheets", async () => {
  const buffer = await sharp({ create: { width: 80, height: 40, channels: 3, background: "blue" } }).png().toBuffer();
  const source = `data:image/png;base64,${buffer.toString("base64")}`;
  const prepared = preparePdfAssets([`<img src="${source}">`, `<figure><img src="${source}"></figure>`]);
  assert.equal(prepared.resources.size, 1);
  assert.deepEqual([...prepared.resources.values()][0]!.buffer, buffer);
  assert.doesNotMatch(prepared.sheets.join(""), /base64/u);
  const [url] = prepared.resources.keys();
  for (const sheet of prepared.sheets) assert.ok(sheet.includes(url!));
});

test("PDF renders referenced content images on every page without permitting unknown image URLs", async () => {
  const assetId = randomUUID();
  const image = await sharp({ create: { width: 100, height: 60, channels: 3, background: "red" } }).png().toBuffer();
  const buffer = await buildPdfExport({
    book: { title: "Binary images", languageCode: "es", authorName: null, synopsis: null },
    coverAsset: null, outline: [],
    contentImages: new Map([[assetId, { buffer: image, mimeType: "image/png" }]]),
    pages: [1, 2, 3].map((pageNumber) => ({
      pageNumber, pageLabel: null, paragraphs: [],
      htmlContent: `<p>Page ${pageNumber}</p><img src="lector-content-image:${assetId}"><img src="https://lector-pdf-assets.invalid/unknown"><img src="https://example.invalid/private.png">`
    }))
  });
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 3);
    for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const operators = await page.getOperatorList();
      // Failed/blocked images may produce Chromium's small broken-image icon.
      const bookImages = operators.argsArray.filter((args, index) =>
        operators.fnArray[index] === OPS.paintImageXObject && args[1] === 100 && args[2] === 60);
      assert.equal(bookImages.length, 1);
      assert.ok((await page.getTextContent()).items.some((item) => "str" in item && item.str === `Page ${pageNumber}`));
    }
  } finally {
    await pdf.destroy();
  }
});
