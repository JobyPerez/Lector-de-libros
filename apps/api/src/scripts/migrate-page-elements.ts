import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main(): Promise<void> {
  const sql = await readFile(new URL("../../sql/034_page_elements.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) {
      await connection.execute(statement);
    }
    const columns = await connection.execute(`
      SELECT column_name AS "name", data_type AS "type", nullable AS "nullable", data_default AS "defaultValue",
        char_length AS "length", data_precision AS "precision", data_scale AS "scale"
      FROM user_tab_columns WHERE table_name = 'BOOK_PARAGRAPHS'
        AND column_name IN ('ELEMENT_ROLE', 'READ_ALOUD', 'GEOMETRY_JSON')
    `);
    const constraints = await connection.execute(`
      SELECT constraint_name AS "name", status AS "status", validated AS "validated"
      FROM user_constraints WHERE table_name = 'BOOK_PARAGRAPHS'
        AND constraint_name IN ('CK_BOOK_PARAGRAPHS_READ_ALOUD', 'CK_BOOK_PARAGRAPHS_GEOMETRY')
    `);
    if (columns.rows?.length !== 3 || constraints.rows?.length !== 2
      || constraints.rows.some((row: { status: string; validated: string }) => row.status !== "ENABLED" || row.validated !== "VALIDATED")) {
      throw new Error("La verificacion del esquema de elementos ha fallado.");
    }
    const byName = new Map<string, { type: string; nullable: string; defaultValue: string | null; length: number; precision: number; scale: number }>(
      columns.rows.map((row: any) => [row.name, row])
    );
    const role = byName.get("ELEMENT_ROLE")!;
    const read = byName.get("READ_ALOUD")!;
    const geometry = byName.get("GEOMETRY_JSON")!;
    if (role.type !== "VARCHAR2" || role.length !== 32 || role.nullable !== "N" || role.defaultValue?.trim() !== "'body'"
      || read.type !== "NUMBER" || read.precision !== 1 || read.scale !== 0 || read.nullable !== "N" || read.defaultValue?.trim() !== "1"
      || geometry.type !== "CLOB" || geometry.nullable !== "Y") {
      throw new Error("Las columnas existentes no cumplen el contrato SQL034.");
    }
    console.log("SQL034 verificado: 3 columnas y 2 constraints habilitados y validados. Sin cambios de texto, IDs ni anotaciones.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error: unknown) => {
  console.error("Fallo de migracion SQL034:", error instanceof Error ? error.message : "Error desconocido");
  process.exitCode = 1;
});
