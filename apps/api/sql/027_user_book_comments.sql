-- 027_user_book_comments.sql
-- Adds user_comments column to user_book_settings table.

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'USER_COMMENTS';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD (user_comments CLOB)]';
  END IF;
END;
/

COMMIT;
