import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { encodePdfImage, extractPdfImages } from "../src/modules/books/pdf-images.js";

test("packed monochrome images decode bits and row padding rather than treating bits as bytes", async () => {
  const image = await encodePdfImage({ width: 9, height: 2, kind: 1, data: new Uint8Array([0x80, 0x80, 0x7f, 0]) });
  const { data } = await sharp(image).greyscale().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([...data], [255, 0, 0, 0, 0, 0, 0, 0, 255, 0, 255, 255, 255, 255, 255, 255, 255, 0]);
});

test("image extraction awaits local and shared objects and accepts inline image data", async () => {
  const image = { width: 30, height: 30, kind: 2, data: new Uint8Array(30 * 30 * 3).fill(120) };
  const accesses: string[] = [];
  const objects = (store: string) => ({ get(id: string, callback?: (value: unknown) => void) {
    assert.ok(callback, "PDFObjects.get needs a callback, not await get(id)");
    accesses.push(`${store}:${id}`);
    queueMicrotask(() => callback(image));
  } });
  const page = {
    getOperatorList: async () => ({ fnArray: [1, 1, 2, 3, 4], argsArray: [["local"], ["g_shared"], [image], ["local"], [image, []]] }),
    objs: objects("page"), commonObjs: objects("common")
  } as unknown as PDFPageProxy;
  const result = await extractPdfImages(page, { paintImageXObject: 1, paintInlineImageXObject: 2, paintImageXObjectRepeat: 3, paintInlineImageXObjectGroup: 4 }, 7);
  assert.equal(result.length, 5);
  assert.deepEqual(accesses, ["page:local", "common:g_shared", "page:local"]);
  assert.match(result[0]!, /Imagen 1 de la página 7/);
});

test("image decoding failures report the page instead of silently importing an incomplete book", async () => {
  const page = {
    getOperatorList: async () => ({ fnArray: [1], argsArray: [[{ width: 40, height: 40, kind: 2, data: new Uint8Array(0) }]] })
  } as unknown as PDFPageProxy;
  await assert.rejects(extractPdfImages(page, { paintInlineImageXObject: 1 }, 12), { statusCode: 422, message: /página 12.*incompleto/ });
});
