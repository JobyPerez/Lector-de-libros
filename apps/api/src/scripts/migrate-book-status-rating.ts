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
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'READING_STATUS';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (reading_status VARCHAR2(20 CHAR) DEFAULT 'WANT_TO_READ' NOT NULL)]';
            EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD CONSTRAINT ck_user_book_reading_status CHECK (reading_status IN ('READING', 'WANT_TO_READ', 'READ', 'ABANDONED'))]';
          END IF;
        END;
      `,
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'RATING';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (rating NUMBER(1))]';
            EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD CONSTRAINT ck_user_book_rating CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))]';
          END IF;
        END;
      `
    ];

    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    console.log("Migración de estado de lectura y calificación (reading_status, rating) completada con éxito.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar migración de estado de lectura y calificación:", error);
  process.exitCode = 1;
});
