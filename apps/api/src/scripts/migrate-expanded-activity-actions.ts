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
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_ACTIVITY_EVENTS' AND column_name = 'PAGE_NUMBER';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD (page_number NUMBER(6))]';
          END IF;
        END;
      `,
      `
        DECLARE
          column_count NUMBER;
        BEGIN
          SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_ACTIVITY_EVENTS' AND column_name = 'DETAIL';
          IF column_count = 0 THEN
            EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events ADD (detail VARCHAR2(1000 CHAR))]';
          END IF;
        END;
      `,
      `
        BEGIN
          EXECUTE IMMEDIATE q'[ALTER TABLE user_activity_events MODIFY (action VARCHAR2(50 CHAR))]';
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
          EXECUTE IMMEDIATE q'[
            ALTER TABLE user_activity_events ADD CONSTRAINT ck_user_activity_action CHECK (
              action IN (
                'LOGIN',
                'LOGOUT',
                'PROFILE_UPDATED',
                'PASSWORD_RESET',
                'BOOK_VIEWED',
                'BOOK_CREATED',
                'BOOK_IMPORTED',
                'BOOK_UPDATED',
                'BOOK_DELETED',
                'BOOK_EXPORTED',
                'BOOK_STATUS_UPDATED',
                'BOOK_RATED',
                'BOOK_SHARED',
                'BOOK_UNSHARED',
                'BOOK_TRANSFERRED',
                'AUDIO_LISTENED',
                'OCR_UPDATED',
                'PAGE_OCR_RERUN',
                'PAGE_IMAGE_ROTATED',
                'PAGE_IMAGE_UPDATED',
                'PAGE_DELETED',
                'PAGES_IMPORTED',
                'BOOKMARK_CREATED',
                'BOOKMARK_DELETED',
                'NOTE_CREATED',
                'NOTE_UPDATED',
                'NOTE_DELETED',
                'HIGHLIGHT_CREATED',
                'HIGHLIGHT_DELETED',
                'AI_REQUEST_CREATED',
                'AI_REQUEST_DELETED',
                'CHAPTER_SUMMARY_GENERATED',
                'USER_CREATED',
                'USER_UPDATED',
                'USER_DELETED'
              )
            )
          ]';
        END;
      `
    ];

    for (const statement of migrationStatements) {
      await connection.execute(statement);
    }

    console.log("Migración ampliada de user_activity_events (page_number, detail, action size y constraints) completada con éxito.");
  } finally {
    await connection.close();
    await closeConnectionPool();
  }
}

main().catch((error) => {
  console.error("Error al ejecutar migración ampliada de user_activity_events:", error);
  process.exitCode = 1;
});
