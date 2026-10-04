import { readFile } from "node:fs/promises";
import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

const EXPECTED_COLUMNS = [
  "OPENCODE_API_KEY_ENCRYPTED",
  "GEMINI_API_KEY_ENCRYPTED",
  "OPENCODE_OCR_MODEL",
  "OPENCODE_SUMMARY_MODEL",
  "OPENCODE_OCR_VISIBLE_MODELS",
  "OPENCODE_SUMMARY_VISIBLE_MODELS",
  "SHARE_AWS",
  "SHARE_OPENCODE",
  "SHARE_GOOGLE",
  "SHARE_DEEPGRAM"
];

async function main(): Promise<void> {
  const sql = await readFile(new URL("../../sql/035_user_ai_settings.sql", import.meta.url), "utf8");
  await initializeConnectionPool();
  const connection = await getConnection();
  try {
    for (const statement of sql.split(/^\/\s*$/mu).map((part) => part.trim()).filter(Boolean)) {
      await connection.execute(statement);
    }
    const columns = await connection.execute(
      `
      SELECT column_name AS "name"
      FROM user_tab_columns WHERE table_name = 'USERS'
        AND column_name IN ('OPENCODE_API_KEY_ENCRYPTED','GEMINI_API_KEY_ENCRYPTED','OPENCODE_OCR_MODEL','OPENCODE_SUMMARY_MODEL','OPENCODE_OCR_VISIBLE_MODELS','OPENCODE_SUMMARY_VISIBLE_MODELS','SHARE_AWS','SHARE_OPENCODE','SHARE_GOOGLE','SHARE_DEEPGRAM')
    `
    );
    const found = new Set((columns.rows ?? []).map((row: { name: string }) => row.name));
    const missing = EXPECTED_COLUMNS.filter((name) => !found.has(name));
    if (missing.length > 0) {
      throw new Error(`Faltan columnas tras la migración SQL035: ${missing.join(", ")}`);
    }
    console.log("SQL035 verificado: 10 columnas de Configuración IA presentes en USERS.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error: unknown) => {
  console.error("Fallo de migración SQL035:", error instanceof Error ? error.message : "Error desconocido");
  process.exitCode = 1;
});
