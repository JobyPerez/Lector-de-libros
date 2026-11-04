import { readFile } from "node:fs/promises";

import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  const sql = await readFile(new URL("../../sql/038_book_reading_date_publication_year.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    await connection.execute(sql.replace(/\/\s*$/, ""));
    console.log("Migración de fecha de lectura y año de publicación completada.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al migrar las fechas de los libros:", error);
  process.exitCode = 1;
});
