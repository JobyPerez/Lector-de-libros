import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import ts from "typescript";
import { z } from "zod";
import { parseUploadedBook } from "../src/modules/books/book-import.js";
import { parsePdfBuffer } from "../src/modules/books/pdf-import.js";
import { normalizeParagraphMetadata } from "../src/modules/books/page-elements.js";

function pdf(draw: (document: PDFKit.PDFDocument) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    document.on("data", (chunk: Buffer) => chunks.push(chunk));
    document.on("error", reject);
    document.on("end", () => resolve(Buffer.concat(chunks)));
    draw(document);
    document.end();
  });
}

async function scanImage() {
  const blue = await sharp({ create: { width: 40, height: 40, channels: 3, background: "blue" } }).png().toBuffer();
  return sharp({ create: { width: 80, height: 40, channels: 3, background: "red" } })
    .composite([{ input: blue, left: 40, top: 0 }]).png().toBuffer();
}

async function scannedPdf() {
  const image = await scanImage();
  return pdf((document) => {
    document.addPage({ size: [180, 108], margin: 0 });
    document.image(image, 36, 18, { width: 72, height: 36 });
    // A vector mark outside the embedded image proves that the entire page is rendered.
    document.rect(144, 72, 18, 18).fill("#00ff00");
    document.addPage({ size: [108, 144], margin: 0 });
    document.addPage({ size: [144, 72], margin: 0 });
    document.page.dictionary.data.Rotate = 90;
    document.image(image, 0, 0, { width: 144, height: 72 });
  });
}

async function pixels(buffer: Buffer) {
  const { data, info } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return {
    info,
    at(x: number, y: number) {
      const offset = (y * info.width + x) * info.channels;
      return [...data.subarray(offset, offset + 3)];
    },
    data
  };
}

function near(actual: number[], expected: number[], message?: string) {
  assert.ok(actual.every((value, index) => Math.abs(value - expected[index]!) <= 8),
    message ?? `${actual} must be within JPEG tolerance of ${expected}`);
}

const parsers = [
  { name: "parsePdfBuffer", parse: parsePdfBuffer },
  { name: "parseUploadedBook", parse: (buffer: Buffer) => parseUploadedBook("PDF", buffer) }
];

