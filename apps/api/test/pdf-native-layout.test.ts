import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import test from "node:test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { analyzePdfPage, orderPdfImages, parsePdfBuffer } from "../src/modules/books/pdf-import.js";
import { parseUploadedBook } from "../src/modules/books/book-import.js";
import { extractedPdfImageGeometries, pdfImageGeometries } from "../src/modules/books/pdf-images.js";
import { analyzeSourcePdfPage, renderSourcePdfPage } from "../src/modules/books/pdf-source.js";
import { inferPdfElement, matchPdfBlock, pdfTextSimilarity, readPdfSourceBlob, resolvePdfSheet } from "../src/modules/books/pdf-page-preparation.js";

function pdf(draw: (document: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk)); document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks))); draw(document); document.end();
  });
}

test("top PDF image precedes both text columns even when painted after the text", async () => {
  const image = await sharp({ create: { width: 60, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const buffer = await pdf((document) => {
    document.addPage({ size: [600, 800], margin: 0 });
    document.fontSize(12).text("Left column starts here with a substantial paragraph about growing vegetables and preparing soil.", 60, 400, { width: 200 });
    document.text("Right column starts here with another substantial paragraph about healthy plants and harvesting.", 340, 400, { width: 200 });
    document.image(image, 60, 80, { width: 480, height: 280 });
  });
  const page = (await parseUploadedBook("PDF", buffer)).pages[0]!;
  assert.equal(page.paragraphMetadata![0]!.role, "image");
  assert.match(page.paragraphs[0]!, /Imagen 1 de la página 1/);
  assert.match(page.paragraphs[1]!, /Left column/);
  assert.match(page.paragraphs[2]!, /Right column/);
  assert.equal(page.paragraphs.length, page.paragraphMetadata!.length);
  assert.ok(page.htmlContent!.indexOf("<img") < page.htmlContent!.indexOf("Left column"));
});

test("image anchoring preserves column reading order, captions and unknown geometry", () => {
  const entry = (id: string, top: number, left: number, width: number, image = false) => ({ id, image, geometry: { bbox: { left, top, width, height: .1 } } });
  const leftTop = entry("left-top", .1, .1, .3), leftBottom = entry("left-bottom", .6, .1, .3);
  const rightTop = entry("right-top", .1, .6, .3), caption = entry("caption", .5, .6, .3);
  const image = entry("image", .3, .6, .3, true);
  const missing = { id: "unknown", image: true, geometry: null };
  const input = [leftTop, leftBottom, rightTop, caption, image, missing];
  assert.deepEqual(orderPdfImages(input).map((item) => item.id), ["left-top", "left-bottom", "right-top", "image", "caption", "unknown"]);
  assert.equal(input[4], image, "input is not mutated");
  const bottom = entry("bottom-image", .75, .1, .3, true);
  assert.deepEqual(orderPdfImages([leftTop, leftBottom, rightTop, bottom]).map((item) => item.id), ["left-top", "left-bottom", "bottom-image", "right-top"]);
});

test("native PDF preserves folios/margins and detects headings/body with aligned normalized zones", async () => {
  const buffer = await pdf((document) => {
    for (let index = 1; index <= 3; index++) {
      document.addPage({ size: [600, 800], margin: 0 });
      document.fontSize(9).text("Recurring book header", 50, 22, { lineBreak: false });
      document.fontSize(24).text("Vegetable garden", 50, 110, { lineBreak: false });
      document.fontSize(12).text("This is a native paragraph with enough text for body font detection.", 50, 180, { width: 450 });
      document.text("Another substantial paragraph describes the soil and how to keep the plants healthy.", 50, 220, { width: 450 });
      document.fontSize(9).text(String(index), 550, 770, { lineBreak: false });
    }
  });
  const imported = await parseUploadedBook("PDF", buffer);
  assert.equal(imported.totalPages, 3);
  for (const page of imported.pages) {
    assert.equal(page.sourcePdfPageNumber, page.pageNumber);
    assert.equal(page.paragraphs.length, page.paragraphMetadata!.length);
    const roles = page.paragraphMetadata!.map((item) => item.role);
    assert.ok(roles.includes("header") && roles.includes("heading") && roles.includes("body") && roles.includes("pageNumber"), JSON.stringify({ roles, paragraphs: page.paragraphs }));
    for (const item of page.paragraphMetadata!) {
      const box = item.geometry!.bbox;
      assert.ok(box.left >= 0 && box.top >= 0 && box.width > 0 && box.height > 0 && box.left + box.width <= 1.000001 && box.top + box.height <= 1.000001);
      if (["header", "footer", "pageNumber"].includes(item.role)) assert.equal(item.readAloud, false);
    }
    assert.match(page.htmlContent!, /<h1/);
    assert.match(page.htmlContent!, /data-element-geometry/);
  }
});

test("long native paragraphs retain one metadata descriptor per sanitized paragraph", async () => {
  const buffer = await pdf((document) => {
    document.addPage({ size: [600, 1400], margin: 40 });
    document.fontSize(10).text("Cultivar verduras saludables mejora el bienestar y protege la tierra. ".repeat(45));
  });
  const imported = await parseUploadedBook("PDF", buffer);
  assert.equal(imported.pages[0]!.paragraphs.length, imported.pages[0]!.paragraphMetadata!.length);
  assert.ok(imported.pages[0]!.paragraphs.every((text) => text.length <= 900));
});

test("image and text zones use the same rotated/cropped viewport as the faithful original preview", async () => {
  const red = await sharp({ create: { width: 60, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const buffer = await pdf((document) => {
    document.addPage({ size: [300, 400], margin: 0 });
    document.page.dictionary.data.Rotate = 90;
    document.fontSize(12).text("Rotated source text", 30, 40, { lineBreak: false });
    document.image(red, 30, 120, { width: 90, height: 60 });
  });
  const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfModule.getDocument(new Uint8Array(buffer)).promise;
  try {
    const page = await doc.getPage(1);
    const blocks = await analyzePdfPage(page);
    const images = [...(await pdfImageGeometries(page, pdfModule.OPS)).values()];
    assert.equal(images.length, 1);
    assert.ok(Math.abs(images[0]!.bbox.left - 0.55) < 0.01);
    assert.ok(Math.abs(images[0]!.bbox.top - 0.1) < 0.01);
    assert.ok(blocks[0]!.geometry.bbox.left > images[0]!.bbox.left);
  } finally { await doc.destroy(); }
  let loads = 0;
  const original = Buffer.from(buffer);
  const preview = await renderSourcePdfPage("rotated-layout-test", 1, async () => { loads++; return buffer; });
  const cached = await renderSourcePdfPage("rotated-layout-test", 1, async () => { throw new Error("Preview should be cached"); });
  assert.deepEqual(cached, preview);
  assert.equal(loads, 1);
  assert.deepEqual(buffer, original);
  const { data, info } = await sharp(preview).raw().toBuffer({ resolveWithObject: true });
  assert.ok(info.width > info.height);
  const offset = (Math.floor(info.height * 0.2) * info.width + Math.floor(info.width * 0.62)) * info.channels;
  assert.ok(data[offset]! > 220 && data[offset + 1]! < 30);
  let ink = 0;
  for (let y = 0; y < info.height; y++) for (let x = Math.floor(info.width * 0.8); x < info.width; x++) {
    const position = (y * info.width + x) * info.channels;
    if (data[position]! < 100 && data[position + 1]! < 100 && data[position + 2]! < 100) ink++;
  }
  assert.ok(ink > 30, "Unembedded standard-font text must actually render, not disappear from the original view");
  await assert.rejects(renderSourcePdfPage("rotated-layout-test", 2, async () => buffer), { statusCode: 422 });
});

test("preparing legacy geometry preserves editorial flags, ignores ambiguous matches and tolerates accents/hyphenation", () => {
  const geometry = { bbox: { left: 0.1, top: 0.9, width: 0.5, height: 0.02 } };
  const block = { text: "Cabecera del capítulo con información importante", geometry, role: "footer" as const };
  assert.equal(pdfTextSimilarity("capí-\ntulo con información", "capitulo con informacion"), 1);
  assert.equal(matchPdfBlock(block.text, [block]), block);
  assert.equal(matchPdfBlock(block.text, [block, { ...block }]), null);
  const old = { role: "body" as const, readAloud: true, geometry: null };
  const inferred = inferPdfElement(old, block, false);
  assert.equal(inferred.role, "footer"); assert.equal(inferred.readAloud, false);
  const editorial = { ...old, active: false, includeInToc: true };
  const preserved = inferPdfElement(editorial, block, true);
  assert.equal(preserved.role, editorial.role); assert.equal(preserved.readAloud, editorial.readAloud);
  assert.equal(preserved.active, false); assert.equal(preserved.includeInToc, true);
  assert.deepEqual(preserved.geometry, geometry);
  assert.equal(inferPdfElement(preserved, block, false), preserved);
});

test("legacy PDF source matching ignores gallery position and refuses ambiguous/image-only guesses", async () => {
  const sentences = [
    "Astronomy planets stars galaxies telescopes gravity satellites orbits constellations moon meteor comet universe.",
    "Garden soil tomato carrot lettuce compost seeds irrigation harvest roots nutrients cucumber cabbage potato.",
    "Music piano guitar violin orchestra strings rhythm melody harmony instrument brass concert percussion conductor."
  ];
  const buffer = await pdf((document) => {
    for (const sentence of sentences) { document.addPage({ size: [600, 800], margin: 40 }); document.text(sentence); }
  });
  const connection = { execute: async () => ({ rows: [{ buffer }] }) };
  const source = { fileId: "legacy-matching", checksum: "test-pdf", sourcePageNumber: null, pageId: "stable-id", pageNumber: 99, rawText: sentences[1]! };
  assert.equal(await resolvePdfSheet(connection, "test-book", source), 2);
  await assert.rejects(resolvePdfSheet(connection, "test-book", { ...source, rawText: "Image only" }), { statusCode: 409 });
  assert.equal(await resolvePdfSheet(connection, "test-book", { ...source, rawText: "Image only" }, 3), 3);
  await assert.rejects(resolvePdfSheet(connection, "test-book", source, 4), { statusCode: 422 });
  await assert.rejects(resolvePdfSheet(connection, "test-book", { ...source, sourcePageNumber: 2 }, 3), { statusCode: 409 });
});

test("native zones honor the PDF CropBox rather than assuming an untrimmed MediaBox", async () => {
  const image = await sharp({ create: { width: 60, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const buffer = await pdf((document) => {
    document.addPage({ size: [300, 400], margin: 0 });
    document.page.dictionary.data.CropBox = [50, 60, 250, 360];
    document.text("Text within the visible crop", 80, 80, { lineBreak: false });
    document.image(image, 100, 120, { width: 60, height: 40 });
  });
  const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfModule.getDocument(new Uint8Array(buffer)).promise;
  try {
    const page = await doc.getPage(1);
    assert.deepEqual([page.getViewport({ scale: 1 }).width, page.getViewport({ scale: 1 }).height], [200, 300]);
    const imageBox = [...(await pdfImageGeometries(page, pdfModule.OPS)).values()][0]!.bbox;
    assert.ok(Math.abs(imageBox.left - 0.25) < 0.001);
    assert.ok(Math.abs(imageBox.top - 80 / 300) < 0.001);
    assert.ok(Math.abs(imageBox.width - 0.3) < 0.001);
    assert.ok(Math.abs(imageBox.height - 40 / 300) < 0.001);
  } finally { await doc.destroy(); }
});

test("body text near a page edge is not muted as a header merely because of its position", async () => {
  const buffer = await pdf((document) => {
    document.addPage({ size: [600, 800], margin: 0 });
    document.fontSize(12).text("This is ordinary substantive body text that begins near the top edge.", 30, 12, { width: 530 });
    document.text("The next body paragraph provides enough context to identify the normal font size.", 30, 60, { width: 530 });
  });
  const imported = await parseUploadedBook("PDF", buffer);
  assert.ok(imported.pages[0]!.paragraphMetadata!.every((metadata) => metadata.role === "body" && metadata.readAloud));
});

test("image geometry keeps invisible CropBox slots and the exact extraction size filter without shifting later images", async () => {
  const red = await sharp({ create: { width: 60, height: 40, channels: 3, background: "red" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 60, height: 40, channels: 3, background: "blue" } }).png().toBuffer();
  const tiny = await sharp({ create: { width: 12, height: 12, channels: 3, background: "green" } }).png().toBuffer();
  const buffer = await pdf((document) => {
    document.addPage({ size: [300, 400], margin: 0 });
    document.page.dictionary.data.CropBox = [50, 60, 250, 360];
    document.image(blue, 0, 0, { width: 40, height: 40 });
    document.image(tiny, 80, 100, { width: 12, height: 12 });
    document.image(red, 100, 120, { width: 60, height: 40 });
  });
  const pdfModule = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfModule.getDocument(new Uint8Array(buffer)).promise;
  try {
    const images = await extractedPdfImageGeometries(await document.getPage(1), pdfModule.OPS);
    assert.equal(images.length, 2);
    assert.equal(images[0], null);
    assert.ok(Math.abs(images[1]!.bbox.left - 0.25) < 0.001);
  } finally { await document.destroy(); }
});

test("native analysis executes in the bounded worker, not the API event loop", async () => {
  const buffer = await pdf((document) => { document.addPage({ size: [600, 800], margin: 40 }); document.text("Native document analysis runs independently from requests and authentication."); });
  const result = await analyzeSourcePdfPage("worker-analysis-test", 1, async () => buffer);
  assert.equal(result.number, 1);
  assert.match(result.blocks[0]!.text, /independently/);
  const source = readFileSync(new URL("../src/modules/books/pdf-source.ts", import.meta.url), "utf8");
  assert.match(source, /new Worker\(/);
  assert.doesNotMatch(source, /getDocument\(|getOperatorList\(|page\.render\(/);
});

test("PDF worker queue refuses excess work rather than exhausting the API connection pool", async () => {
  const buffer = await pdf((document) => { document.addPage({ size: [100, 100], margin: 0 }); document.rect(0, 0, 100, 100).fill("red"); });
  let release!: (buffer: Buffer) => void;
  const delayed = new Promise<Buffer>((resolve) => { release = resolve; });
  const jobs = Array.from({ length: 6 }, () => renderSourcePdfPage("queue-test", 1, () => delayed));
  await assert.rejects(renderSourcePdfPage("queue-test", 1, () => delayed), { statusCode: 503 });
  release(buffer);
  const results = await Promise.all(jobs);
  assert.ok(results.every((result) => result.equals(results[0]!)));
});

test("Oracle PDF LOB loading streams bounded pieces and yields without materializing a synchronous BUFFER fetch", async () => {
  const stream = Readable.from([Buffer.from("first"), Buffer.from("second")]);
  let yielded = false;
  setImmediate(() => { yielded = true; });
  assert.equal((await readPdfSourceBlob(stream)).toString(), "firstsecond");
  assert.equal(yielded, true);
  assert.equal(stream.destroyed, true);
  const oversized = Readable.from([Buffer.from("123"), Buffer.from("456")]);
  await assert.rejects(readPdfSourceBlob(oversized, 4), { statusCode: 422 });
  assert.equal(oversized.destroyed, true);
});
