import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    const sql = await readFile(new URL("../../sql/042_book_comments_and_annotation_order.sql", import.meta.url), "utf8");
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) {
      await connection.execute(statement);
    }
    const objects = await connection.execute(`
      SELECT object_name AS "name", status AS "status" FROM user_objects
      WHERE object_name IN ('USER_BOOK_COMMENTS', 'USER_ANNOTATION_ORDER', 'TRG_ANNOTATION_SHARES_COMMENT')
    `);
    if (objects.rows.length !== 3 || objects.rows.some((row: { status: string }) => row.status !== "VALID")) {
      throw new Error("Las tablas o el trigger de comentarios no se han creado correctamente.");
    }
    console.log("SQL042: comentarios trasladados y orden personal de notas preparado.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Fallo de migración SQL042:", error);
  process.exitCode = 1;
});