for (const { name, parse } of parsers) {
  test(`${name}: scanned PDF keeps page order, blank pages, dimensions, rotation and complete rasterization`, async (t) => {
    const buffer = await scannedPdf();
    const original = Buffer.from(buffer);
    const imported = await parse(buffer);
    t.after(() => imported.cleanup?.());
    assert.deepEqual(buffer, original);
    assert.equal(imported.totalPages, 3);
    assert.equal(imported.totalParagraphs, 0);
    assert.deepEqual(imported.pages, [1, 2, 3].map((pageNumber) => ({ pageNumber, paragraphs: [], rawText: "" })));
    assert.ok(imported.pageImages);
    assert.equal(imported.pageImages.length, 3);
    for (const [index, image] of imported.pageImages.entries()) {
      assert.deepEqual(Object.keys(image).sort(), ["fileName", "filePath", "mimeType"]);
      assert.equal(image.fileName, `pagina-${index + 1}.jpg`);
      assert.equal(image.mimeType, "image/jpeg");
      assert.equal((await sharp(await readFile(image.filePath)).metadata()).format, "jpeg");
    }
    const first = await pixels(await readFile(imported.pageImages[0]!.filePath));
    assert.deepEqual([first.info.width, first.info.height], [500, 300]);
    near(first.at(10, 10), [255, 255, 255]);
    near(first.at(125, 75), [255, 0, 0]);
    near(first.at(275, 75), [0, 0, 255]);
    near(first.at(425, 225), [0, 255, 0]);
    const blank = await pixels(await readFile(imported.pageImages[1]!.filePath));
    assert.deepEqual([blank.info.width, blank.info.height], [300, 400]);
    assert.ok(blank.data.every((value) => value >= 247), "blank page must remain white within JPEG tolerance");
    const rotated = await pixels(await readFile(imported.pageImages[2]!.filePath));
    assert.deepEqual([rotated.info.width, rotated.info.height], [200, 400]);
    near(rotated.at(100, 50), [255, 0, 0], "left half rotates clockwise to the top");
    near(rotated.at(100, 350), [0, 0, 255]);
    assert.equal(typeof imported.cleanup, "function");
    const directory = dirname(imported.pageImages[0]!.filePath);
    await imported.cleanup!();
    await assert.rejects(access(directory), { code: "ENOENT" });
    await imported.cleanup!();
  });

  test(`${name}: normal text remains text and is not converted to page images`, async (t) => {
    const buffer = await pdf((document) => {
      for (const text of ["First readable paragraph.", "Second readable paragraph."]) {
        document.addPage({ size: [240, 180], margin: 18 });
        document.font("Helvetica").fontSize(12).text(text);
      }
    });
    const imported = await parse(buffer);
    t.after(() => imported.cleanup?.());
    assert.equal(imported.pageImages, undefined);
    assert.equal(imported.totalPages, 2);
    assert.equal(imported.totalParagraphs, 2);
    assert.deepEqual(imported.pages.map((page) => page.paragraphs), [["First readable paragraph."], ["Second readable paragraph."]]);
  });

  test(`${name}: text on a later page prevents whole-document conversion in a mixed PDF`, async (t) => {
    const image = await scanImage();
    const buffer = await pdf((document) => {
      document.addPage({ size: [240, 180], margin: 18 });
      document.image(image, 18, 18, { width: 160, height: 80 });
      document.addPage({ size: [240, 180], margin: 18 });
      document.font("Helvetica").fontSize(12).text("Text after the scanned page.");
    });
    const imported = await parse(buffer);
    t.after(() => imported.cleanup?.());
    assert.equal(imported.pageImages, undefined);
    assert.ok(imported.pages.some((page) => page.rawText.includes("Text after the scanned page.")));
    assert.ok(imported.totalParagraphs > 0);
  });

  test(`${name}: vector-only PDF is rasterized without any embedded image`, async (t) => {
    const buffer = await pdf((document) => {
      document.addPage({ size: [144, 72], margin: 0 });
      document.rect(0, 0, 72, 72).fill("red");
      document.rect(72, 0, 72, 72).fill("blue");
    });
    const imported = await parse(buffer);
    t.after(() => imported.cleanup?.());
    assert.equal(imported.totalPages, 1);
    assert.equal(imported.totalParagraphs, 0);
    assert.equal(imported.pageImages?.length, 1);
    const rendered = await pixels(await readFile(imported.pageImages![0]!.filePath));
    assert.deepEqual([rendered.info.width, rendered.info.height], [400, 200]);
    near(rendered.at(50, 100), [255, 0, 0]);
    near(rendered.at(350, 100), [0, 0, 255]);
  });

  test(`${name}: corrupt PDF rejects instead of producing an empty image book`, async () => {
    await assert.rejects(parse(Buffer.from("%PDF-1.7\nThis is not a PDF object or cross-reference table.\n%%EOF")), {
      statusCode: 422,
      message: /No se puede abrir el PDF: su estructura no es válida o el archivo está incompleto/u
    });
  });
}

test("page numbering alone is extractable text: no conversion even when normalization rejects it", async (t) => {
  const buffer = await pdf((document) => {
    for (const pageNumber of [1, 2]) {
      document.addPage({ size: [240, 180], margin: 0 });
      document.font("Helvetica").fontSize(10).text(String(pageNumber), 120, 150);
    }
  });
  const imported = await parsePdfBuffer(buffer);
  t.after(() => imported.cleanup?.());
  assert.equal(imported.pageImages, undefined);
  assert.equal(imported.totalPages, 2);
  assert.equal(imported.totalParagraphs, 0);
  await assert.rejects(parseUploadedBook("PDF", buffer), { statusCode: 422 });
});

test("rasterization bounds large pages while retaining the full page and reporting every page", async (t) => {
  const buffer = await pdf((document) => {
    document.addPage({ size: [2000, 1000], margin: 0 });
    document.rect(0, 0, 1000, 1000).fill("red");
    document.rect(1000, 0, 1000, 1000).fill("blue");
    document.addPage({ size: [72, 72], margin: 0 });
  });
  const progress: { completedUnits: number | null; totalUnits: number | null; message: string; progress: number }[] = [];
  const imported = await parsePdfBuffer(buffer, (event) => progress.push(event));
  t.after(() => imported.cleanup?.());
  const rendered = await pixels(await readFile(imported.pageImages![0]!.filePath));
  assert.deepEqual([rendered.info.width, rendered.info.height], [4000, 2000]);
  assert.ok(rendered.info.width * rendered.info.height <= 8_000_000);
  near(rendered.at(10, 1000), [255, 0, 0]);
  near(rendered.at(3990, 1000), [0, 0, 255]);
  const conversions = progress.filter((event) => event.message.includes("OCR pendiente"));
  assert.deepEqual(conversions.map((event) => [event.completedUnits, event.totalUnits]), [[1, 2], [2, 2]]);
  assert.ok(progress.every((event, index) => event.progress >= (progress[index - 1]?.progress ?? 0)));
});

