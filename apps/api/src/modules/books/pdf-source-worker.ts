import { parentPort } from "node:worker_threads";
import { createCanvas } from "@napi-rs/canvas";
import type { PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfAssetOptions } from "./pdf-options.js";
import { analyzePdfPage } from "./pdf-import.js";
import { extractedPdfImageGeometries } from "./pdf-images.js";
import { normalizedPdfWords, pdfTextSimilarity } from "./pdf-text.js";

let document: PDFDocumentProxy | undefined;
let loadedKey: string | undefined;
const previews = new Map<number, Buffer>();
type Request = { id: number; kind: "open" | "render" | "analyze" | "resolve"; key: string; data?: Uint8Array; pageNumber?: number; target?: string; explicit?: number };
function sheet(number: number | undefined): number {
  if (!document || !number || !Number.isInteger(number) || number < 1 || number > document.numPages) {
    throw Object.assign(new Error("La página física no existe en el PDF original."), { statusCode: 422 });
  }
  return number;
}
async function run(request: Request): Promise<unknown> {
  if (request.kind === "open") {
    if (loadedKey === request.key && document) return true;
    await document?.destroy();
    document = undefined; loadedKey = undefined; previews.clear();
    const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
    document = await pdf.getDocument({ data: request.data!, ...pdfAssetOptions }).promise;
    loadedKey = request.key;
    return true;
  }
  if (!document || loadedKey !== request.key) throw new Error("El PDF no está cargado en el procesador.");
  if (request.kind === "resolve") {
    if (request.explicit) return sheet(request.explicit);
    const target = request.target ?? "";
    const unknown = () => Object.assign(new Error("No se puede identificar con seguridad esta hoja. Indica su número físico en el PDF original al preparar los bloques."), { statusCode: 409 });
    if (new Set(normalizedPdfWords(target)).size < 12) throw unknown();
    let best = { number: 0, score: 0 }, runnerUp = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const score = pdfTextSimilarity(target, content.items.flatMap((item) => "str" in item ? [item.str] : []).join(" "));
      page.cleanup();
      if (score > best.score) { runnerUp = best.score; best = { number, score }; }
      else runnerUp = Math.max(runnerUp, score);
    }
    await document.cleanup();
    if (best.score < 0.7 || best.score - runnerUp < 0.12) throw unknown();
    return best.number;
  }
  const number = sheet(request.pageNumber);
  if (request.kind === "render" && previews.has(number)) return new Uint8Array(previews.get(number)!);
  const page = await document.getPage(number);
  try {
    if (request.kind === "analyze") {
      const blocks = await analyzePdfPage(page);
      const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
      return { number, blocks, images: await extractedPdfImageGeometries(page, pdf.OPS) };
    }
    const original = page.getViewport({ scale: 1 });
    const scale = Math.min(200 / 72, 4096 / original.width, 4096 / original.height, Math.sqrt(8_000_000 / (original.width * original.height)));
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
    try {
      await page.render({ canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport, background: "white" }).promise;
      const buffer = await canvas.encode("jpeg", 95);
      while (previews.size >= 8) previews.delete(previews.keys().next().value!);
      previews.set(number, buffer);
      return new Uint8Array(buffer);
    } finally { canvas.width = 1; canvas.height = 1; }
  } finally { page.cleanup(); await document.cleanup(); }
}
let queue = Promise.resolve();
parentPort!.on("message", (request: Request) => {
  queue = queue.then(async () => {
    try {
      const result = await run(request);
      if (result instanceof Uint8Array) parentPort!.postMessage({ id: request.id, result }, [result.buffer as ArrayBuffer]);
      else parentPort!.postMessage({ id: request.id, result });
    } catch (error) {
      parentPort!.postMessage({ id: request.id, error: { message: error instanceof Error ? error.message : "No se pudo procesar el PDF.", statusCode: (error as { statusCode?: number }).statusCode ?? 422 } });
    }
  });
});
