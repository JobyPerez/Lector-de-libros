-- Personal reading date and shared publication year. Safe to run repeatedly.
DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count FROM user_tab_columns
  WHERE table_name = 'USER_BOOK_SETTINGS' AND column_name = 'READING_DATE';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_settings ADD (reading_date DATE)';
  END IF;

  SELECT COUNT(*) INTO column_count FROM user_tab_columns
  WHERE table_name = 'BOOKS' AND column_name = 'PUBLICATION_YEAR';
  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE books ADD (publication_year NUMBER(4) CONSTRAINT ck_books_publication_year CHECK (publication_year BETWEEN 1 AND 9999))';
  END IF;
END;
/