test("POST /import persists scanned PDF as IMAGES with PAGE_IMAGE/PENDING, zero OCR and the unchanged original PDF", async (t) => {
  const routes = readFileSync(new URL("../src/modules/books/books.routes.ts", import.meta.url), "utf8");
  const source = ts.createSourceFile("books.routes.ts", routes, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "insertProcessedImagePages");
  assert.ok(declaration);
  const start = routes.indexOf('  app.post("/import",');
  const end = routes.indexOf("\n  });", start);
  assert.ok(start >= 0 && end > start);
  const body = routes.slice(start, end).split("async (request, reply) => {")[1];
  const compiled = ts.transpile(`${declaration.getText(source)}\nreturn async (request, reply) => {${body}\n};`, { target: ts.ScriptTarget.ES2022 });
  const buffer = await scannedPdf();
  const original = Buffer.from(buffer);
  const writes: { sql: string; binds: Record<string, any> }[] = [];
  const lifecycle: string[] = [];
  let ocrCalls = 0;
  let imported: Awaited<ReturnType<typeof parseUploadedBook>> | undefined;
  t.after(() => imported?.cleanup?.());
  const connection = {
    execute: async (sql: string, binds: Record<string, any>) => {
      if (sql.includes("SELECT COUNT(*)")) return { rows: [{ coverCount: writes.filter((write) => /INSERT INTO/.test(write.sql) && write.sql.includes("'COVER_IMAGE'")).length }] };
      writes.push({ sql, binds }); return { rows: [] };
    },
    commit: async () => { lifecycle.push("commit"); },
    rollback: async () => { lifecycle.push("rollback"); },
    close: async () => { lifecycle.push("close"); }
  };
  const forbiddenOcr = () => { ocrCalls++; throw new Error("Import must not run OCR"); };
  const dependencies = {
    z, randomUUID, readFile, unlink, normalizeParagraphMetadata,
    parseUploadedBook: async (...args: Parameters<typeof parseUploadedBook>) => {
      imported = await parseUploadedBook(...args);
      return imported;
    },
    getConnection: async () => connection,
    readMultipartField: () => undefined,
    importBookFieldsSchema: z.object({ title: z.string().optional(), languageCode: z.string().optional(), sourceType: z.string().optional() }),
    detectSourceType: () => "PDF",
    readUploadedFile: async () => buffer,
    deriveTitleFromFileName: () => "Scanned book",
    setBookImportProgress: () => {}, updateBookImportProgress: () => {},
    externalizeContentImages: (contents: string[]) => ({ contents, assets: [] }),
    insertContentImageAssets: async () => {}, recordUserActivity: async () => {},
    computeChecksum: (data: Buffer) => createHash("sha256").update(data).digest("hex"),
    runOcrOnImage: forbiddenOcr, ocrImageFiles: forbiddenOcr, getEffectiveUserAiCredentials: forbiddenOcr
  };
  const handler = new Function(...Object.keys(dependencies), compiled)(...Object.values(dependencies));
  const reply = {
    statusCode: 200, body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    send(value: unknown) { this.body = value; return this; }
  };
  await handler({ currentUser: { userId: "owner" }, query: {}, file: async () => ({ filename: "scanned.pdf", mimetype: "application/pdf", fields: {} }) }, reply);
  assert.equal(reply.statusCode, 201);
  assert.equal(reply.body.book.sourceType, "IMAGES");
  assert.equal(reply.body.book.totalPages, 3);
  assert.equal(reply.body.book.totalParagraphs, 0);
  assert.match(reply.body.importNotice, /3.*OCR/);
  assert.equal(writes.find(({ sql }) => /INSERT INTO books\s*\(/u.test(sql))?.binds.sourceType, "IMAGES");
  const storedOriginal = writes.filter(({ binds }) => binds.fileKind === "ORIGINAL_PDF");
  assert.equal(storedOriginal.length, 1);
  assert.deepEqual(storedOriginal[0]!.binds.contentBlob, original);
  assert.equal(storedOriginal[0]!.binds.fileName, "scanned.pdf");
  assert.equal(storedOriginal[0]!.binds.mimeType, "application/pdf");
  assert.equal(storedOriginal[0]!.binds.byteSize, original.length);
  assert.equal(storedOriginal[0]!.binds.checksumSha256, dependencies.computeChecksum(original));
  const images = writes.filter(({ sql }) => sql.includes("'PAGE_IMAGE'"));
  const pages = writes.filter(({ sql }) => /INSERT INTO book_pages\s*\(/u.test(sql));
  assert.deepEqual(images.map(({ binds }) => binds.pageNumber), [1, 2, 3]);
  assert.deepEqual(pages.map(({ binds }) => binds.pageNumber), [1, 2, 3]);
  for (const [index, { binds }] of pages.entries()) {
    assert.equal(binds.ocrStatus, "PENDING");
    assert.equal(binds.sourceFileId, images[index]!.binds.fileId);
    assert.equal(binds.rawText, "");
    assert.equal(binds.editedText, "");
    assert.equal(binds.htmlContent, null);
    assert.equal((await sharp(images[index]!.binds.contentBlob).metadata()).format, "jpeg");
    assert.equal(images[index]!.binds.fileName, `pagina-${index + 1}.jpg`);
    assert.equal(images[index]!.binds.mimeType, "image/jpeg");
  }
  assert.ok(!writes.some(({ sql }) => /INSERT INTO book_paragraphs/u.test(sql)));
  assert.equal(ocrCalls, 0);
  assert.deepEqual(lifecycle, ["commit", "close"]);
  assert.deepEqual(buffer, original);
  const covers = writes.filter(({ sql }) => /INSERT INTO/.test(sql) && sql.includes("'COVER_IMAGE'"));
  assert.equal(covers.length, 1);
  assert.deepEqual(covers[0]!.binds.contentBlob, images[0]!.binds.contentBlob);
  await assert.rejects(access(dirname(imported!.pageImages![0]!.filePath)), { code: "ENOENT" });
});

test("JPEG scan is smaller than lossless PNG while preserving dimensions, paper texture and fine ink strokes", async (t) => {
  const width = 800;
  const height = 600;
  const raw = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const ink = y >= 60 && y < 540 && y % 24 < 3 && x >= 60 && x < 740 && x % 16 < 11;
      const shade = ink ? 25 + ((seed >>> 16) % 8) : 232 + ((seed >>> 16) % 20);
      raw.fill(shade, (y * width + x) * 3, (y * width + x + 1) * 3);
    }
  }
  const png = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
  const buffer = await pdf((document) => {
    document.addPage({ size: [288, 216], margin: 0 });
    document.image(png, 0, 0, { width: 288, height: 216 });
  });
  const imported = await parsePdfBuffer(buffer);
  t.after(() => imported.cleanup?.());
  const jpeg = await readFile(imported.pageImages![0]!.filePath);
  assert.ok(jpeg.length < png.length * 0.65, `JPEG ${jpeg.length} should be substantially smaller than PNG ${png.length}`);
  const rendered = await pixels(jpeg);
  assert.deepEqual([rendered.info.width, rendered.info.height], [width, height]);
  let error = 0;
  for (let index = 0; index < raw.length; index++) error += Math.abs(raw[index]! - rendered.data[index]!);
  assert.ok(error / raw.length < 5, "mean pixel error must preserve the noisy scan rather than blur it away");
  for (const y of [72, 240, 504]) {
    assert.ok(rendered.at(66, y + 1).every((value) => value < 60), "three-pixel ink strokes must stay dark");
    assert.ok(rendered.at(76, y + 1).every((value) => value > 210), "five-pixel gaps between strokes must stay light");
  }
});

