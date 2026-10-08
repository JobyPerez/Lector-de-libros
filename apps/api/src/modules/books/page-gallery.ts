import { z } from "zod";
import oracledb from "oracledb";
import type { getConnection } from "../../config/database.js";

type Connection = Awaited<ReturnType<typeof getConnection>>;
type GalleryRow = {
  pageId: string; position: number; pageLabel: string | null; pageType: string; ocrStatus: string;
  sourceFileId: string | null; sourceMimeType: string | null; sourceImageRotation: number | null;
  sourceType: "PDF" | "EPUB" | "IMAGES"; updatedAt: string; hasVisualDocument: number;
  previewText: string | null; paragraphCount: number;
};
export const pageOrderSchema = z.object({
  pageIds: z.array(z.string().uuid()).max(100000),
  expectedPageIds: z.array(z.string().uuid()).max(100000)
}).strict();

export function validatePageOrder(current: string[], expected: string[], requested: string[]): void {
  if (current.length !== expected.length || current.some((id, index) => id !== expected[index])) {
    throw Object.assign(new Error("Page order changed. Reload the gallery before saving."), { statusCode: 409, code: "PAGE_ORDER_CONFLICT" });
  }
  const currentIds = new Set(current);
  if (requested.length !== current.length || new Set(requested).size !== requested.length || requested.some((id) => !currentIds.has(id))) {
    throw Object.assign(new Error("pageIds must be a complete permutation of the current pages."), { statusCode: 400 });
  }
}

export async function resolveGalleryPage(connection: Connection, params: { bookId: string; pageNumber: number }, query: unknown): Promise<void> {
  const { pageId } = z.object({ pageId: z.string().uuid().optional() }).parse(query ?? {});
  if (!pageId) return;
  const result = await connection.execute(`SELECT page_number AS "pageNumber" FROM book_pages
    WHERE book_id = :bookId AND page_id = :pageId`, { bookId: params.bookId, pageId });
  const page = (result.rows as { pageNumber: number }[] | undefined)?.[0];
  if (!page) throw Object.assign(new Error("Page not found."), { statusCode: 404 });
  params.pageNumber = Number(page.pageNumber);
}

export async function listGalleryPages(connection: Connection, bookId: string, canEdit: boolean) {
  const result = await connection.execute(`SELECT p.page_id AS "pageId", p.page_number AS "position",
    p.page_label AS "pageLabel", p.page_type AS "pageType", p.ocr_status AS "ocrStatus",
    p.source_file_id AS "sourceFileId", f.mime_type AS "sourceMimeType",
    p.source_image_rotation AS "sourceImageRotation", b.source_type AS "sourceType",
    TO_CHAR(p.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF6') AS "updatedAt",
    CASE WHEN p.visual_document_json IS NOT NULL THEN 1 ELSE 0 END AS "hasVisualDocument",
    (SELECT DBMS_LOB.SUBSTR(bp.paragraph_text, 500, 1) FROM book_paragraphs bp
      WHERE bp.page_id = p.page_id AND bp.is_active = 1 ORDER BY bp.paragraph_number FETCH FIRST 1 ROWS ONLY) AS "previewText",
    (SELECT COUNT(*) FROM book_paragraphs bp WHERE bp.page_id = p.page_id) AS "paragraphCount"
    FROM book_pages p JOIN books b ON b.book_id = p.book_id
    LEFT JOIN book_files f ON f.file_id = p.source_file_id
    WHERE p.book_id = :bookId ORDER BY p.page_number`, { bookId });
  const pages = ((result.rows ?? []) as GalleryRow[]).map((row) => {
    const base = `/books/${bookId}/pages/${row.position}?pageId=${row.pageId}`;
    const image = row.sourceMimeType?.startsWith("image/") === true;
    return { pageId: row.pageId, position: Number(row.position), pageNumber: Number(row.position),
      pageLabel: row.pageLabel, pageType: row.pageType, updatedAt: row.updatedAt,
      ocrStatus: row.ocrStatus, paragraphCount: Number(row.paragraphCount),
      source: { type: row.sourceType, fileId: row.sourceFileId, mimeType: row.sourceMimeType, rotation: Number(row.sourceImageRotation ?? 0) },
      preview: { kind: image ? "IMAGE" : "CONTENT", text: row.previewText ?? "", contentUrl: base,
        imageUrl: image ? `/books/${bookId}/pages/${row.position}/image?pageId=${row.pageId}&thumbnail=true` : null },
      capabilities: { edit: canEdit, delete: canEdit, reorder: canEdit, ocr: canEdit && row.sourceType === "IMAGES" && image,
        visualEditor: Number(row.hasVisualDocument) === 1 } };
  });
  return { pages, pageIds: pages.map((page) => page.pageId), capabilities: { reorder: canEdit } };
}

