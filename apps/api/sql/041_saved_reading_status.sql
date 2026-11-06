-- Add Guardado without changing the status of existing books.
DECLARE
  constraint_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO constraint_count FROM user_constraints
  WHERE table_name = 'USER_BOOK_SETTINGS' AND constraint_name = 'CK_USER_BOOK_READING_STATUS';
  IF constraint_count > 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_settings DROP CONSTRAINT ck_user_book_reading_status';
  END IF;
  EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings ADD CONSTRAINT ck_user_book_reading_status CHECK (reading_status IN ('SAVED', 'READING', 'WANT_TO_READ', 'READ', 'ABANDONED'))]';
  EXECUTE IMMEDIATE q'[ALTER TABLE user_book_settings MODIFY (reading_status DEFAULT 'SAVED')]';
END;
/
