import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main(): Promise<void> {
  const sql = await readFile(new URL("../../sql/SQL037_visual_page_editor.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    const summaryTables = await connection.execute(`SELECT table_name AS "name" FROM user_tab_columns
      WHERE column_name = 'SUMMARY_TEXT' AND table_name IN (
        SELECT table_name FROM user_tab_columns WHERE column_name = 'BOOK_ID'
      ) ORDER BY table_name`);
    // Dated BK_SUMMARIES tables are historical backups, not live summary consumers.
    if (summaryTables.rows?.some((row: { name: string }) => row.name !== "USER_BOOK_SECTION_SUMMARIES" && !/^BK_SUMMARIES_\d{8}$/u.test(row.name))) {
      throw new Error("Hay tablas de resumen adicionales: revisar su invalidacion antes de migrar.");
    }
    const snapshotSql = `SELECT
      (SELECT COUNT(*) FROM book_pages) AS "pages",
      (SELECT COUNT(*) FROM book_paragraphs) AS "paragraphs",
      (SELECT NVL(SUM(DBMS_LOB.GETLENGTH(paragraph_text)), 0) FROM book_paragraphs) AS "textLength",
      (SELECT COUNT(*) FROM user_notes) AS "notes",
      (SELECT COUNT(*) FROM user_highlights) AS "highlights",
      (SELECT COUNT(*) FROM user_bookmarks) AS "bookmarks",
      (SELECT COUNT(*) FROM user_book_ai_requests) AS "requests",
      (SELECT COUNT(*) FROM user_book_section_summaries) AS "summaries" FROM dual`;
    const before = await connection.execute(snapshotSql);
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) await connection.execute(statement);
    const columns = await connection.execute(`SELECT table_name AS "tableName", column_name AS "name",
      data_type AS "type", nullable AS "nullable", data_default AS "defaultValue",
      data_precision AS "precision", data_scale AS "scale" FROM user_tab_columns
       WHERE (table_name = 'BOOK_PAGES' AND column_name IN ('VISUAL_DOCUMENT_JSON', 'SOURCE_HTML_CONTENT'))
        OR (table_name = 'BOOK_PARAGRAPHS' AND column_name IN ('IS_ACTIVE', 'INCLUDE_IN_TOC', 'IMAGE_WIDTH_PCT'))
        OR (table_name IN ('USER_BOOK_AI_REQUESTS', 'USER_BOOK_SECTION_SUMMARIES') AND column_name = 'IS_STALE')`);
    const constraints = await connection.execute(`SELECT constraint_name AS "name", status AS "status", validated AS "validated"
      FROM user_constraints WHERE constraint_name IN ('CK_BOOK_PAGES_VISUAL_DOCUMENT', 'CK_BOOK_PARAGRAPHS_ACTIVE',
        'CK_BOOK_PARAGRAPHS_TOC', 'CK_BOOK_PARAGRAPHS_IMAGE_WIDTH', 'CK_BOOK_AI_REQUESTS_STALE', 'CK_BOOK_SECTION_SUMMARIES_STALE')`);
    if (columns.rows?.length !== 7 || constraints.rows?.length !== 6
      || constraints.rows.some((row: { status: string; validated: string }) => row.status !== "ENABLED" || row.validated !== "VALIDATED")) {
      throw new Error("La verificacion de columnas/constraints SQL037 ha fallado.");
    }
    for (const row of columns.rows as Array<{ name: string; type: string; nullable: string; defaultValue: string | null; precision: number | null; scale: number | null }>) {
      const flag = row.name === "IS_ACTIVE" || row.name === "IS_STALE";
      const expectedDefault = row.name === "IS_ACTIVE" ? "1" : "0";
      if (row.type !== (["VISUAL_DOCUMENT_JSON", "SOURCE_HTML_CONTENT"].includes(row.name) ? "CLOB" : "NUMBER") || row.nullable !== (flag ? "N" : "Y")
        || (flag && (row.precision !== 1 || row.scale !== 0 || row.defaultValue?.trim() !== expectedDefault))
        || (row.name === "INCLUDE_IN_TOC" && (row.precision !== 1 || row.scale !== 0 || row.defaultValue != null))
        || (row.name === "IMAGE_WIDTH_PCT" && (row.precision != null || row.defaultValue != null))) {
        throw new Error(`La columna ${row.name} no cumple el contrato SQL037.`);
      }
    }
    const after = await connection.execute(snapshotSql);
    if (JSON.stringify(before.rows) !== JSON.stringify(after.rows)) throw new Error("Los recuentos historicos cambiaron durante la migracion; revisar actividad concurrente.");
    console.log("SQL037 verificado: 7 columnas, 6 constraints habilitados/validados; recuentos y longitud del texto historico sin cambios.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error: unknown) => {
  console.error("Fallo de migracion SQL037:", error instanceof Error ? error.message : "Error desconocido");
  process.exitCode = 1;
});
