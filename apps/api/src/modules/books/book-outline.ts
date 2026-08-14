import { load } from "cheerio";

import { getConnection } from "../../config/database.js";

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
type OutlinePageRecord = { htmlContent: string | null; pageNumber: number };
type OutlineParagraphRecord = { paragraphId: string; pageNumber: number; paragraphNumber: number; sequenceNumber: number };

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
          html_content AS "htmlContent"
        FROM book_pages
        WHERE book_id = :bookId
          AND html_content IS NOT NULL
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
          sequence_number AS "sequenceNumber"
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
  const paragraphLookup = new Map<string, { paragraphId: string; sequenceNumber: number }>();
  for (const row of paragraphs) {
    paragraphLookup.set(`${row.pageNumber}:${row.paragraphNumber}`, {
      paragraphId: row.paragraphId,
      sequenceNumber: Number(row.sequenceNumber)
    });
  }

  const outline: BookOutlineEntry[] = [];
  const seenParagraphIds = new Set<string>();

  for (const row of pages) {
    if (!row.htmlContent) {
      continue;
    }

    const document = load(row.htmlContent);
    document("h1[data-paragraph-number], h2[data-paragraph-number], h3[data-paragraph-number]").each((_, node) => {
      const element = document(node);
      const title = normalizeWhitespace(element.text());
      const paragraphNumber = Number.parseInt(element.attr("data-paragraph-number") ?? "", 10);
      const level = Number.parseInt((node.tagName?.toLowerCase() ?? "h1").slice(1), 10);
      const paragraph = paragraphLookup.get(`${row.pageNumber}:${paragraphNumber}`);

      if (!title || !paragraph || !Number.isInteger(level) || seenParagraphIds.has(paragraph.paragraphId)) {
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
