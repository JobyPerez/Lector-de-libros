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
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'THEME_MODE';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (theme_mode VARCHAR2(20 CHAR) DEFAULT 'system')]';
          END IF;
        END;
      `,
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USERS' AND column_name = 'THEME_PALETTE';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE users ADD (theme_palette VARCHAR2(30 CHAR) DEFAULT 'default')]';
          END IF;
        END;
      `
    ];

    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    await connection.execute(
      `
        UPDATE users
        SET theme_mode = COALESCE(theme_mode, 'system'),
            theme_palette = COALESCE(theme_palette, 'default')
      `,
      {},
      { autoCommit: true }
    );

    console.log("Migración de apariencia (theme_mode, theme_palette) completada con éxito.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar migración de apariencia:", error);
  process.exitCode = 1;
});
