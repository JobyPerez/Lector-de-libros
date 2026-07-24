DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'USER_BOOK_SECTION_SUMMARIES'
    AND column_name = 'MODEL_ID';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_section_summaries ADD (model_id VARCHAR2(255 CHAR))';
  END IF;
END;
/

DECLARE
  column_count NUMBER;
BEGIN
  SELECT COUNT(*) INTO column_count
  FROM user_tab_columns
  WHERE table_name = 'USER_BOOK_AI_REQUESTS'
    AND column_name = 'MODEL_ID';

  IF column_count = 0 THEN
    EXECUTE IMMEDIATE 'ALTER TABLE user_book_ai_requests ADD (model_id VARCHAR2(255 CHAR))';
  END IF;
END;
/

COMMIT;