// Extract the real parser body, substituting only its dynamic PDF module import.
// This exercises guards and filesystem cleanup without enormous PDFs or allocations.
const parserSource = readFileSync(new URL("../src/modules/books/pdf-import.ts", import.meta.url), "utf8");
const parserAst = ts.createSourceFile("pdf-import.ts", parserSource, ts.ScriptTarget.Latest, true);
const parserDeclaration = parserAst.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "parsePdfBuffer");
assert.ok(parserDeclaration);
const mockedParserCode = parserDeclaration.getText(parserAst)
  .replace(/^export /, "")
  .replace('await import("pdfjs-dist/legacy/build/pdf.mjs")', "mockPdfModule");

for (const scenario of ["1000 pages", "1001 pages", "render fault", "encode fault", "write fault", "1 GiB exceeded"] as const) {
  test(`rasterization mock: ${scenario} releases temporary directory, canvas and PDF resources`, async (t) => {
    const directories: string[] = [];
    t.after(async () => { for (const directory of directories) await rm(directory, { recursive: true, force: true }); });
    const pageCount = scenario === "1000 pages" ? 1000 : scenario === "1001 pages" ? 1001 : 2;
    let renders = 0;
    let encodes = 0;
    let writes = 0;
    let destroys = 0;
    let cacheCleanups = 0;
    let pageCleanups = 0;
    const canvases: { width: number; height: number }[] = [];
    const fault = new Error(scenario);
    const document = {
      numPages: pageCount,
      getPage: async () => ({
        getTextContent: async () => ({ items: [] }),
        cleanup: () => { pageCleanups++; },
        getViewport: ({ scale }: { scale: number }) => ({ width: 10 * scale, height: 10 * scale }),
        render: () => {
          renders++;
          return { promise: scenario === "render fault" && renders === 2 ? Promise.reject(fault) : Promise.resolve() };
        }
      }),
      cleanup: async () => { cacheCleanups++; },
      destroy: async () => { destroys++; }
    };
    const dependencies = {
      mockPdfModule: { getDocument: () => ({ promise: Promise.resolve(document) }) },
      normalizeWhitespace: (text: string) => text.trim(),
      tmpdir, join, rm,
      mkdtemp: async (prefix: string) => {
        const directory = await mkdtemp(prefix);
        directories.push(directory);
        return directory;
      },
      createCanvas: (width: number, height: number) => {
        const canvas = {
          width, height, getContext: () => ({}),
          encode: async (format: string, quality: number) => {
            encodes++;
            assert.deepEqual([format, quality], ["jpeg", 95]);
            if (scenario === "encode fault" && encodes === 2) throw fault;
            // Synthetic lengths exercise the exact cumulative guard without allocating 1 GiB.
            return scenario === "1 GiB exceeded" ? { length: 512 * 1024 * 1024 + (encodes === 2 ? 1 : 0) } : Buffer.from("jpeg mock");
          }
        };
        canvases.push(canvas);
        return canvas;
      },
      writeFile: async (filePath: string, buffer: Buffer) => {
        writes++;
        if (scenario === "write fault" && writes === 2) throw fault;
        await writeFile(filePath, Buffer.isBuffer(buffer) ? buffer : Buffer.from("synthetic size"));
      }
    };
    const parse = new Function(...Object.keys(dependencies), ts.transpile(`${mockedParserCode}\nreturn parsePdfBuffer;`, {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None
    }))(...Object.values(dependencies));
    if (scenario === "1000 pages") {
      const imported = await parse(Buffer.from("mock"));
      t.after(() => imported.cleanup());
      assert.equal(imported.pageImages.length, 1000);
      assert.equal(writes, 1000);
      await access(imported.pageImages[999].filePath);
      await imported.cleanup();
    } else if (scenario === "1001 pages") {
      await assert.rejects(parse(Buffer.from("mock")), { statusCode: 422, message: /1000/ });
      assert.equal(directories.length, 0);
      assert.equal(renders, 0);
    } else {
      await assert.rejects(parse(Buffer.from("mock")), scenario === "1 GiB exceeded"
        ? { statusCode: 422, message: /1 GiB/ } : (error: unknown) => error === fault);
      assert.equal(directories.length, 1);
      assert.equal(writes, scenario === "write fault" ? 2 : 1, "first page was written before the fault");
    }
    for (const directory of directories) await assert.rejects(access(directory), { code: "ENOENT" });
    assert.equal(destroys, 1);
    assert.equal(cacheCleanups, renders);
    assert.equal(pageCleanups, pageCount + renders);
    assert.ok(canvases.every((canvas) => canvas.width === 1 && canvas.height === 1));
  });
}
