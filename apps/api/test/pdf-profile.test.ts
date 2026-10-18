import assert from "node:assert/strict";
import { randomFillSync, randomUUID } from "node:crypto";
import test from "node:test";
import sharp from "sharp";
import { optimizePdfImage, pdfExportQuerySchema, validatePdfProfile } from "../src/modules/books/pdf-profile.js";
import { preparePdfAssets, optimizePdfAssets } from "../src/modules/books/pdf-assets.js";
import { buildImagePdfExport, buildPdfExport } from "../src/modules/books/book-export.js";

test("PDF profile validation preserves old requests and rejects incompatible choices", () => {
  assert.equal(pdfExportQuerySchema.parse({}).profile, "original");
  assert.equal(pdfExportQuerySchema.parse({ profile: "balanced" }).profile, "balanced");
  assert.throws(() => pdfExportQuerySchema.parse({ profile: "invalid" }));
  assert.throws(() => validatePdfProfile("pdf-images", "text-only"));
  assert.throws(() => validatePdfProfile("epub", "compact"));
  assert.doesNotThrow(() => validatePdfProfile("pdf", "text-only"));
});

test("compression profiles reduce raster size progressively without mutating source images or layout", async () => {
  const pixels = randomFillSync(Buffer.alloc(2400 * 3000 * 3));
  const buffer = await sharp(pixels, { raw: { width: 2400, height: 3000, channels: 3 } }).png().toBuffer();
  const image = { buffer, mimeType: "image/png" };
  assert.equal(await optimizePdfImage(image, "original"), image);
  const balanced = await optimizePdfImage(image, "balanced");
  const compact = await optimizePdfImage(image, "compact");
  assert.ok(balanced.buffer.length < buffer.length / 2);
  assert.ok(compact.buffer.length < balanced.buffer.length);
  assert.equal((await sharp(balanced.buffer).metadata()).height, 2200);
  assert.equal((await sharp(compact.buffer).metadata()).height, 1400);
  assert.equal(balanced.originalWidth, 2400);
  assert.equal((await sharp(buffer).metadata()).format, "png");
  const assetId = randomUUID();
  const optimized = await optimizePdfAssets(preparePdfAssets([`<img src="lector-content-image:${assetId}">`], new Map([[assetId, image]])), "compact");
  assert.match(optimized.sheets[0]!, /width="2400"/u);
});

test("text-only PDF keeps active OCR and index links but excludes images and cover", async () => {
  const image = await sharp({ create: { width: 80, height: 120, channels: 3, background: "red" } }).png().toBuffer();
  const buffer = await buildPdfExport({
    book: { title: "Solo texto", languageCode: "es", authorName: null, synopsis: null },
    coverAsset: { buffer: image, mimeType: "image/png", fileName: "cover.png" }, profile: "text-only",
    outline: [{ title: "Capítulo", pageNumber: 1, paragraphNumber: 1, level: 1 }],
    pages: [{ pageNumber: 1, pageLabel: null, htmlContent: `<img src="data:image/png;base64,${image.toString("base64")}"><p>Obsoleto</p>`,
      paragraphs: [{ paragraphText: "Capítulo", role: "heading" }, { paragraphText: "Texto OCR actualizado" },
        { paragraphText: "Inactivo", active: false }, { paragraphText: "Imagen", role: "image" }] }]
  });
  const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  try {
    assert.equal(pdf.numPages, 2);
    const page = await pdf.getPage(2);
    const text = (await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
    assert.match(text, /Texto OCR actualizado/u);
    assert.doesNotMatch(text, /Inactivo|Imagen|Obsoleto/u);
    for (let n = 1; n <= pdf.numPages; n++) {
      assert.ok(!(await (await pdf.getPage(n)).getOperatorList()).fnArray.includes(OPS.paintImageXObject));
    }
    const [link] = (await (await pdf.getPage(1)).getAnnotations()).filter((annotation) => annotation.dest);
    const destination = typeof link!.dest === "string" ? await pdf.getDestination(link!.dest) : link!.dest;
    assert.equal(await pdf.getPageIndex(destination[0]), 1);
  } finally { await pdf.destroy(); }
});

test("compressed image PDFs preserve page geometry and refuse text-only", async () => {
  const buffer = await sharp({ create: { width: 3000, height: 1500, channels: 3, background: "blue" } }).png().toBuffer();
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  for (const profile of ["balanced", "compact"] as const) {
    const pdf = await getDocument({ data: new Uint8Array(await buildImagePdfExport({ title: "Imagen", profile, pages: [{ buffer, pageNumber: 1 }] })), useSystemFonts: true }).promise;
    try {
      assert.equal(pdf.numPages, 1);
      const viewport = (await pdf.getPage(1)).getViewport({ scale: 1 });
      assert.ok(Math.abs(viewport.height / viewport.width - 0.5) < 0.001);
    } finally { await pdf.destroy(); }
  }
  await assert.rejects(buildImagePdfExport({ title: "Imagen", profile: "text-only", pages: [{ buffer, pageNumber: 1 }] }), { statusCode: 400 });
});
