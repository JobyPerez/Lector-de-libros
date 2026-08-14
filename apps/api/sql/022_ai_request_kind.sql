DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'USER_BOOK_AI_REQUESTS'
    AND column_name = 'REQUEST_KIND';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_ai_requests ADD (request_kind VARCHAR2(20 CHAR) DEFAULT ''TEXT'' NOT NULL)';
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_ai_requests ADD CONSTRAINT ck_user_book_ai_requests_kind CHECK (request_kind IN (''TEXT'', ''DIAGRAM''))';
  END IF;
END;
/

COMMIT;