export function remapPageLinks(content: string | null, mapping: Map<number, number>): string | null {
  if (!content) return content;
  // Replace only reader link targets, never arbitrary page numbers in the document.
  return content.replace(/(data-lector-page=["'])(\d+)(["'])/gu, (all, before, page, after) =>
    mapping.has(Number(page)) ? `${before}${mapping.get(Number(page))}${after}` : all)
    .replace(/(reader-page-)(\d+)(-paragraph-\d+)/gu, (all, before, page, after) =>
      mapping.has(Number(page)) ? `${before}${mapping.get(Number(page))}${after}` : all)
    .replace(/(\bhref=["']\?page=)(\d+)(?=[&"'])/gu, (all, before, page) =>
      mapping.has(Number(page)) ? `${before}${mapping.get(Number(page))}` : all);
}

export function remapVisualPageLinks(content: string | null, mapping: Map<number, number>): string | null {
  if (!content) return content;
  const visit = (value: unknown): unknown => {
    if (typeof value === "string") return remapPageLinks(value, mapping);
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
    return value;
  };
  return JSON.stringify(visit(JSON.parse(content)));
}

// Caller holds the book lock; no deletes/reinserts, so paragraph IDs and their FK consumers survive.
export async function reorderGalleryPages(connection: Connection, bookId: string, expected: string[], requested: string[]) {
  const result = await connection.execute(`SELECT page_id AS "pageId", page_number AS "pageNumber",
    html_content AS "htmlContent", edited_text AS "editedText", raw_text AS "rawText",
    source_html_content AS "sourceHtmlContent", visual_document_json AS "visualDocumentJson"
    FROM book_pages WHERE book_id = :bookId ORDER BY page_number`, { bookId });
  const pages = (result.rows ?? []) as Array<{ pageId: string; pageNumber: number; htmlContent: string | null;
    editedText: string | null; rawText: string | null; sourceHtmlContent: string | null; visualDocumentJson: string | null }>;
  validatePageOrder(pages.map((page) => page.pageId), expected, requested);
  if (expected.every((id, index) => id === requested[index])) return;
  const positions = new Map(requested.map((id, index) => [id, index + 1]));
  const mapping = new Map(pages.map((page) => [Number(page.pageNumber), positions.get(page.pageId)!]));
  const paragraphsResult = await connection.execute(`SELECT paragraph_id AS "paragraphId", page_id AS "pageId",
    page_number AS "pageNumber", paragraph_number AS "paragraphNumber", sequence_number AS "sequenceNumber", paragraph_text AS "paragraphText"
    FROM book_paragraphs WHERE book_id = :bookId ORDER BY paragraph_number`, { bookId });
  const paragraphs = (paragraphsResult.rows ?? []) as Array<{ paragraphId: string; pageId: string; pageNumber: number; paragraphNumber: number; sequenceNumber: number; paragraphText: string }>;
  const ordered = [...paragraphs].sort((a, b) => mapping.get(a.pageNumber)! - mapping.get(b.pageNumber)! || a.paragraphNumber - b.paragraphNumber);
  const sequenceMap = new Map(ordered.map((paragraph, index) => [Number(paragraph.sequenceNumber), index + 1]));
  const offset = Math.max(pages.reduce((max, page) => Math.max(max, Number(page.pageNumber)), 0),
    paragraphs.reduce((max, paragraph) => Math.max(max, Number(paragraph.sequenceNumber)), 0)) + requested.length + paragraphs.length + 1;
  for (const table of ["book_pages", "book_paragraphs", "book_files", "user_bookmarks", "user_highlights", "user_notes", "book_chapters"]) {
    await connection.execute(`UPDATE ${table} SET page_number = page_number + :offset WHERE book_id = :bookId`, { bookId, offset });
  }
  await connection.execute(`UPDATE book_paragraphs SET sequence_number = sequence_number + :offset WHERE book_id = :bookId`, { bookId, offset });
  await connection.execute(`UPDATE book_chapters SET sequence_number = sequence_number + :offset WHERE book_id = :bookId`, { bookId, offset });
  for (const table of ["user_bookmarks", "user_highlights", "user_notes"]) {
    await connection.execute(`UPDATE ${table} SET sequence_number = sequence_number + :offset WHERE book_id = :bookId`, { bookId, offset });
  }
  await connection.execute(`UPDATE user_book_progress SET current_page_number = current_page_number + :offset WHERE book_id = :bookId`, { bookId, offset });
  for (const page of pages) {
    const pageNumber = mapping.get(Number(page.pageNumber))!;
    const remapped = [page.htmlContent, page.editedText, page.rawText, page.sourceHtmlContent].map((text) => remapPageLinks(text, mapping));
    await connection.execute(`UPDATE book_pages SET page_number = :pageNumber, html_content = :htmlContent,
      edited_text = :editedText, raw_text = :rawText, source_html_content = :sourceHtmlContent,
      visual_document_json = :visualDocumentJson WHERE book_id = :bookId AND page_id = :pageId`, {
      bookId, pageId: page.pageId, pageNumber, htmlContent: { val: remapped[0], type: oracledb.CLOB },
      editedText: { val: remapped[1], type: oracledb.CLOB }, rawText: { val: remapped[2], type: oracledb.CLOB },
      sourceHtmlContent: { val: remapped[3], type: oracledb.CLOB }, visualDocumentJson: { val: remapVisualPageLinks(page.visualDocumentJson, mapping), type: oracledb.CLOB }
    });
    for (const table of ["book_files", "user_bookmarks", "user_highlights", "user_notes", "book_chapters"]) {
      await connection.execute(`UPDATE ${table} SET page_number = :pageNumber WHERE book_id = :bookId AND page_number = :temporaryPage`,
        { bookId, pageNumber, temporaryPage: Number(page.pageNumber) + offset });
    }
    await connection.execute(`UPDATE user_book_progress SET current_page_number = :pageNumber WHERE book_id = :bookId AND current_page_number = :temporaryPage`,
      { bookId, pageNumber, temporaryPage: Number(page.pageNumber) + offset });
  }
  for (const paragraph of ordered) {
    const pageNumber = mapping.get(Number(paragraph.pageNumber))!;
    const sequenceNumber = sequenceMap.get(Number(paragraph.sequenceNumber))!;
    await connection.execute(`UPDATE book_paragraphs SET page_number = :pageNumber, sequence_number = :sequenceNumber,
      paragraph_text = :paragraphText WHERE book_id = :bookId AND paragraph_id = :paragraphId`, {
      bookId, paragraphId: paragraph.paragraphId, pageNumber, sequenceNumber,
      paragraphText: { val: remapPageLinks(paragraph.paragraphText, mapping), type: oracledb.CLOB }
    });
  }
  for (const paragraph of paragraphs) {
    const sequenceNumber = sequenceMap.get(Number(paragraph.sequenceNumber))!;
    for (const table of ["book_chapters", "user_bookmarks", "user_highlights", "user_notes"]) {
      await connection.execute(`UPDATE ${table} SET sequence_number = :sequenceNumber WHERE book_id = :bookId AND sequence_number = :temporarySequence`,
        { bookId, sequenceNumber, temporarySequence: Number(paragraph.sequenceNumber) + offset });
    }
  }
  // Empty pages retain their page; paragraph-backed progress follows the original paragraph exactly.
  await connection.execute(`UPDATE user_book_progress progress SET current_sequence_number = COALESCE(
    (SELECT p.sequence_number FROM book_paragraphs p WHERE p.book_id = progress.book_id
      AND p.page_number = progress.current_page_number AND p.paragraph_number = progress.current_paragraph_number),
    (SELECT MIN(p.sequence_number) FROM book_paragraphs p WHERE p.book_id = progress.book_id AND p.page_number >= progress.current_page_number),
    GREATEST(1, :total)) WHERE progress.book_id = :bookId`, { bookId, total: paragraphs.length });
  await connection.execute(`UPDATE user_book_progress SET reading_percentage = CASE WHEN :total = 0 THEN 0
    ELSE LEAST(100, current_sequence_number / :total * 100) END WHERE book_id = :bookId`, { bookId, total: paragraphs.length });
  await connection.execute(`UPDATE user_book_section_summaries SET is_stale = 1 WHERE book_id = :bookId`, { bookId });
  // Historical AI responses remain available but no longer claim a contiguous section range.
  await connection.execute(`UPDATE user_book_ai_requests SET is_stale = 1 WHERE book_id = :bookId`, { bookId });
  await connection.execute(`UPDATE books SET updated_at = SYSTIMESTAMP WHERE book_id = :bookId`, { bookId });
}
