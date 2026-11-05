import type { PdfDetectedBlock } from "./pdf-import.js";
import { analyzeSourcePdfPage, renderSourcePdfPage, resolveSourcePdfSheet } from "./pdf-source.js";
import { normalizedPdfWords, pdfTextSimilarity } from "./pdf-text.js";
export { normalizedPdfWords, pdfTextSimilarity } from "./pdf-text.js";
import type { Geometry, ParagraphElementMetadata } from "./page-elements.js";

type Connection = { execute: (...args: any[]) => Promise<any> };
export type PdfPageSource = { fileId: string; checksum: string; sourcePageNumber: number | null; pageId: string; pageNumber: number; rawText: string | null };

export async function findPdfPageSource(connection: Connection, bookId: string, pageNumber: number, pageId?: string): Promise<PdfPageSource | null> {
  const result = await connection.execute(`SELECT f.file_id AS "fileId", f.checksum_sha256 AS "checksum",
      p.source_pdf_page_number AS "sourcePageNumber", p.page_id AS "pageId", p.page_number AS "pageNumber", p.raw_text AS "rawText"
    FROM book_pages p JOIN books b ON b.book_id = p.book_id AND b.source_type = 'PDF'
    JOIN book_files f ON f.book_id = p.book_id AND f.file_kind = 'ORIGINAL_PDF'
      AND (p.source_file_id IS NULL OR p.source_file_id = f.file_id)
    WHERE p.book_id = :bookId AND ((:pageId IS NOT NULL AND p.page_id = :pageId) OR (:pageId IS NULL AND p.page_number = :pageNumber))`,
  { bookId, pageId: pageId ?? null, pageNumber });
  return result.rows?.length === 1 ? result.rows[0] : null;
}

export async function readPdfSourceBlob(value: unknown, maximumBytes = 128 * 1024 * 1024): Promise<Buffer> {
  if (Buffer.isBuffer(value)) {
    if (value.length > maximumBytes) throw Object.assign(new Error("El PDF original supera el límite de memoria de la vista original."), { statusCode: 422 });
    return value;
  }
  if (!value || typeof value !== "object" || !(Symbol.asyncIterator in value)) throw Object.assign(new Error("No se encuentra el PDF original."), { statusCode: 404 });
  const blob = value as AsyncIterable<Uint8Array> & { pieceSize?: number; destroy?: () => void };
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    // Oracle BUFFER fetching materializes large LOBs on the API thread. Read
    // bounded pieces instead and explicitly yield between them for auth/health.
    blob.pieceSize = 1024 * 1024;
    for await (const chunk of blob) {
      bytes += chunk.length;
      if (bytes > maximumBytes) throw Object.assign(new Error("El PDF original supera el límite de memoria de la vista original."), { statusCode: 422 });
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return Buffer.concat(chunks, bytes);
  } finally { blob.destroy?.(); }
}

function loader(connection: Connection, bookId: string, source: PdfPageSource) {
  return async (): Promise<Buffer> => {
    const result = await connection.execute(`SELECT content_blob AS "buffer" FROM book_files
      WHERE book_id = :bookId AND file_id = :fileId AND file_kind = 'ORIGINAL_PDF'`,
    { bookId, fileId: source.fileId });
    return readPdfSourceBlob(result.rows?.[0]?.buffer);
  };
}
function key(bookId: string, source: PdfPageSource) { return `${bookId}:${source.fileId}:${source.checksum}`; }
export async function resolvePdfSheet(connection: Connection, bookId: string, source: PdfPageSource, explicit?: number): Promise<number> {
  if (source.sourcePageNumber && explicit && source.sourcePageNumber !== explicit) {
    throw Object.assign(new Error("La página ya tiene una vinculación física. No se puede cambiar al preparar los bloques."), { statusCode: 409 });
  }
  if (source.sourcePageNumber) return source.sourcePageNumber;
  // Old imports discarded sheets; gallery position is never a physical mapping.
  return resolveSourcePdfSheet(key(bookId, source), source.rawText ?? "", explicit, loader(connection, bookId, source));
}

export async function renderPdfPageSource(connection: Connection, bookId: string, source: PdfPageSource): Promise<Buffer> {
  const number = await resolvePdfSheet(connection, bookId, source);
  return renderSourcePdfPage(key(bookId, source), number, loader(connection, bookId, source));
}

export async function analyzePdfPageSource(connection: Connection, bookId: string, source: PdfPageSource, explicit?: number) {
  const number = await resolvePdfSheet(connection, bookId, source, explicit);
  return analyzeSourcePdfPage(key(bookId, source), number, loader(connection, bookId, source));
}

export function matchPdfBlock(text: string, blocks: PdfDetectedBlock[]): PdfDetectedBlock | null {
  const normalized = normalizedPdfWords(text).join(" ");
  if (!normalized) return null;
  const exact = blocks.filter((block) => normalizedPdfWords(block.text).join(" ") === normalized);
  if (exact.length === 1) return exact[0]!;
  if (new Set(normalizedPdfWords(text)).size < 5) return null;
  const ranked = blocks.map((block) => ({ block, score: pdfTextSimilarity(text, block.text) })).sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 0.75 || ranked[0].score - (ranked[1]?.score ?? 0) < 0.12) return null;
  return ranked[0].block;
}

export function inferPdfElement(previous: ParagraphElementMetadata, match: PdfDetectedBlock | null, preserveEditorial: boolean): ParagraphElementMetadata {
  if (!match || previous.geometry) return previous;
  const geometry: Geometry = match.geometry;
  if (preserveEditorial || previous.role !== "body" || previous.readAloud === false || previous.active === false || previous.includeInToc != null) {
    return { ...previous, geometry };
  }
  return { ...previous, geometry, role: match.role,
    readAloud: !["header", "footer", "pageNumber"].includes(match.role),
    includeInToc: match.role === "heading" ? true : previous.includeInToc };
}
