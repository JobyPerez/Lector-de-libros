import sharp from "sharp";
import type { PDFPageProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { Geometry } from "./page-elements.js";

type PdfImage = { width: number; height: number; kind: number; data: Uint8Array | Uint8ClampedArray };

async function referencedPdfImage(page: PDFPageProxy, argument: unknown): Promise<PdfImage> {
  if (typeof argument !== "string") throw new Error("Referencia de imagen no válida.");
  const objects = argument.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise<PdfImage>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Se agotó el tiempo de decodificación de una imagen.")), 30_000);
    try {
      objects.get(argument, (value: PdfImage) => { clearTimeout(timer); resolve(value); });
    } catch (error) { clearTimeout(timer); reject(error); }
  });
}

type Matrix = [number, number, number, number, number, number];
function multiply(a: Matrix, b: Matrix): Matrix {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}

export async function pdfImageGeometries(page: PDFPageProxy, ops: Record<string, number>): Promise<Map<number, Geometry>> {
  const list = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1 });
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const result = new Map<number, Geometry>();
  for (const [index, fn] of list.fnArray.entries()) {
    const args = list.argsArray[index] ?? [];
    if (fn === ops.save || fn === ops.paintFormXObjectBegin) {
      stack.push([...matrix]);
      if (fn === ops.paintFormXObjectBegin && args[0]) matrix = multiply(matrix, args[0]);
    } else if (fn === ops.restore || fn === ops.paintFormXObjectEnd) matrix = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform) matrix = multiply(matrix, args as Matrix);
    else if ([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageXObjectRepeat, ops.paintInlineImageXObjectGroup].includes(fn)) {
      let placements: Matrix[] = [matrix];
      if (fn === ops.paintImageXObjectRepeat) {
        placements = [];
        for (let position = 0; position < (args[3]?.length ?? 0); position += 2) placements.push(multiply(matrix, [args[1], 0, 0, args[2], args[3][position], args[3][position + 1]]));
      } else if (fn === ops.paintInlineImageXObjectGroup) placements = (args[1] ?? []).map((entry: { transform: Matrix }) => multiply(matrix, entry.transform));
      if (!placements.length) continue;
      const points = placements.flatMap((placement) => [[0, 0], [0, 1], [1, 0], [1, 1]].map(([x, y]) => viewport.convertToViewportPoint(placement[0] * x! + placement[2] * y! + placement[4], placement[1] * x! + placement[3] * y! + placement[5])));
      const left = Math.max(0, Math.min(1, Math.min(...points.map((p) => p[0]!)) / viewport.width));
      const top = Math.max(0, Math.min(1, Math.min(...points.map((p) => p[1]!)) / viewport.height));
      const right = Math.max(left, Math.min(1, Math.max(...points.map((p) => p[0]!)) / viewport.width));
      const bottom = Math.max(top, Math.min(1, Math.max(...points.map((p) => p[1]!)) / viewport.height));
      if (right > left && bottom > top) result.set(index, { bbox: { left, top, width: right - left, height: bottom - top } });
    }
  }
  return result;
}

/** Same ordinal/filtering as extraction, including null slots for images
 * outside the visible CropBox. Removing those slots shifts all later zones. */
export async function extractedPdfImageGeometries(page: PDFPageProxy, ops: Record<string, number>): Promise<(Geometry | null)[]> {
  const boxes = await pdfImageGeometries(page, ops);
  const list = await page.getOperatorList();
  const result: (Geometry | null)[] = [];
  for (const [index, fn] of list.fnArray.entries()) {
    const referenced = fn === ops.paintImageXObject || fn === ops.paintImageXObjectRepeat;
    const inline = fn === ops.paintInlineImageXObject || fn === ops.paintInlineImageXObjectGroup;
    if (!referenced && !inline) continue;
    const argument = list.argsArray[index]?.[0];
    const image = referenced ? await referencedPdfImage(page, argument) : argument as PdfImage;
    if (image?.width >= 30 && image.height >= 30) result.push(boxes.get(index) ?? null);
  }
  return result;
}

export async function encodePdfImage(image: PdfImage): Promise<Buffer> {
  const { width, height, kind, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 40_000_000) {
    throw new Error("Las dimensiones de una imagen del PDF no son válidas o superan los 40 megapíxeles.");
  }
  // PDF.js GRAYSCALE_1BPP is packed by row, not one byte per pixel.
  if (kind === 1) {
    const stride = Math.ceil(width / 8);
    if (!data || data.length < stride * height) throw new Error("Imagen monocroma incompleta.");
    const pixels = Buffer.alloc(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        pixels[y * width + x] = (data[y * stride + (x >> 3)]! & (128 >> (x & 7))) ? 255 : 0;
      }
    }
    return sharp(pixels, { raw: { width, height, channels: 1 } }).png().toBuffer();
  }
  const channels = kind === 2 ? 3 : kind === 3 ? 4 : undefined;
  if (!channels || !data || data.length < width * height * channels) throw new Error("Formato de imagen del PDF no válido o incompleto.");
  return sharp(Buffer.from(data.buffer, data.byteOffset, width * height * channels), {
    raw: { width, height, channels }
  }).png().toBuffer();
}

export async function extractPdfImages(page: PDFPageProxy, ops: Record<string, number>, pageNumber: number, onImage?: (index: number) => void): Promise<string[]> {
  try {
    const operators = await page.getOperatorList();
    const images: string[] = [];
    for (const [index, fn] of operators.fnArray.entries()) {
      const referenced = fn === ops.paintImageXObject || fn === ops.paintImageXObjectRepeat;
      const inline = fn === ops.paintInlineImageXObject || fn === ops.paintInlineImageXObjectGroup;
      if (!referenced && !inline) continue;
      const argument = operators.argsArray[index]?.[0];
      let image: PdfImage;
      if (referenced) {
        // get() is not a Promise: without its callback it throws if decoding is
        // still running. Awaiting that synchronous call used to lose images.
        image = await referencedPdfImage(page, argument);
      } else {
        // Inline operators contain image data directly, not an object ID.
        image = argument as PdfImage;
      }
      if (!image) throw new Error("No se pudo decodificar una imagen del PDF.");
      if (image.width < 30 || image.height < 30) continue;
      const png = await encodePdfImage(image);
      onImage?.(index);
      images.push(`![Imagen ${images.length + 1} de la página ${pageNumber}](data:image/png;base64,${png.toString("base64")})`);
    }
    return images;
  } catch (error) {
    throw Object.assign(new Error(`No se pudieron importar las imágenes de la página ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`), { statusCode: 422 });
  }
}
