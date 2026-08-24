import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";
import { externalizeContentImages, type ContentImageAsset } from "../modules/books/content-images.js";
import { calculateParagraphReadingMetrics } from "../services/paragraph-metrics.js";

type PageRow = {
  bookId: string;
  editedText: string | null;
  htmlContent: string | null;
  pageId: string;
  pageNumber: number;
  rawText: string | null;
};

type ParagraphRow = {
  paragraphId: string;
  paragraphText: string;
};

async function ensureContentImageConstraint(connection: any): Promise<void> {
  const result = await connection.execute(
    `
      SELECT search_condition_vc AS "searchCondition"
      FROM user_constraints
      WHERE constraint_name = 'CK_BOOK_FILES_KIND'
        AND table_name = 'BOOK_FILES'
    `
  );
  const constraint = ((result.rows ?? [])[0] as { searchCondition?: string } | undefined)?.searchCondition ?? "";
  if (constraint.toUpperCase().includes("CONTENT_IMAGE")) {
    return;
  }

  console.log("Adaptando CK_BOOK_FILES_KIND antes de migrar contenido (Oracle confirma cada DDL automáticamente)...");
  if (constraint) {
    await connection.execute("ALTER TABLE book_files DROP CONSTRAINT ck_book_files_kind");
  }
  await connection.execute(`
    ALTER TABLE book_files ADD CONSTRAINT ck_book_files_kind
    CHECK (file_kind IN ('ORIGINAL_PDF', 'ORIGINAL_EPUB', 'PAGE_IMAGE', 'COVER_IMAGE', 'CONTENT_IMAGE', 'TTS_AUDIO'))
  `);
}

async function insertAssets(connection: any, page: PageRow, assets: readonly ContentImageAsset[]): Promise<void> {
  for (const asset of assets) {
    await connection.execute(
      `
        INSERT INTO book_files (
          file_id, book_id, file_kind, file_name, mime_type, page_number,
          byte_size, checksum_sha256, content_blob
        ) VALUES (
          :fileId, :bookId, 'CONTENT_IMAGE', :fileName, :mimeType, :pageNumber,
          :byteSize, :checksumSha256, :contentBlob
        )
      `,
      {
        bookId: page.bookId,
        byteSize: asset.buffer.length,
        checksumSha256: asset.checksum,
        contentBlob: asset.buffer,
        fileId: asset.assetId,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        pageNumber: page.pageNumber
      }
    );
  }
}

async function main(): Promise<void> {
  await initializeConnectionPool();
  const connection = await getConnection();
  const schemaOnly = process.argv.includes("--schema-only");
  let migratedPages = 0;
  let migratedAssets = 0;
  let migratedBytes = 0;

  try {
    await ensureContentImageConstraint(connection);
    if (schemaOnly) {
      console.log("Esquema preparado para CONTENT_IMAGE.");
      return;
    }

    const candidatesResult = await connection.execute(`
      SELECT
        bp.page_id AS "pageId"
      FROM book_pages bp
      WHERE DBMS_LOB.INSTR(LOWER(bp.html_content), 'data:image') > 0
         OR DBMS_LOB.INSTR(LOWER(bp.edited_text), 'data:image') > 0
         OR DBMS_LOB.INSTR(LOWER(bp.raw_text), 'data:image') > 0
         OR EXISTS (
           SELECT 1
           FROM book_paragraphs paragraph
           WHERE paragraph.page_id = bp.page_id
             AND DBMS_LOB.INSTR(LOWER(paragraph.paragraph_text), 'data:image') > 0
         )
      ORDER BY bp.book_id, bp.page_number
    `);
    const pageIds = (candidatesResult.rows ?? []) as Array<{ pageId: string }>;
    console.log(`Páginas pendientes detectadas: ${pageIds.length}.`);

    for (const [index, candidate] of pageIds.entries()) {
      try {
        const pageResult = await connection.execute(
          `
            SELECT
              page_id AS "pageId",
              book_id AS "bookId",
              page_number AS "pageNumber",
              html_content AS "htmlContent",
              edited_text AS "editedText",
              raw_text AS "rawText"
            FROM book_pages
            WHERE page_id = :pageId
          `,
          candidate
        );
        const paragraphsResult = await connection.execute(
          `
            SELECT
              paragraph_id AS "paragraphId",
              paragraph_text AS "paragraphText"
            FROM book_paragraphs
            WHERE page_id = :pageId
            ORDER BY paragraph_number
          `,
          candidate
        );
        const page = ((pageResult.rows ?? [])[0] as PageRow | undefined);
        if (!page) {
          continue;
        }
        const paragraphs = (paragraphsResult.rows ?? []) as ParagraphRow[];
        const externalized = externalizeContentImages([
          page.htmlContent ?? "",
          page.editedText ?? "",
          page.rawText ?? "",
          ...paragraphs.map((paragraph) => paragraph.paragraphText)
        ]);
        if (externalized.assets.length === 0) {
          console.log(`[${index + 1}/${pageIds.length}] Página ${page.bookId}/${page.pageNumber}: sin imágenes Base64 válidas compatibles.`);
          continue;
        }

        await insertAssets(connection, page, externalized.assets);
        await connection.execute(
          `
            UPDATE book_pages
            SET html_content = :htmlContent,
                edited_text = :editedText,
                raw_text = :rawText
            WHERE page_id = :pageId
          `,
          {
            editedText: page.editedText === null ? null : externalized.contents[1],
            htmlContent: page.htmlContent === null ? null : externalized.contents[0],
            pageId: page.pageId,
            rawText: page.rawText === null ? null : externalized.contents[2]
          }
        );
        for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
          const paragraphText = externalized.contents[paragraphIndex + 3] ?? paragraph.paragraphText;
          const metrics = calculateParagraphReadingMetrics(paragraphText);
          await connection.execute(
            `
              UPDATE book_paragraphs
              SET paragraph_text = :paragraphText,
                  word_count = :wordCount,
                  tts_character_count = :characterCount
              WHERE paragraph_id = :paragraphId
            `,
            {
              characterCount: metrics.characterCount,
              paragraphId: paragraph.paragraphId,
              paragraphText,
              wordCount: metrics.wordCount
            }
          );
        }
        await connection.commit();

        const pageBytes = externalized.assets.reduce((total, asset) => total + asset.buffer.length, 0);
        migratedPages += 1;
        migratedAssets += externalized.assets.length;
        migratedBytes += pageBytes;
        console.log(`[${index + 1}/${pageIds.length}] Página ${page.bookId}/${page.pageNumber}: ${externalized.assets.length} assets, ${pageBytes} bytes.`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    console.log(`Migración completada: ${migratedPages} páginas, ${migratedAssets} assets, ${migratedBytes} bytes.`);
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al migrar imágenes de contenido:", error);
  process.exitCode = 1;
});
