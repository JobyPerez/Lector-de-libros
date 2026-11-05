import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  const sql = await readFile(new URL("../../sql/039_pdf_page_sources.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) await connection.execute(statement);
    const columns = await connection.execute(`SELECT data_type AS "type", nullable AS "nullable" FROM user_tab_columns
      WHERE table_name = 'BOOK_PAGES' AND column_name = 'SOURCE_PDF_PAGE_NUMBER'`);
    const constraints = await connection.execute(`SELECT status AS "status", validated AS "validated" FROM user_constraints WHERE constraint_name = 'CK_PAGES_PDF_NUMBER'`);
    if (columns.rows?.length !== 1 || columns.rows[0].type !== "NUMBER" || columns.rows[0].nullable !== "Y"
      || constraints.rows?.length !== 1 || constraints.rows[0].status !== "ENABLED" || constraints.rows[0].validated !== "VALIDATED") throw new Error("No se ha aplicado SQL039.");
    console.log("SQL039 aplicado: identidad física PDF añadida sin modificar contenido existente.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
