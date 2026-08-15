import { closeConnectionPool, getConnection, initializeConnectionPool } from "../config/database.js";

async function main() {
  await initializeConnectionPool();
  const connection = await getConnection();

  try {
    const migrationStatements = [
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'USER_COMMENTS';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (user_comments CLOB)]';
          END IF;
        END;
      `
    ];

    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    console.log("Migración de comentarios sobre el libro (user_comments) completada con éxito.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar migración de comentarios:", error);
  process.exitCode = 1;
});
