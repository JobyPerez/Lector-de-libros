import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    const sql = await readFile(new URL("../../sql/041_saved_reading_status.sql", import.meta.url), "utf8");
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) {
      await connection.execute(statement);
    }
    console.log("SQL041: estado Guardado añadido como predeterminado, sin modificar estados existentes.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Fallo de migración SQL041:", error);
  process.exitCode = 1;
});
