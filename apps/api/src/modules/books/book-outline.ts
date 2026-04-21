import { randomUUID } from "node:crypto";

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

export type BookOutlineSource = "EPUB_TOC" | "GENERATED_HEADINGS" | "MANUAL" | "NONE";

type StoredBookOutlineSource = Extract<BookOutlineSource, "EPUB_TOC" | "MANUAL">;

export type ResolvedBookOutline = {
  outline: BookOutlineEntry[];
  source: BookOutlineSource;
};

function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function createGeneratedChapterSlug(title: string): string {
  const normalizedTitle = normalizeWhitespace(title)
    .normalize("NFD")
    .replace(/\p{Diacritic}+/gu, "")
    .toLowerCase();
  const slug = normalizedTitle.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || "section";
}

type DatabaseConnection = Awaited<ReturnType<typeof getConnection>>;

async function getStoredBookOutlineSource(connection: DatabaseConnection, bookId: string): Promise<StoredBookOutlineSource | null> {
  const result = await connection.execute(
    `
      SELECT outline_source AS "outlineSource"
      FROM books
      WHERE book_id = :bookId
    `,
    { bookId }
  );

  const [row] = (result.rows ?? []) as Array<{ outlineSource?: StoredBookOutlineSource | null }>;
  return row?.outlineSource ?? null;
}

export async function listStoredBookOutline(connection: DatabaseConnection, bookId: string): Promise<BookOutlineEntry[]> {
  const result = await connection.execute(
    `
      SELECT
        chapter_id AS "chapterId",
        heading_level AS "level",
        page_number AS "pageNumber",
        paragraph_number AS "paragraphNumber",
        sequence_number AS "sequenceNumber",
        title AS "title"
      FROM book_chapters
      WHERE book_id = :bookId
      ORDER BY sequence_number ASC
    `,
    { bookId }
  );

  return ((result.rows ?? []) as Array<Omit<BookOutlineEntry, "isGenerated">>).map((row) => ({
    ...row,
    isGenerated: false
  }));
}

export async function buildDerivedBookOutline(connection: DatabaseConnection, bookId: string): Promise<BookOutlineEntry[]> {
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
          page_number AS "pageNumber",
          paragraph_number AS "paragraphNumber",
          sequence_number AS "sequenceNumber"
        FROM book_paragraphs
        WHERE book_id = :bookId
      `,
      { bookId }
    )
  ]);

  const paragraphLookup = new Map<string, number>();
  for (const row of (paragraphResult.rows ?? []) as Array<{ pageNumber: number; paragraphNumber: number; sequenceNumber: number }>) {
    paragraphLookup.set(`${row.pageNumber}:${row.paragraphNumber}`, Number(row.sequenceNumber));
  }

  const outline: BookOutlineEntry[] = [];
  const seenEntries = new Set<string>();
  const titleOccurrences = new Map<string, number>();

  for (const row of (pageResult.rows ?? []) as Array<{ htmlContent: string | null; pageNumber: number }>) {
    if (!row.htmlContent) {
      continue;
    }

    const document = load(row.htmlContent);
    document("h1[data-paragraph-number], h2[data-paragraph-number], h3[data-paragraph-number], h4[data-paragraph-number], h5[data-paragraph-number], h6[data-paragraph-number]").each((_, node) => {
      const element = document(node);
      const title = normalizeWhitespace(element.text());
      const paragraphNumber = Number.parseInt(element.attr("data-paragraph-number") ?? "", 10);
      const tagName = node.tagName?.toLowerCase() ?? "h1";
      const level = Number.parseInt(tagName.replace("h", ""), 10);

      if (!title || !Number.isInteger(paragraphNumber) || !Number.isInteger(level)) {
        return;
      }

      const entryKey = `${row.pageNumber}:${paragraphNumber}:${title}`;
      if (seenEntries.has(entryKey)) {
        return;
      }

      seenEntries.add(entryKey);
      const titleKey = createGeneratedChapterSlug(title);
      const titleOccurrence = (titleOccurrences.get(titleKey) ?? 0) + 1;
      titleOccurrences.set(titleKey, titleOccurrence);

      outline.push({
        chapterId: `generated:${titleKey}:${titleOccurrence}`,
        isGenerated: true,
        level,
        pageNumber: row.pageNumber,
        paragraphNumber,
        sequenceNumber: paragraphLookup.get(`${row.pageNumber}:${paragraphNumber}`) ?? outline.length + 1,
        title
      });
    });
  }

  return outline;
}

export async function resolveBookOutline(connection: DatabaseConnection, bookId: string): Promise<BookOutlineEntry[]> {
  const resolvedOutline = await resolveBookOutlineWithSource(connection, bookId);
  return resolvedOutline.outline;
}

export async function resolveBookOutlineWithSource(connection: DatabaseConnection, bookId: string): Promise<ResolvedBookOutline> {
  const storedOutline = await listStoredBookOutline(connection, bookId);
  if (storedOutline.length > 0) {
    return {
      outline: storedOutline,
      source: await getStoredBookOutlineSource(connection, bookId) ?? "MANUAL"
    };
  }

  const derivedOutline = await buildDerivedBookOutline(connection, bookId);
  return {
    outline: derivedOutline,
    source: derivedOutline.length > 0 ? "GENERATED_HEADINGS" : "NONE"
  };
}

export async function replaceBookOutline(
  connection: DatabaseConnection,
  bookId: string,
  entries: Array<Pick<BookOutlineEntry, "level" | "pageNumber" | "paragraphNumber" | "title">>,
  source: StoredBookOutlineSource = "MANUAL"
): Promise<void> {
  await connection.execute(
    `
      DELETE FROM book_chapters
      WHERE book_id = :bookId
    `,
    { bookId }
  );

  for (const [index, entry] of entries.entries()) {
    await connection.execute(
      `
        INSERT INTO book_chapters (
          chapter_id,
          book_id,
          title,
          heading_level,
          page_number,
          paragraph_number,
          sequence_number
        ) VALUES (
          :chapterId,
          :bookId,
          :title,
          :headingLevel,
          :pageNumber,
          :paragraphNumber,
          :sequenceNumber
        )
      `,
      {
        bookId,
        chapterId: randomUUID(),
        headingLevel: entry.level,
        pageNumber: entry.pageNumber,
        paragraphNumber: entry.paragraphNumber,
        sequenceNumber: index + 1,
        title: entry.title
      }
    );
  }

  await connection.execute(
    `
      UPDATE books
      SET outline_source = :outlineSource
      WHERE book_id = :bookId
    `,
    {
      bookId,
      outlineSource: entries.length > 0 ? source : null
    }
  );
}