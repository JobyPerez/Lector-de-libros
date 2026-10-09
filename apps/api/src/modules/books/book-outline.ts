import { load } from "cheerio";
import type { AnyNode } from "domhandler";

import { getConnection } from "../../config/database.js";
import { renderVisualDocument, visualPageDocumentSchema } from "./visual-document.js";

export type BookOutlineEntry = {
  beginsPageContent: boolean;
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
  const paragraphIdLookup = new Map<string, OutlineParagraphRecord>();
  for (const row of paragraphs) {
    const paragraph = {
      ...row,
      sequenceNumber: Number(row.sequenceNumber)
    };
    paragraphLookup.set(`${row.pageNumber}:${row.paragraphNumber}`, paragraph);
    paragraphIdLookup.set(`${row.pageNumber}:${row.paragraphId}`, paragraph);
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
    let hasPageContent = false;
    const visit = (node: AnyNode): void => {
      if (node.type === "text") {
        if (normalizeWhitespace(node.data)) hasPageContent = true;
        return;
      }
      if (node.type !== "tag") return;
      const element = document(node);
      const blockId = element.attr("data-visual-block-id") ?? element.attr("data-paragraph-id");
      const block = blockId ? paragraphIdLookup.get(`${row.pageNumber}:${blockId}`)
        : paragraphLookup.get(`${row.pageNumber}:${Number.parseInt(element.attr("data-paragraph-number") ?? "", 10)}`);
      if (block?.active === 0 || block?.active === false
        || ["data-active", "data-is-active"].some((attribute) => ["false", "0"].includes(element.attr(attribute)?.trim().toLowerCase() ?? ""))
        || [block?.elementRole, element.attr("data-element-role")].some((role) => ["header", "footer", "pageNumber"].includes(role ?? ""))
        || ["head", "script", "style", "template"].includes(node.tagName.toLowerCase())) return;

      if (/^h[1-6]$/u.test(node.tagName.toLowerCase())) {
        const composite = element.attr("data-composite-anchor-number") !== undefined;
        const title = normalizeWhitespace(composite ? element.attr("data-composite-title") ?? "" : element.text());
        const level = Number.parseInt(node.tagName.slice(1), 10);
        const paragraph = composite
          ? paragraphIdLookup.get(`${row.pageNumber}:${element.attr("data-composite-anchor-id")}`) : block;
        const includeInToc = composite ? element.attr("data-composite-include-in-toc") === "true" : paragraph?.includeInToc == null
          ? level <= 3
          : paragraph.includeInToc === 1 || paragraph.includeInToc === true;
        if (title && paragraph && paragraph.active !== 0 && paragraph.active !== false
          && !seenParagraphIds.has(paragraph.paragraphId) && includeInToc) {
          seenParagraphIds.add(paragraph.paragraphId);
          outline.push({
            beginsPageContent: !hasPageContent,
            chapterId: paragraph.paragraphId,
            isGenerated: true,
            level,
            pageNumber: row.pageNumber,
            paragraphNumber: paragraph.paragraphNumber,
            sequenceNumber: paragraph.sequenceNumber,
            title
          });
        }
      }
      // Visit heading wrappers before their atoms: a compound's own children are not preceding content.
      if ((node.tagName === "img" && normalizeWhitespace(element.attr("src") ?? ""))
        || node.tagName === "svg"
        || (node.tagName === "image" && normalizeWhitespace(element.attr("href") ?? element.attr("xlink:href") ?? ""))) hasPageContent = true;
      node.children.forEach(visit);
    };
    document.root().children().each((_, node) => visit(node));
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
