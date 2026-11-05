import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { PdfDetectedBlock } from "./pdf-import.js";
import type { Geometry } from "./page-elements.js";

// PDF.js uses a fake worker on Node. Run it (including image decoding and
// rendering) in a real worker thread so large books cannot block API/auth/TTS.
let worker: Worker | undefined;
let loadedKey: string | undefined;
let nextId = 0;
let pending = 0;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const responses = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

function unavailable(message = "El procesador PDF está ocupado. Inténtalo de nuevo en unos segundos.") {
  return Object.assign(new Error(message), { statusCode: 503 });
}
function stopWorker(error: Error): void {
  const old = worker;
  worker = undefined; loadedKey = undefined;
  if (idleTimer) clearTimeout(idleTimer);
  for (const response of responses.values()) { clearTimeout(response.timer); response.reject(error); }
  responses.clear();
  void old?.terminate();
}
function processor(): Worker {
  if (worker) return worker;
  const compiled = new URL("./pdf-source-worker.js", import.meta.url);
  const instance = new Worker(existsSync(compiled) ? compiled : new URL("./pdf-source-worker.ts", import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 384 } });
  worker = instance;
  instance.on("message", (message: { id: number; result?: unknown; error?: { message: string; statusCode: number } }) => {
    const response = responses.get(message.id);
    if (!response) return;
    responses.delete(message.id); clearTimeout(response.timer);
    if (message.error) response.reject(Object.assign(new Error(message.error.message), { statusCode: message.error.statusCode }));
    else response.resolve(message.result);
    if (!responses.size) instance.unref();
  });
  instance.on("error", () => { if (worker === instance) stopWorker(unavailable("No se pudo iniciar el procesador PDF.")); });
  instance.on("exit", (code) => { if (worker === instance) stopWorker(unavailable(`El procesador PDF terminó inesperadamente (${code}).`)); });
  instance.unref();
  return instance;
}
function send<T>(request: Record<string, unknown>, data?: Uint8Array): Promise<T> {
  const instance = processor();
  const id = ++nextId;
  instance.ref();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => stopWorker(unavailable("El análisis PDF superó el tiempo máximo. El original sigue intacto; puedes volver a intentarlo.")), 120_000);
    responses.set(id, { resolve, reject, timer });
    try { instance.postMessage({ ...request, id, ...(data ? { data } : {}) }, data ? [data.buffer as ArrayBuffer] : []); }
    catch (error) { clearTimeout(timer); responses.delete(id); if (!responses.size) instance.unref(); reject(error); }
  });
}
function task<T>(key: string, load: () => Promise<Buffer>, request: Record<string, unknown>): Promise<T> {
  if (pending >= 6) return Promise.reject(unavailable());
  pending++;
  if (idleTimer) clearTimeout(idleTimer);
  const result = queue.then(async () => {
    if (loadedKey !== key || !worker) {
      loadedKey = undefined;
      const data = new Uint8Array(await load()); // Own copy: never detach caller's original PDF bytes.
      await send({ kind: "open", key }, data);
      loadedKey = key;
    }
    return send<T>({ ...request, key });
  });
  queue = result.catch(() => {});
  return result.finally(() => {
    pending--;
    if (!pending) {
      idleTimer = setTimeout(() => stopWorker(unavailable("El procesador PDF ha liberado su caché.")), 5 * 60_000);
      idleTimer.unref();
    }
  });
}
export async function renderSourcePdfPage(key: string, pageNumber: number, load: () => Promise<Buffer>): Promise<Buffer> {
  return Buffer.from(await task<Uint8Array>(key, load, { kind: "render", pageNumber }));
}
export function analyzeSourcePdfPage(key: string, pageNumber: number, load: () => Promise<Buffer>) {
  return task<{ number: number; blocks: PdfDetectedBlock[]; images: (Geometry | null)[] }>(key, load, { kind: "analyze", pageNumber });
}
export function resolveSourcePdfSheet(key: string, target: string, explicit: number | undefined, load: () => Promise<Buffer>) {
  return task<number>(key, load, { kind: "resolve", target, explicit });
}
