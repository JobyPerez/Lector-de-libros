import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    const sql = await readFile(new URL("../../sql/040_book_deletion_indexes.sql", import.meta.url), "utf8");
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) await connection.execute(statement);
    const missing = await connection.execute(`SELECT fk.table_name AS "tableName", fk.constraint_name AS "constraintName"
      FROM user_constraints fk JOIN user_constraints pk ON pk.constraint_name = fk.r_constraint_name
      JOIN user_cons_columns col ON col.constraint_name = fk.constraint_name AND col.position = 1
      WHERE fk.constraint_type = 'R' AND pk.table_name IN ('BOOKS','BOOK_PAGES','BOOK_PARAGRAPHS','BOOK_FILES','USER_BOOK_AI_REQUESTS')
      AND NOT EXISTS (SELECT 1 FROM user_ind_columns ic JOIN user_indexes i ON i.index_name = ic.index_name
        WHERE ic.table_name = fk.table_name AND ic.column_name = col.column_name AND ic.column_position = 1 AND i.status = 'VALID')`);
    if (missing.rows?.length) throw new Error(`Quedan relaciones de borrado sin índice: ${JSON.stringify(missing.rows)}`);
    console.log("SQL040 verificado: relaciones de borrado indexadas, sin modificar libros ni contenido.");
  } finally { await connection.close(); await closeConnectionPool(); }
}
main().catch((error) => { console.error("Fallo de migración SQL040:", error); process.exitCode = 1; });
