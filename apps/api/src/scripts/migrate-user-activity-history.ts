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
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_ACTIVITY_EVENTS' AND column_name = 'CHAPTER_TITLE';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD (chapter_title VARCHAR2(500 CHAR))]';
          END IF;
        END;
      `,
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_ACTIVITY_EVENTS' AND column_name = 'DURATION_SECONDS';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD (duration_seconds NUMBER(12) DEFAULT 0)]';
          END IF;
        END;
      `,
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_ACTIVITY_EVENTS' AND column_name = 'SESSION_ID';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD (session_id VARCHAR2(36 CHAR))]';
          END IF;
        END;
      `,
      `
        DECLARE
          constraint_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO constraint_count FROM user_constraints WHERE table_name = 'USER_ACTIVITY_EVENTS' AND constraint_name = 'CK_USER_ACTIVITY_ACTION';
          IF constraint_count > 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events DROP CONSTRAINT ck_user_activity_action]';
          END IF;
          EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD CONSTRAINT ck_user_activity_action CHECK (action IN ('LOGIN', 'BOOK_VIEWED', 'BOOK_CREATED', 'BOOK_IMPORTED', 'BOOK_UPDATED', 'BOOK_DELETED', 'AUDIO_LISTENED'))]';
        END;
      `
    ];

    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    console.log("Migración de user_activity_events (chapter_title, duration_seconds, session_id, action constraint) completada con éxito.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar migración de user_activity_events:", error);
  process.exitCode = 1;
});
