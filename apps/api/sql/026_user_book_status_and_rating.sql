-- 026_user_book_status_and_rating.sql
-- Adds reading_status and rating columns to user_book_settings table.

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'READING_STATUS';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (reading_status VARCHAR2(20 CHAR) DEFAULT 'WANT_TO_READ' NOT NULL)]';
    EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD CONSTRAINT ck_user_book_reading_status CHECK (reading_status IN ('READING', 'WANT_TO_READ', 'READ', 'ABANDONED'))]';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'RATING';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (rating NUMBER(1))]';
    EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD CONSTRAINT ck_user_book_rating CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5))]';
  END IF;
END;
/

COMMIT;
