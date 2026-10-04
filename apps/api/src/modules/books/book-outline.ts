import { load } from "cheerio";

import { getConnection } from "../../config/database.js";
import { renderVisualDocument, visualPageDocumentSchema } from "./visual-document.js";

export type BookOutlineEntry = {
  chapterId: string;
  isGenerated: boolean;
  level: number;
  pageNumber: number;
  paragraphNumber: number;
  sequenceNumber: number;
  title: string;
};

export type BookOutlineSource = "GENERATED_HEADINGS" | "NONE";

export type ResolvedBookOutline = {
  outline: BookOutlineEntry[];
  source: BookOutlineSource;
};

type DatabaseConnection = Awaited<ReturnType<typeof getConnection>>;
type OutlinePageRecord = { htmlContent: string | null; pageNumber: number; visualDocumentJson?: string | null };
type OutlineParagraphRecord = {
  paragraphId: string;
  pageNumber: number;
  paragraphNumber: number;
  sequenceNumber: number;
  elementRole?: string;
  active?: number | boolean;
  includeInToc?: number | boolean | null;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export async function buildDerivedBookOutline(
  connection: DatabaseConnection,
  bookId: string
): Promise<BookOutlineEntry[]> {
  const [pageResult, paragraphResult] = await Promise.all([
    connection.execute(
      `
        SELECT
          page_number AS "pageNumber",
          html_content AS "htmlContent",
          visual_document_json AS "visualDocumentJson"
        FROM book_pages
        WHERE book_id = :bookId
          AND (html_content IS NOT NULL OR visual_document_json IS NOT NULL)
        ORDER BY page_number ASC
      `,
      { bookId }
    ),
    connection.execute(
      `
        SELECT
          paragraph_id AS "paragraphId",
          page_number AS "pageNumber",
          paragraph_number AS "paragraphNumber",
          sequence_number AS "sequenceNumber",
          element_role AS "elementRole",
          is_active AS "active",
          include_in_toc AS "includeInToc"
        FROM book_paragraphs
        WHERE book_id = :bookId
      `,
      { bookId }
    )
  ]);

  return buildOutlineFromTitles(
    (pageResult.rows ?? []) as OutlinePageRecord[],
    (paragraphResult.rows ?? []) as OutlineParagraphRecord[]
  );
}

export function buildOutlineFromTitles(
  pages: OutlinePageRecord[],
  paragraphs: OutlineParagraphRecord[]
): BookOutlineEntry[] {
  const paragraphLookup = new Map<string, OutlineParagraphRecord>();
  for (const row of paragraphs) {
    if (row.active === 0 || row.active === false) {
      continue;
    }
    paragraphLookup.set(`${row.pageNumber}:${row.paragraphNumber}`, {
      ...row,
      sequenceNumber: Number(row.sequenceNumber)
    });
  }

  const outline: BookOutlineEntry[] = [];
  const seenParagraphIds = new Set<string>();

  for (const row of pages) {
    const htmlContent = row.visualDocumentJson
      ? renderVisualDocument(visualPageDocumentSchema.parse(JSON.parse(row.visualDocumentJson))).htmlContent : row.htmlContent;
    if (!htmlContent) {
      continue;
    }

    const document = load(htmlContent);
    document("h1, h2, h3, h4, h5, h6").each((_, node) => {
      const element = document(node);
      const composite = element.attr("data-composite-anchor-number") !== undefined;
      const title = normalizeWhitespace(composite ? element.attr("data-composite-title") ?? "" : element.text());
      const paragraphNumber = Number.parseInt(element.attr(composite ? "data-composite-anchor-number" : "data-paragraph-number") ?? "", 10);
      const level = Number.parseInt((node.tagName?.toLowerCase() ?? "h1").slice(1), 10);
      const paragraph = paragraphLookup.get(`${row.pageNumber}:${paragraphNumber}`);

      if (!title || !paragraph || !Number.isInteger(level) || seenParagraphIds.has(paragraph.paragraphId)) {
        return;
      }
      if (composite ? element.attr("data-composite-anchor-id") !== paragraph.paragraphId
        : ["header", "footer", "pageNumber"].includes(paragraph.elementRole ?? "")) return;
      const includeInToc = composite ? element.attr("data-composite-include-in-toc") === "true" : paragraph.includeInToc == null
        ? level <= 3
        : paragraph.includeInToc === 1 || paragraph.includeInToc === true;
      if (!includeInToc) {
        return;
      }

      seenParagraphIds.add(paragraph.paragraphId);
      outline.push({
        chapterId: paragraph.paragraphId,
        isGenerated: true,
        level,
        pageNumber: row.pageNumber,
        paragraphNumber,
        sequenceNumber: paragraph.sequenceNumber,
        title
      });
    });
  }

  return outline.sort((left, right) => left.sequenceNumber - right.sequenceNumber);
}

export async function resolveBookOutline(connection: DatabaseConnection, bookId: string): Promise<BookOutlineEntry[]> {
  return buildDerivedBookOutline(connection, bookId);
}

export async function resolveBookOutlineWithSource(connection: DatabaseConnection, bookId: string): Promise<ResolvedBookOutline> {
  const outline = await buildDerivedBookOutline(connection, bookId);
  return {
    outline,
    source: outline.length > 0 ? "GENERATED_HEADINGS" : "NONE"
  };
}
