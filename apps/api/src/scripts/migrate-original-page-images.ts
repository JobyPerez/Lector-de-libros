import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main(): Promise<void> {
  await initializeConnectionPool();
  const connection = await getConnection();

  try {
    const result = await connection.execute(`
      SELECT search_condition_vc AS "searchCondition"
      FROM user_constraints
      WHERE constraint_name = 'CK_BOOK_FILES_KIND' AND table_name = 'BOOK_FILES'
    `);
    const condition = (result.rows?.[0] as { searchCondition?: string } | undefined)?.searchCondition;
    const indexes = await connection.execute(`
      SELECT index_name AS "indexName" FROM user_indexes
      WHERE table_name = 'BOOK_FILES' AND uniqueness = 'UNIQUE'
      ORDER BY index_name
    `);
    console.log("Indices unicos existentes de BOOK_FILES:", indexes.rows);

    if (!condition?.toUpperCase().includes("'ORIGINAL_PAGE_IMAGE'")) {
      if (!condition) {
        throw new Error("No se encuentra CK_BOOK_FILES_KIND; no se modifica el esquema.");
      }
      // Add only the new kind, preserving every currently admitted value.
      const expanded = condition.replace(/\)\s*$/, ", 'ORIGINAL_PAGE_IMAGE')");
      if (expanded === condition || !/^\s*file_kind\s+IN\s*\(/i.test(condition)) {
        throw new Error("CK_BOOK_FILES_KIND tiene un formato inesperado; no se modifica el esquema.");
      }
      console.log("Ampliando CK_BOOK_FILES_KIND (Oracle confirma cada DDL automaticamente)...");
      await connection.execute("ALTER TABLE book_files DROP CONSTRAINT ck_book_files_kind");
      try {
        await connection.execute(`ALTER TABLE book_files ADD CONSTRAINT ck_book_files_kind CHECK (${expanded})`);
      } catch (error) {
        await connection.execute(`ALTER TABLE book_files ADD CONSTRAINT ck_book_files_kind CHECK (${condition})`);
        throw error;
      }
    }

    if (!indexes.rows?.some((row: { indexName: string }) => row.indexName === "UQ_BOOK_FILES_ORIGINAL_SOURCE")) {
      await connection.execute(`
        CREATE UNIQUE INDEX uq_book_files_original_source ON book_files (
          CASE WHEN file_kind = 'ORIGINAL_PAGE_IMAGE' THEN book_id END,
          CASE WHEN file_kind = 'ORIGINAL_PAGE_IMAGE' THEN file_name END
        )
      `);
    }

    const verification = await connection.execute(`
      SELECT search_condition_vc AS "searchCondition", status AS "status", validated AS "validated"
      FROM user_constraints WHERE constraint_name = 'CK_BOOK_FILES_KIND' AND table_name = 'BOOK_FILES'
    `);
    console.log("Constraint verificado:", verification.rows);
    console.log("Esquema preparado para ORIGINAL_PAGE_IMAGE. No se han modificado imagenes ni paginas.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al migrar snapshots originales:", error);
  process.exitCode = 1;
});
